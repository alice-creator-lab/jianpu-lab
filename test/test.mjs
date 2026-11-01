import { transcribe, synthMelody, toPlainText } from '../jianpu.js';

const q = (midi, beats) => ({ midi, beats });
const seq = (arr) => arr.map(([m, b]) => (m && m.rests ? { rest: true, beats: m.rests } : q(m, b)));

const CASES = {
  twinkle_C: {
    seq: seq([[60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
              [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2]]),
    expectKey: 'C',
    expectNums: ['1', '1', '5', '5', '6', '6', '5', '4', '4', '3', '3', '2', '2', '1'],
  },
  twinkle_G: {
    seq: seq([[67, 1], [67, 1], [74, 1], [74, 1], [76, 1], [76, 1], [74, 2],
              [72, 1], [72, 1], [71, 1], [71, 1], [69, 1], [69, 1], [67, 2]]),
    expectKey: 'G',
    expectNums: ['1', '1', '5', '5', '6', '6', '5', '4', '4', '3', '3', '2', '2', '1'],
  },
  happy_birthday: {
    seq: seq([
      [67, .5], [67, .5], [69, 1], [67, 1], [72, 1], [71, 2],
      [67, .5], [67, .5], [69, 1], [67, 1], [74, 1], [72, 2],
      [67, .5], [67, .5], [79, 1], [76, 1], [72, 1], [71, 1], [69, 1],
      [77, .5], [77, .5], [76, 1], [72, 1], [74, 1], [72, 2],
    ]),
    expectKey: 'C',
    expectNums: ['5', '5', '6', '5', '1', '7', '5', '5', '6', '5', '2', '1',
                 '5', '5', '5', '3', '1', '7', '6', '4', '4', '3', '1', '2', '1'],
  },
  frere_jacques: {
    seq: seq([
      [60, 1], [62, 1], [64, 1], [60, 1], [60, 1], [62, 1], [64, 1], [60, 1],
      [64, 1], [65, 1], [67, 2], [64, 1], [65, 1], [67, 2],
      [67, .5], [69, .5], [67, .5], [65, .5], [64, 1], [60, 1],
      [67, .5], [69, .5], [67, .5], [65, .5], [64, 1], [60, 1],
      [60, 1], [67, 1], [60, 2],
    ]),
    expectKey: 'C',
    expectNums: ['1', '2', '3', '1', '1', '2', '3', '1', '3', '4', '5', '3', '4', '5',
                 '5', '6', '5', '4', '3', '1', '5', '6', '5', '4', '3', '1', '1', '5', '1'],
  },

  twinkle_rest: {
    seq: seq([[60, 1], [60, 1], [67, 1], [67, 1], [{ rests: 1 }], [69, 1], [69, 1], [67, 2],
              [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2]]),
    expectKey: 'C',
    expectNums: ['1', '1', '5', '5', '6', '6', '5', '4', '4', '3', '3', '2', '2', '1'],
    expectRest: true,
  },
  twinkle_fast_timbre: {
    seq: seq([[60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
              [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2]]),
    expectKey: 'C',
    expectNums: ['1', '1', '5', '5', '6', '6', '5', '4', '4', '3', '3', '2', '2', '1'],
    bpm: 144, harmonics: [1, 0.75, 0.5, 0.35, 0.2], sampleRate: 48000,
  },
};

let pass = 0, fail = 0;
for (const [name, c] of Object.entries(CASES)) {
  const bpm = c.bpm ?? (name === 'frere_jacques' ? 120 : 100);
  const sr = c.sampleRate ?? 44100;
  const audio = synthMelody(c.seq, { bpm, sampleRate: sr, harmonics: c.harmonics });
  const t0 = Date.now();
  const r = transcribe(audio, sr, { bpm });
  const ms = Date.now() - t0;
  const nums = r.notes.map((n) => {
    const rel = n.midi - r.refMidi;
    const pc = ((rel % 12) + 12) % 12;
    return ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7'][pc];
  });
  const keyOk = r.key.name === c.expectKey;
  const numsOk = nums.length === c.expectNums.length && nums.every((v, i) => v === c.expectNums[i]);
  const restOk = c.expectRest ? r.items.some((i) => i.type === 'rest') : true;
  const ok = keyOk && numsOk && restOk;
  ok ? pass++ : fail++;
  console.log(`\n=== ${name} ${ok ? '✅ PASS' : '❌ FAIL'} (${ms}ms, ${r.notes.length} notes)`);
  console.log(`key: detect=${r.key.label} → 1=${r.key.name} (expect ${c.expectKey}) ${keyOk ? 'ok' : 'WRONG'}`);
  console.log(`bpm: ${Math.round(r.tempo.bpm)} (conf ${r.tempo.confidence.toFixed(2)})`);
  if (!restOk) console.log('rest: expected a rest in output — GOT NONE');
  if (!numsOk) console.log(`notes: got [${nums.join(' ')}]\n   expect [${c.expectNums.join(' ')}]`);
  console.log(toPlainText(r));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
