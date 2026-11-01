# 聽音成譜 · 音樂 → 簡譜

上傳一段單聲部旋律（或直接哼唱），自動偵測音高、定調、估拍速，排成簡譜。

純前端、無依賴、無後端。兩支檔案：`index.html` + `jianpu.js`。

## 用法

```bash
python3 -m http.server 8795     # 一定要經 http 開，file:// 會被 CORS 擋住模組
# 開 http://127.0.0.1:8795/
```

- `?demo=twinkle|birthday|frere` 自動跑內建示範（分享／截圖用）
- 麥克風錄音要用 `localhost` 或 https；用內網 IP 開就只可以「揀檔案」上傳

## 能力邊界（重要）

只可靠**單聲部**：哼唱、口哨、笛、小提琴、單音結他、主旋律獨奏。
有鼓、和弦、成隊樂隊的錄音會亂——那需要多聲部分離模型（Basic Pitch / Demucs 之類），不是本專案的範圍。

## 流程

1. **前處理** — 混成單聲道 → 兩級 biquad 低通 → 線性重採樣到 16 kHz
2. **音高追蹤** — YIN（累積均值正規化差分 + 拋物線內插），10 ms 一格，65–1600 Hz
3. **切音符** — 有聲島嶼 → 音高跳變切段（85 音分容差，容得下顫音）→
   能量谷判斷重新發音（連續同音 `1 1` 靠這個分開）→ 連音填充（收音衰減的空隙補回）
4. **定調** — Krumhansl–Kessler 調性輪廓相關；小調換算成關係大調記譜（簡譜慣例）
5. **估拍速** — 起音間距分群 → 倍數/分數候選 → 對齊評分 + 偏好 80–140 BPM
6. **量化排版** — 起音/拍值對齊 1/16 格 → 跨小節的音拆成「–」延音 → 產生簡譜格
7. **記譜** — 度數（含 ♯1 ♭3 ♯4 ♯5 ♭7）、八度點、底線（八分／十六分連桁）、附點、休止符 `0`

## 測試

```bash
node test/test.mjs      # 6 個個案：音高序列、調性、拍速、休止符
```

個案涵蓋 C/G 大調、快板不同音色、含休止符——全部用 `synthMelody()` 合成已知答案再反推。

## API

`jianpu.js` 是純函式庫，瀏覽器與 Node 共用：

```js
import { transcribe, relayout } from './jianpu.js';
const r = transcribe(samples /* Float32Array */, sampleRate, { beatsPerBar: 4 });
r.text;        // 純文字簡譜
r.measures;    // 排版結果（cell: num / octave / under / dashCount / dot / beats）
r.notes;       // 每粒音 start / end / midi / cents
relayout(r, { tonicPc: 7, beatsPerBar: 3, bpm: 90 });   // 換調／換拍／換速度，不用重新分析
```
