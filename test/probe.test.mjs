/**
 * probe 的行为测试。
 *
 * 重点：没登录态的时候要给出人话，而不是抛栈。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeProtocol } from '../src/probe.mjs';

delete process.env.DS_TOKEN;

test('没有 token：不抛异常，判决里写清楚是缺登录态', async () => {
  const lines = [];
  const report = await probeProtocol({ token: undefined, log: (s = '') => lines.push(s) });

  assert.equal(report.token.present, false);
  assert.equal(report.verdict.usable, false);
  assert.equal(report.verdict.reasons.length, 1);
  assert.match(report.verdict.reasons[0], /缺少登录态/);

  // 该跑的一步都没跑
  assert.equal(report.voices.attempted, false);
  assert.equal(report.ticket.attempted, false);
  assert.equal(report.ws.attempted, false);

  // 打印出来的东西里有明确的一句话
  const text = lines.join('\n');
  assert.match(text, /判决：用不了 —— 缺少登录态/);
  assert.match(text, /DS_TOKEN/);
  assert.match(text, /不会去读你的浏览器/);

  // 本地音色表照样打出来了
  assert.equal(report.localVoices.length, 4);
  assert.match(text, /mira/);
  assert.match(text, /贝壳/);
});

test('没有 token 时不会去碰网络（把 fetch 换成会炸的也没事）', async () => {
  const explodingFetch = async () => {
    throw new Error('不该被调用');
  };
  const report = await probeProtocol({ log: () => {}, fetchImpl: explodingFetch });
  assert.equal(report.verdict.usable, false);
  assert.match(report.verdict.reasons[0], /缺少登录态/);
});

test('token 无效（40003）：报告里是 auth 失败，仍然不抛', async () => {
  const badFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ code: 40003, msg: 'INVALID_TOKEN', data: null }),
  });

  const lines = [];
  const report = await probeProtocol({
    token: 'b'.repeat(64),
    fetchImpl: badFetch,
    log: (s = '') => lines.push(s),
  });

  assert.equal(report.token.present, true);
  assert.equal(report.token.looksValid, true);
  assert.equal(report.voices.ok, false);
  assert.equal(report.voices.kind, 'auth');
  assert.match(report.voices.error, /40003|INVALID_TOKEN/);
  assert.equal(report.ticket.ok, false);
  assert.equal(report.verdict.usable, false);
  assert.ok(report.verdict.reasons.some((r) => /音色接口不通/.test(r)));
  assert.ok(report.verdict.reasons.some((r) => /取不到票/.test(r)));
  // 票都没拿到，ws 那步应该被跳过
  assert.equal(report.ws.skipped, true);
  assert.match(report.ws.reason, /没拿到票/);
});

test('token 长度不对会留一条 note，但不拦', async () => {
  const badFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ code: 40003, msg: 'INVALID_TOKEN', data: null }),
  });
  const report = await probeProtocol({ token: 'short', fetchImpl: badFetch, log: () => {} });
  assert.ok(report.verdict.notes.some((n) => /64 字符/.test(n)));
});

test('--no-ws 时试连被跳过，理由写明白', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    let body;
    if (url.endsWith('/chat/tts/voices')) {
      body = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            voices: [
              {
                voice_id: 'mira',
                name_i18n: { zh: '贝壳', en: 'Mira' },
                description_i18n: { zh: '百变活泼' },
                gender: 'female',
                languages: ['zh', 'en'],
                demo_urls: { zh: 'https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3' },
                is_default: true,
              },
            ],
            default_voice_id: 'mira',
            current_voice_id: 'mira',
          },
        },
      };
    } else {
      body = { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { ticket: 'T-1', expires_in_secs: 600 } } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
    };
  };

  const lines = [];
  const report = await probeProtocol({
    token: 'c'.repeat(64),
    fetchImpl: fakeFetch,
    tryWs: false,
    log: (s = '') => lines.push(s),
  });

  assert.equal(report.voices.ok, true);
  assert.equal(report.voices.list.length, 1);
  assert.equal(report.voices.list[0].id, 'mira');
  assert.equal(report.voices.list[0].languages, 2);
  assert.equal(report.ticket.ok, true);
  assert.equal(report.ticket.expiresInSecs, 600);
  // 票的内容一个字符都不该进报告
  assert.equal(report.ticket.length, 3);
  assert.equal(JSON.stringify(report).includes('T-1'), false, '报告里不该出现票的明文');

  assert.equal(report.ws.skipped, true);
  assert.match(report.ws.reason, /--no-ws/);

  // 票和音色都通了，所以判决是「能用」，但会注明 ws 没验
  assert.equal(report.verdict.usable, true);
  const text = lines.join('\n');
  assert.match(text, /判决：这个账号可以用/);
  assert.match(text, /ws 那一步跳过了/);
  assert.equal(calls.length, 2);
});
