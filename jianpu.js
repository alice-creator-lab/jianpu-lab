/* ============================================================
   jianpu.js — 音樂波形 → 簡譜（純 JS，瀏覽器 / Node 共用）
   流程：降採樣 → YIN 音高追蹤 → 切音符 → 定調 → 估拍 → 量化 → 排版
   ============================================================ */

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* 簡譜音級：以自然大調為 1..7；黑鍵按慣用寫法（♯1 ♭3 ♯4 ♯5 ♭7） */
const DEGREE = ['1', '#1', '2', 'b3', '3', '4', '#4', '5', '#5', '6', 'b7', '7'];

/* Krumhansl–Kessler 調性輪廓 */
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SR = 16000;          // 內部分析取樣率
const WIN = 1024;          // YIN 視窗（64ms @16k）
const HOP = 160;           // 10ms
const FMIN = 65;           // C2
const FMAX = 1600;         // ~G6

/* ---------------- 小工具 ---------------- */

export function median(arr) {
  const n = arr.length;
  if (!n) return 0;
  const a = Float64Array.from(arr).sort();
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

export function midiToName(m) {
  const r = ((Math.round(m) % 12) + 12) % 12;
  return PC_NAMES[r] + (Math.floor(Math.round(m) / 12) - 1);
}

function biquadLP(x, sr, freq, Q = 0.707) {
  const w0 = (2 * Math.PI * freq) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = B0 * xi + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function resample(x, srIn, srOut) {
  if (srIn === srOut) return x;
  const ratio = srOut / srIn;
  const n = Math.floor(x.length * ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const i0 = t | 0;
    const f = t - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    y[i] = a + (b - a) * f;
  }
  return y;
}

function normalize(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
  if (peak < 1e-6) return x;
  const g = 0.9 / peak;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

/* ---------------- 1. YIN 音高追蹤 ---------------- */

export function pitchTrack(x, sr, opts = {}) {
  const win = opts.win ?? WIN;
  const hop = opts.hop ?? HOP;
  const fmin = opts.fmin ?? FMIN;
  const fmax = opts.fmax ?? FMAX;
  const threshold = opts.threshold ?? 0.15;
  const half = win >> 1;
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(half - 1, Math.ceil(sr / fmin));
  const nFrames = Math.max(0, Math.floor((x.length - win) / hop) + 1);

  const times = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);
  const clarity = new Float32Array(nFrames);

  let maxRms = 0;
  for (let i = 0; i < nFrames; i++) {
    const base = i * hop;
    let s = 0;
    for (let j = 0; j < win; j++) { const v = x[base + j]; s += v * v; }
    rms[i] = Math.sqrt(s / win);
    times[i] = (base + half) / sr;
    if (rms[i] > maxRms) maxRms = rms[i];
  }

  const rmsFloor = Math.max(0.004, maxRms * 0.03);
  const d = new Float32Array(tauMax + 2);
  const cm = new Float32Array(tauMax + 2);

  for (let i = 0; i < nFrames; i++) {
    if (rms[i] < rmsFloor) continue;            // 靜音幀直接跳過
    const base = i * hop;

    // 差分函數
    d[0] = 0;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < half; j++) {
        const diff = x[base + j] - x[base + j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }
    // 累積均值正規化差分
    let run = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }

    // 取第一個低於門檻的局部極小
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < threshold) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {                             // 退而求其次：全域最小
      let mv = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cm[tau] < mv) { mv = cm[tau]; best = tau; }
      }
      if (mv > 0.3) best = -1;
    }
    if (best < 0) continue;

    // 拋物線內插
    let tauI = best;
    if (best > tauMin && best < tauMax) {
      const a = cm[best - 1], b = cm[best], c = cm[best + 1];
      const den = 2 * (2 * b - a - c);
      if (Math.abs(den) > 1e-12) tauI = best + (c - a) / den;
    }
    const freq = sr / tauI;
    if (!isFinite(freq) || freq < fmin || freq > fmax) continue;
    f0[i] = freq;
    clarity[i] = 1 - Math.min(1, cm[best]);
  }

  return { times, f0, rms, clarity, hopSec: hop / sr, sr };
}

/* 中值平滑（只作用於有聲幀） */
function smoothMidi(midi, size = 5) {
  const n = midi.length;
  const out = new Float32Array(n);
  const half = size >> 1;
  for (let i = 0; i < n; i++) {
    if (midi[i] <= 0) continue;
    const buf = [];
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n && midi[j] > 0) buf.push(midi[j]);
    }
    out[i] = buf.length ? median(buf) : midi[i];
  }
  return out;
}

/* ---------------- 2. 切音符 ---------------- */

export function segmentNotes(track, opts = {}) {
  const tol = opts.tol ?? 0.85;                 // 半音容差（約 85 音分，容得下顫音）
  const changeFrames = opts.changeFrames ?? 3;
  const minDurSec = opts.minDurSec ?? 0.07;
  const mergeGapSec = opts.mergeGapSec ?? 0.07;
  const legatoFillSec = opts.legatoFillSec ?? 0.12;
  const dipRatio = opts.dipRatio ?? 0.42;        // 谷底相對峰值：低於此值視為真正換音

  const { times, f0, rms, hopSec } = track;
  const n = f0.length;
  const midi = new Float32Array(n);
  for (let i = 0; i < n; i++) midi[i] = f0[i] > 0 ? 69 + 12 * Math.log2(f0[i] / 440) : 0;
  const sm = smoothMidi(midi, 5);

  const idxOf = (t) => Math.max(0, Math.min(n - 1, Math.round((t - times[0]) / hopSec)));

  /* 量度某段時間內的能量谷有多深：回傳 谷內最大值 / 兩側峰值 */
  const dipDepth = (t0, t1) => {
    const a = idxOf(t0), b = idxOf(t1);
    let peakIn = 0, peakL = 0, peakR = 0;
    for (let i = a; i <= b; i++) if (rms[i] > peakIn) peakIn = rms[i];
    for (let i = Math.max(0, a - 12); i < a; i++) if (rms[i] > peakL) peakL = rms[i];
    for (let i = b + 1; i <= Math.min(n - 1, b + 12); i++) if (rms[i] > peakR) peakR = rms[i];
    const ref = Math.min(peakL || 1e-9, peakR || 1e-9);
    return ref > 1e-6 ? peakIn / ref : 1;
  };

  /* 收集有聲島嶼 */
  const islands = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (sm[i] > 0) {
      if (!cur) cur = { idx: [] };
      cur.idx.push(i);
    } else if (cur) { islands.push(cur); cur = null; }
  }
  if (cur) islands.push(cur);

  /* 島內按音高跳變切段 */
  const notes = [];
  const flush = (frames, from, to) => {
    if (to < from) return;
    const ms = [];
    for (let k = from; k <= to; k++) ms.push(sm[frames[k]]);
    const m = median(ms);
    const startSec = times[frames[from]] - hopSec / 2;
    const endSec = times[frames[to]] + hopSec / 2;
    if (endSec - startSec < minDurSec) return;
    const r = Math.round(m);
    notes.push({ start: startSec, end: endSec, dur: endSec - startSec, midi: r, cents: median(ms.map((v) => v - r)) * 100, exact: m, hard: false });
  };

  for (const isl of islands) {
    const frames = isl.idx;
    let start = 0;
    let vals = [sm[frames[0]]];
    let med = vals[0];
    let dev = 0;
    for (let k = 1; k < frames.length; k++) {
      const m = sm[frames[k]];
      if (Math.abs(m - med) <= tol) {
        vals.push(m);
        if (vals.length > 9) vals.shift();
        med = median(vals);
        dev = 0;
      } else {
        dev++;
        if (dev >= changeFrames) {
          flush(frames, start, k - dev);
          start = k - dev + 1;
          vals = [];
          for (let q = start; q <= k; q++) vals.push(sm[frames[q]]);
          med = median(vals);
          dev = 0;
        }
      }
    }
    flush(frames, start, frames.length - 1);
  }

  notes.sort((a, b) => a.start - b.start);

  /* 合併：同音高、幾乎貼住、而且中間沒有明顯能量谷（= 同一粒音的氣聲斷隙） */
  const merged = [];
  for (const nt of notes) {
    const last = merged[merged.length - 1];
    if (last && last.midi === nt.midi && nt.start - last.end < mergeGapSec &&
        dipDepth(last.end, Math.max(last.end, nt.start)) > dipRatio) {
      last.end = Math.max(last.end, nt.end);
      last.dur = last.end - last.start;
      last.exact = (last.exact + nt.exact) / 2;
    } else if (last && nt.start < last.end - 0.02 && last.midi === nt.midi) {
      last.end = Math.max(last.end, nt.end);
      last.dur = last.end - last.start;
    } else {
      merged.push({ ...nt });
    }
  }

  /* 連音填充：收音衰減造成的小空隙補回上一粒（但唔可以跨越真正的能量谷） */
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1].start - merged[i].end;
    if (gap > 0 && gap < legatoFillSec &&
        dipDepth(merged[i].end, merged[i + 1].start) > dipRatio) {
      merged[i].end = merged[i + 1].start;
      merged[i].dur = merged[i].end - merged[i].start;
    }
  }

  /* 能量谷切分：同一個音高島內若出現明顯凹谷，代表重新發音（1 1 / 5 5 之類） */
  const out = [];
  for (const nt of merged) {
    const a = idxOf(nt.start) + 1;
    const b = idxOf(nt.end) - 1;
    const span = b - a;
    if (span < 6) { out.push(nt); continue; }
    const local = [];
    for (let i = a; i <= b; i++) local.push(rms[i]);
    const peak = Math.max(...local);
    const cands = [];
    for (let i = a + 2; i <= b - 2; i++) {
      let L = 0, R = 0;
      for (let q = Math.max(0, i - 8); q < i; q++) if (rms[q] > L) L = rms[q];
      for (let q = i + 1; q <= Math.min(n - 1, i + 8); q++) if (rms[q] > R) R = rms[q];
      if (rms[i] < dipRatio * Math.min(L, R) && rms[i] <= rms[i - 1] && rms[i] <= rms[i + 1]) {
        cands.push({ i, v: rms[i] });
      }
    }
    cands.sort((x, y) => x.v - y.v);
    const minFrames = Math.max(2, Math.round(minDurSec / hopSec));
    const cuts = [];
    for (const c of cands) {
      if (cuts.every((p) => Math.abs(p - c.i) > 10) && (c.i - a) >= minFrames && (b - c.i) >= minFrames) cuts.push(c.i);
    }
    if (!cuts.length) { out.push(nt); continue; }
    cuts.sort((x, y) => x - y);
    const bounds = [a - 1, ...cuts, b + 1];
    for (let k = 0; k < bounds.length - 1; k++) {
      const s = k === 0 ? nt.start : times[bounds[k]];
      const e = k === bounds.length - 2 ? nt.end : times[bounds[k + 1]];
      const ms = [];
      for (let i = bounds[k]; i <= bounds[k + 1]; i++) if (sm[i] > 0) ms.push(sm[i]);
      if (!ms.length) continue;
      const m = median(ms);
      out.push({
        start: s, end: e, dur: e - s, midi: Math.round(m),
        cents: median(ms.map((v) => v - Math.round(m))) * 100, exact: m, hard: true,
      });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out.filter((x) => x.dur >= minDurSec * 0.6);
}

/* ---------------- 3. 定調 ---------------- */

export function detectKey(notes) {
  const hist = new Float64Array(12);
  for (const nt of notes) hist[((nt.midi % 12) + 12) % 12] += nt.dur;

  let best = { score: -2, tonic: 0, mode: 'major' };
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [['major', PROFILE_MAJOR], ['minor', PROFILE_MINOR]]) {
      const r = corr(hist, prof, t);
      if (r > best.score) best = { score: r, tonic: t, mode };
    }
  }
  // 小調以關係大調記譜（1 = 關係大調主音），符合簡譜慣例
  const tonicPc1 = best.mode === 'minor' ? (best.tonic + 3) % 12 : best.tonic;
  return {
    tonicPc: tonicPc1,
    mode: best.mode,
    originalTonic: best.tonic,
    score: best.score,
    name: PC_NAMES[tonicPc1],
    label: `${PC_NAMES[best.tonic]} ${best.mode === 'major' ? '大調' : '小調'}`,
  };
}

function corr(hist, prof, rot) {
  const n = 12;
  let mh = 0, mp = 0;
  for (let i = 0; i < n; i++) { mh += hist[i]; mp += prof[i]; }
  mh /= n; mp /= n;
  let num = 0, dh = 0, dp = 0;
  for (let i = 0; i < n; i++) {
    const h = hist[(i + rot) % 12] - mh;
    const p = prof[i] - mp;
    num += h * p; dh += h * h; dp += p * p;
  }
  return dh > 0 && dp > 0 ? num / Math.sqrt(dh * dp) : -2;
}

/* ---------------- 4. 估拍 ---------------- */

export function estimateTempo(notes) {
  const onsets = notes.map((n) => n.start);
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.08) iois.push(d);
  }
  if (iois.length < 3) return { bpm: 100, confidence: 0 };

  const sorted = [...iois].sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.mean <= 0.035) {
      last.vals.push(v);
      last.mean = last.vals.reduce((a, b) => a + b, 0) / last.vals.length;
    } else clusters.push({ vals: [v], mean: v });
  }

  const cands = new Set();
  for (const c of clusters) {
    for (const k of [1, 2, 3, 4, 0.5, 1 / 3, 1.5]) {
      const bpm = (60 / (c.mean * k));
      if (bpm >= 50 && bpm <= 200) cands.add(Math.round(bpm * 10) / 10);
    }
  }
  let best = null;
  for (const bpm of cands) {
    const P = 60 / bpm;
    let score = 0;
    for (const dd of iois) {
      const k = Math.round(dd / P);
      if (k < 1) continue;
      const err = Math.abs(dd - k * P) / P;
      if (err < 0.15) score += (1 - err) / Math.sqrt(k);
    }
    const lw = Math.log2(bpm / 105);
    score *= Math.exp(-0.5 * (lw / 0.85) ** 2);   // 偏好 80–140 BPM
    if (!best || score > best.score) best = { bpm, score };
  }
  const bpm = best ? best.bpm : 100;
  return { bpm, confidence: best ? best.score / Math.max(1, iois.length) : 0 };
}

/* ---------------- 5. 量化 + 排版 ---------------- */

export function quantize(notes, { bpm, gridBeats = 0.25 } = {}) {
  const beatSec = 60 / bpm;
  const gridSec = beatSec * gridBeats;
  const t0 = notes[0].start;
  const items = [];
  let cursorQ = 0;

  for (const nt of notes) {
    let onQ = Math.round((nt.start - t0) / gridSec);
    let offQ = Math.round((nt.end - t0) / gridSec);
    if (onQ < cursorQ) onQ = cursorQ;
    if (offQ <= onQ) offQ = onQ + 1;
    if (onQ > cursorQ) items.push({ type: 'rest', startQ: cursorQ, lenQ: onQ - cursorQ });
    items.push({ type: 'note', startQ: onQ, lenQ: offQ - onQ, midi: nt.midi });
    cursorQ = offQ;
  }
  return { items, gridSec, beatSec };
}

export function layout(items, { beatsPerBar = 4, gridBeats = 0.25, tonicPc = 0, refMidi = null } = {}) {
  const gridPerBar = Math.max(1, Math.round(beatsPerBar / gridBeats));
  const measures = [];
  let cur = [];
  let posQ = 0;
  const push = () => { if (cur.length) { measures.push({ cells: cur }); cur = []; } };

  for (const it of items) {
    let remaining = it.lenQ;
    let first = true;
    while (remaining > 0) {
      const barEnd = (Math.floor(posQ / gridPerBar) + 1) * gridPerBar;
      const take = Math.min(remaining, barEnd - posQ);
      const beats = take * gridBeats;
      const cell = first
        ? makeCell(it, beats, gridBeats, tonicPc, refMidi)
        : { kind: it.type === 'rest' ? 'rest' : 'hold', beats, under: beats < 1 ? (beats <= 0.25 ? 2 : 1) : 0, dashCount: Math.max(1, Math.floor(beats + 1e-9)) };
      cur.push(cell);
      posQ += take;
      remaining -= take;
      first = false;
      if (posQ % gridPerBar === 0) push();
    }
  }
  push();

  const barCount = measures.length;
  return { measures, gridPerBar, barCount };
}

function makeCell(it, beats, gridBeats, tonicPc, refMidi) {
  if (it.type === 'rest') {
    const r = { kind: 'rest', beats };
    applyRhythm(r, beats);
    return r;
  }
  const ref = refMidi ?? 60 + tonicPc;
  const rel = it.midi - ref;
  const oct = Math.floor(rel / 12);
  const pc = ((rel % 12) + 12) % 12;
  const cell = { kind: 'note', num: DEGREE[pc], octave: Math.max(-2, Math.min(2, oct)), beats, midi: it.midi };
  applyRhythm(cell, beats);
  return cell;
}

function applyRhythm(cell, beats) {
  const EPS = 1e-9;
  if (beats >= 1 - EPS) {
    const whole = Math.floor(beats + EPS);
    cell.dashCount = whole - 1;
    cell.under = 0;
    const frac = beats - whole;
    cell.dot = frac >= 0.49;
  } else if (beats >= 0.75 - EPS) {
    cell.under = 1;
    cell.dashCount = 0;
    cell.dot = true;
  } else if (beats >= 0.5 - EPS) {
    cell.under = 1;
    cell.dashCount = 0;
    cell.dot = false;
  } else {
    cell.under = 2;
    cell.dashCount = 0;
    cell.dot = false;
  }
}

/* 選一個令旋律多數落在無點區間的「1」 */
export function pickRefMidi(notes, tonicPc) {
  const med = median(notes.map((n) => n.midi));
  return tonicPc + 12 * Math.round((med - tonicPc) / 12);
}

/* ---------------- 6. 主流程 ---------------- */

export function transcribe(samples, sampleRate, opts = {}) {
  const x0 = normalize(samples);
  const cut = biquadLP(x0, sampleRate, Math.min(SR * 0.42, sampleRate * 0.45));
  const cut2 = biquadLP(cut, sampleRate, Math.min(SR * 0.42, sampleRate * 0.45));
  const x = SR === sampleRate ? cut2 : resample(cut2, sampleRate, SR);

  const track = pitchTrack(x, SR, opts);
  const notes = segmentNotes(track, opts);
  if (notes.length < 2) throw new Error('偵測唔到足夠音符（試下大聲啲、少啲背景聲）');

  const key = detectKey(notes);
  const tempo = opts.bpm ? { bpm: opts.bpm, confidence: 1 } : estimateTempo(notes);
  // 尾音衰減會令最後一粒音偏短，補一點點
  const tail = notes[notes.length - 1];
  tail.end += Math.min(0.05, (60 / tempo.bpm) * 0.12);
  tail.dur = tail.end - tail.start;
  const tonicPc = opts.tonicPc ?? key.tonicPc;
  const gridBeats = opts.gridBeats ?? 0.25;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const refMidi = pickRefMidi(notes, tonicPc);

  const { items } = quantize(notes, { bpm: tempo.bpm, gridBeats });
  const { measures, barCount } = layout(items, { beatsPerBar, gridBeats, tonicPc, refMidi });

  const result = {
    sampleRate: SR, track, notes, key: { ...key, tonicPc, name: PC_NAMES[tonicPc] },
    tempo: { bpm: tempo.bpm, confidence: tempo.confidence },
    gridBeats, beatsPerBar, tonicPc, refMidi, measures, barCount, items,
    durationSec: samples.length / sampleRate,
  };
  result.text = toPlainText(result);
  return result;
}

/* 換調 / 換拍號 / 換速度 時重排版，不用重新分析 */
export function relayout(result, patch = {}) {
  const beatsPerBar = patch.beatsPerBar ?? result.beatsPerBar;
  const gridBeats = patch.gridBeats ?? result.gridBeats;
  const tonicPc = patch.tonicPc ?? result.tonicPc;
  const bpm = patch.bpm ?? result.tempo.bpm;
  const refMidi = pickRefMidi(result.notes, tonicPc);
  const { items } = quantize(result.notes, { bpm, gridBeats });
  const { measures, barCount } = layout(items, { beatsPerBar, gridBeats, tonicPc, refMidi });
  const out = {
    ...result, beatsPerBar, gridBeats, tonicPc, barCount, measures, items, refMidi,
    tempo: { ...result.tempo, bpm },
    key: { ...result.key, tonicPc, name: PC_NAMES[tonicPc] },
  };
  out.text = toPlainText(out);
  return out;
}

/* ---------------- 7. 純文字輸出 ---------------- */

export function toPlainText(r) {
  const head = `1 = ${PC_NAMES[r.tonicPc]}  ${r.beatsPerBar}/4  ♩=${Math.round(r.tempo.bpm)}`;
  const lines = [head, ''];
  for (const m of r.measures) {
    const parts = m.cells.map((c) => {
      if (c.kind === 'hold') return Array(Math.max(1, c.dashCount)).fill('–').join(' ');
      if (c.kind === 'rest') return ['0', ...Array(Math.max(0, c.dashCount || 0)).fill('–')].join(' ');
      const dots = c.octave > 0 ? "'".repeat(c.octave) : c.octave < 0 ? ','.repeat(-c.octave) : '';
      const dash = Array(Math.max(0, c.dashCount || 0)).fill('–');
      return [c.num + dots, ...dash].join(' ');
    });
    lines.push(`| ${parts.join('  ')} |`);
  }
  return lines.join('\n');
}

/* ---------------- 8. 示範音源（測試 / demo 共用） ---------------- */

export function synthMelody(seq, opts = {}) {
  const bpm = opts.bpm ?? 100;
  const sr = opts.sampleRate ?? 44100;
  const beat = 60 / bpm;
  const total = seq.reduce((a, n) => a + n.beats, 0) * beat + 0.3;
  const out = new Float32Array(Math.ceil(total * sr));
  const gapSec = opts.gapSec ?? 0.03;          // 換音時的短空隙（真實演奏都有）
  let tPos = 0.05;

  seq.forEach((nt, index) => {
    if (nt.rest) { tPos += nt.beats * beat; return; }
    const f = 440 * Math.pow(2, (nt.midi - 69) / 12);
    const dur = nt.beats * beat - gapSec;        // 空隙係由音符長度內扣，令起音仍然落在拍點上
    const n0 = Math.floor(tPos * sr);
    const n1 = Math.min(out.length, Math.floor((tPos + dur) * sr));
    const harm = opts.harmonics ?? [1, 0.45, 0.22, 0.1];
    const vibDepth = opts.vibratoCents ?? 14;
    let phase = 0;                                  // 以「週期」累積，避免 FM 漂移
    for (let i = n0; i < n1; i++) {
      const t = (i - n0) / sr;
      const inst = t > 0.14
        ? 1 + (vibDepth / 1200) * Math.sin(2 * Math.PI * 5 * t)
        : 1;
      phase += (f * inst) / sr;
      // ADSR
      let env;
      const atk = 0.02, rel = 0.04;
      if (t < atk) env = t / atk;
      else if (t > dur - rel) env = Math.max(0, (dur - t) / rel);
      else env = 1;
      env *= 0.8 + 0.2 * Math.exp(-t * 6);
      let v = 0;
      for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * (h + 1) * phase);
      out[i] += v * env * 0.22;
    }
    tPos += nt.beats * beat;
  });
  // 加少少底噪，模擬真實錄音
  let seed = opts.seed ?? 12345;
  const noiseAmp = opts.noise ?? 0.004;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] += ((seed / 4294967296) * 2 - 1) * noiseAmp;
  }
  return out;
}
