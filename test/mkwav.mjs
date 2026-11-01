
import { synthMelody } from '../jianpu.js';
import fs from 'fs';
const seq = [[60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],[65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2]].map(([midi,beats])=>({midi,beats}));
const sr = 44100;
const x = synthMelody(seq, { bpm: 100, sampleRate: sr });
const n = x.length;
const buf = Buffer.alloc(44 + n*2);
buf.write('RIFF',0); buf.writeUInt32LE(36+n*2,4); buf.write('WAVE',8);
buf.write('fmt ',12); buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20); buf.writeUInt16LE(1,22);
buf.writeUInt32LE(sr,24); buf.writeUInt32LE(sr*2,28); buf.writeUInt16LE(2,32); buf.writeUInt16LE(16,34);
buf.write('data',36); buf.writeUInt32LE(n*2,40);
for (let i=0;i<n;i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]*32767))), 44+i*2);
fs.writeFileSync('/home/admin/.hermes/profiles/friend/workspace/jianpu-lab/test/twinkle.wav', buf);
console.log('wrote', (44+n*2), 'bytes');
