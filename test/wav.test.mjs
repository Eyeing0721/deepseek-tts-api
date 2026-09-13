/**
 * WAV 头的字节级测试。
 *
 * 期望值不是「跑一遍看看输出啥」，是拿纸笔按布局算出来的：
 *   44 字节头 + 数据。RIFF 长度 = 36 + dataLength，byteRate = sampleRate*channels*bits/8，
 *   blockAlign = channels*bits/8。下面每个 hex 串都是这么算的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WAV_HEADER_BYTES, parseWavHeader, pcmToWav, wavHeader } from '../src/wav.mjs';
import { PCM } from '../src/constants.mjs';

const hex = (buf) => Buffer.from(buf).toString('hex');

test('44 字节头，8 字节数据：逐字节对上手工算的期望', () => {
  // 24kHz / 单声道 / 16bit，4 个采样 = 8 字节
  //   RIFF size = 36 + 8        = 44        = 0x0000002C -> 2C 00 00 00
  //   sampleRate= 24000         = 0x00005DC0 -> C0 5D 00 00
  //   byteRate  = 24000*1*2     = 48000     = 0x0000BB80 -> 80 BB 00 00
  //   blockAlign= 1*2           = 2         -> 02 00
  const expected =
    '52494646' + // "RIFF"
    '2c000000' + // RIFF 块长度 44
    '57415645' + // "WAVE"
    '666d7420' + // "fmt "
    '10000000' + // fmt 块长度 16
    '0100' + //     audioFormat = 1 (PCM)
    '0100' + //     channels = 1
    'c05d0000' + // sampleRate = 24000
    '80bb0000' + // byteRate = 48000
    '0200' + //     blockAlign = 2
    '1000' + //     bitsPerSample = 16
    '64617461' + // "data"
    '08000000'; //  dataLength = 8

  const wav = wavHeader({ dataLength: 8 });
  assert.equal(wav.length, WAV_HEADER_BYTES);
  assert.equal(hex(wav), expected);
});

test('sampleRate 字段确实是 24000（0x5DC0），别把 byteRate 抄进去', () => {
  const wav = wavHeader({ dataLength: 0 });
  assert.equal(wav.readUInt32LE(24), 24000); // sampleRate
  assert.equal(wav.readUInt32LE(28), 48000); // byteRate
  assert.equal(wav.readUInt16LE(32), 2); // blockAlign
  assert.equal(wav.readUInt16LE(34), 16); // bitsPerSample
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
});

test('实测那次 pcm 的字节数（124426）套出来 RIFF/data 长度对得上', () => {
  // 2026-09-12 实测：pcm 26 帧 / 124426 字节 / 2.59 秒
  //   dataLength = 124426 = 0x0001E60A -> 0A E6 01 00
  //   riffSize   = 124426+36 = 124462 = 0x0001E62E -> 2E E6 01 00
  const wav = wavHeader({ dataLength: 124426 });
  assert.equal(wav.readUInt32LE(40), 124426);
  assert.equal(wav.readUInt32LE(4), 124462);
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(hex(wav.subarray(40, 44)), '0ae60100');
  assert.equal(hex(wav.subarray(4, 8)), '2ee60100');
});

test('pcmToWav 把数据原样接在头后面，长度正好 44+n', () => {
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.ok(wav.subarray(0, 44).equals(wavHeader({ dataLength: 8 })));
  assert.ok(wav.subarray(44).equals(pcm));
});

test('parseWavHeader 读回自己写的东西，valid 自洽', () => {
  const pcm = Buffer.alloc(2400 * 2, 0x7f); // 2400 采样 = 0.1s
  const wav = pcmToWav(pcm);
  const h = parseWavHeader(wav);
  assert.equal(h.chunkId, 'RIFF');
  assert.equal(h.format, 'WAVE');
  assert.equal(h.subchunk1Id, 'fmt ');
  assert.equal(h.subchunk2Id, 'data');
  assert.equal(h.audioFormat, 1);
  assert.equal(h.channels, 1);
  assert.equal(h.sampleRate, 24000);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.dataLength, pcm.length);
  assert.equal(h.valid, true);
  assert.equal(h.dataLength / (h.bitsPerSample / 8) / h.channels / h.sampleRate, 0.1);
});

test('长度不是 blockAlign 整数倍就报错，不悄悄补齐', () => {
  assert.throws(() => pcmToWav(Buffer.alloc(9)), (err) => {
    assert.equal(err.name, 'DeepSeekTtsError');
    assert.equal(err.kind, 'usage');
    assert.match(err.message, /blockAlign/);
    return true;
  });
});

test('空 PCM 也能封出一个合法的空 WAV', () => {
  const wav = pcmToWav(Buffer.alloc(0));
  assert.equal(wav.length, 44);
  assert.equal(hex(wav.subarray(4, 8)), '24000000'); // 36 = 0x24
  const h = parseWavHeader(wav);
  assert.equal(h.dataLength, 0);
  assert.equal(h.valid, true);
});

test('立体声/别的采样率也算得对', () => {
  const wav = wavHeader({ dataLength: 480, sampleRate: 48000, channels: 2, bitsPerSample: 16 });
  assert.equal(wav.readUInt16LE(22), 2); // channels
  assert.equal(wav.readUInt32LE(24), 48000); // sampleRate
  assert.equal(wav.readUInt32LE(28), 48000 * 4); // byteRate
  assert.equal(wav.readUInt16LE(32), 4); // blockAlign
});

test('wavHeader 拒绝明显不合法的参数', () => {
  assert.throws(() => wavHeader({ dataLength: -1 }), /非负整数/);
  assert.throws(() => wavHeader({ dataLength: 0, sampleRate: 0 }), /不能是 0/);
  assert.throws(() => wavHeader({ dataLength: 0, bitsPerSample: 12 }), /8 的倍数/);
});

test('常量本身就是 24k 单声道 16bit —— 别改错了没人发现', () => {
  assert.equal(PCM.sampleRate, 24000);
  assert.equal(PCM.channels, 1);
  assert.equal(PCM.bitsPerSample, 16);
});
