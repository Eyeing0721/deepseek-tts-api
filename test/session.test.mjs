/**
 * 会话/消息制造 + say() 的离线测试。
 *
 * 用假 fetch + 假 WebSocket 把整条链路演一遍：
 *   建会话 -> 取 PoW challenge -> 解 -> 发 completion -> 拉 history -> 合成 -> 删会话
 * 不联网、不要 token，但请求体、请求头、清理动作这些都能断言到。
 *
 * 注意：这只证明"按我理解的协议，代码会发这样的请求"。服务端认不认是另一回事，
 * 那条只有拿真 token 才验得了（见 VERIFY.md）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRepeatPrompt,
  messageIdOf,
  messageText,
  pickMessage,
  putText,
  say,
} from '../src/session.mjs';
import { powPrefix } from '../src/pow.mjs';
import { deepseekHashHex } from '../src/deepseek-hash.mjs';
import { encodeAudioFrame } from '../src/frames.mjs';

delete process.env.DS_TOKEN;
const TOKEN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 假 WebSocket（给 synthesize 用） ----------------

function makeWs(scriptFor) {
  const instances = [];
  class FakeWS {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      this.binaryType = 'blob';
      instances.push(this);
      const idx = instances.length - 1;
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        Promise.resolve()
          .then(() => scriptFor(this, idx))
          .catch(() => {});
      });
    }
    send(d) { this.sent.push(d); return true; }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => { if (this.onclose) this.onclose({ code: 1000, reason: '', wasClean: true }); });
    }
    emitText(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    emitFrame(seq, payload) {
      const b = encodeAudioFrame(seq, payload);
      const copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      if (this.onmessage) this.onmessage({ data: copy });
    }
    acks() { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type !== undefined || m.event); }
  }
  return { FakeWS, instances };
}

/** 正常的合成脚本：ready -> 两帧 -> finish */
function okTtsScript(ws) {
  ws.emitText({ event: 'ready', audio_id: 'aud-1', format: 'pcm', voice_id: 'mira', trace_id: 'tr-1' });
  ws.emitFrame(0, new Uint8Array([0x11, 0x11]));
  ws.emitFrame(1, new Uint8Array([0x22, 0x22]));
  ws.emitText({ event: 'finish', code: 0, msg: 'success' });
}

// ---------------- 假 fetch ----------------

const POW_ANSWER = 3;

function makeServer({
  messagesFor = () => [],
  ttsFailsFirst = false,
  completionStatus = 200,
  historyDelay = 0,
} = {}) {
  const calls = [];
  let historyHits = 0;
  let wsRuns = 0;

  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const expireAt = 1789318365550;
  const salt = 'TESTSALT';
  const challengeValue = deepseekHashHex(powPrefix({ salt, expireAt }) + POW_ANSWER);

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
    const u = String(url);

    if (u.endsWith('/chat_session/create')) {
      return json({ code: 0, msg: '', data: { biz_code: 0, biz_data: { chat_session: { id: 'sess-1', title: '新对话' } } } });
    }
    if (u.endsWith('/chat/create_pow_challenge')) {
      return json({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: challengeValue,
              salt,
              difficulty: POW_ANSWER + 1,
              signature: 'the-signature',
              expire_at: expireAt,
              expire_after: 600,
            },
          },
        },
      });
    }
    if (u.endsWith('/chat/completion')) {
      if (completionStatus !== 200) {
        return { ok: false, status: completionStatus, headers: { get: () => 'text/plain' }, text: async () => 'nope' };
      }
      async function* sse() {
        yield new TextEncoder().encode('event: ready\ndata: {"x":1}\n\n');
        yield new TextEncoder().encode('event: delta\ndata: {"content":"hi"}\n\n');
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: sse(),
        text: async () => '',
      };
    }
    if (u.includes('/chat/history_messages')) {
      historyHits++;
      if (historyDelay) await sleep(historyDelay);
      return json({
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_data: { cache_control: 'REPLACE', chat_messages: messagesFor(historyHits) } },
      });
    }
    if (u.endsWith('/chat_session/delete')) {
      return json({ code: 0, msg: '', data: { biz_code: 0 } });
    }
    if (u.endsWith('/auth/ticket')) {
      return json({ code: 0, msg: '', data: { biz_code: 0, biz_data: { ticket: 'TICKET-1', expires_in_secs: 600 } } });
    }
    if (u.endsWith('/chat/tts/voice')) {
      return json({ code: 0, msg: '', data: { biz_code: 0 } });
    }
    throw new Error('假 fetch 不认识这个 URL: ' + u);
  };

  const wsFor = (script) => (ws) => { wsRuns++; script(ws, wsRuns); };
  return { fetchImpl, calls, wsFor, get historyHits() { return historyHits; }, get wsRuns() { return wsRuns; }, ttsFailsFirst };
}

const callsTo = (calls, suffix) => calls.filter((c) => c.url.endsWith(suffix));

// ---------------- 纯函数 ----------------

test('buildRepeatPrompt 里带上了原文，并且明确要求原样输出', () => {
  const p = buildRepeatPrompt('今天天气不错');
  assert.ok(p.includes('今天天气不错'));
  assert.match(p, /原样|一个字都不要改/);
  assert.ok(p.indexOf('今天天气不错') > 0, '原文要在提示语后面');
});

test('messageText 兼容 string / 对象 / 空', () => {
  assert.equal(messageText({ content: 'abc' }), 'abc');
  assert.equal(messageText({ text: 'abc' }), 'abc');
  assert.equal(messageText({ content: null }), '');
  assert.equal(messageText({}), '');
  assert.equal(messageText(null), '');
  assert.equal(messageText({ content: { a: 1 } }), '{"a":1}');
});

test('pickMessage 挑的是模型的回复，不是我们发进去的那条', () => {
  const msgs = [
    { message_id: 'm1', role: 1, content: '你好' },
    { message_id: 'm2', role: 2, content: '你好呀，有什么可以帮你的' },
  ];
  assert.equal(messageIdOf(pickMessage(msgs, { prompt: '你好' })), 'm2');
});

test('pickMessage 在回复还没长出来时不硬挑', () => {
  const msgs = [{ message_id: 'm1', role: 1, content: '你好' }];
  assert.equal(pickMessage(msgs, { prompt: '你好' }), null);
});

test('pickMessage 忽略没有 id 的条目', () => {
  const msgs = [{ content: '你好' }, { message_id: 'm1', content: '你好' }, { message_id: 'm2', content: '回复' }];
  assert.equal(messageIdOf(pickMessage(msgs, { prompt: '你好' })), 'm2');
});

test('pickMessage 取最后一条，因为回复是后落库的那个', () => {
  const msgs = [
    { message_id: 'm1', content: 'prompt' },
    { message_id: 'm2', content: '先出来一半' },
    { message_id: 'm3', content: '完整回复' },
  ];
  assert.equal(messageIdOf(pickMessage(msgs, { prompt: 'prompt' })), 'm3');
});

// ---------------- putText ----------------

test('putText：建会话 → 解 PoW → 发复述提示语 → 拿模型那条 message_id', async () => {
  const server = makeServer({
    messagesFor: () => [
      { message_id: 'u-1', role: 1, content: buildRepeatPrompt('要念的这句话'), parent_id: null },
      { message_id: 'a-1', role: 2, content: '要念的这句话', parent_id: 'u-1' },
    ],
  });
  const out = await putText({
    text: '要念的这句话',
    token: TOKEN,
    fetchImpl: server.fetchImpl,
    pollIntervalMs: 1,
    waitTimeoutMs: 3000,
  });

  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.messageId, 'a-1');
  assert.ok(out.prompt.includes('要念的这句话'), '发的是复述提示语');
  assert.ok(out.prompt.length > '要念的这句话'.length, '提示语比原文长');
  assert.equal(out.pow.answer, POW_ANSWER);
  assert.equal(out.content, '要念的这句话');

  // 顺序：建会话 -> 取 challenge -> 发 completion
  const urls = server.calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''));
  assert.deepEqual(
    urls.filter((u) => !u.includes('history_messages')),
    ['/api/v0/chat_session/create', '/api/v0/chat/create_pow_challenge', '/api/v0/chat/completion'],
  );

  // completion 的请求体
  const comp = callsTo(server.calls, '/chat/completion')[0];
  const body = JSON.parse(comp.body);
  assert.equal(body.chat_session_id, 'sess-1');
  assert.equal(body.prompt, buildRepeatPrompt('要念的这句话'));
  assert.equal(body.parent_message_id, null);
  assert.deepEqual(body.ref_file_ids, []);
  assert.equal(body.thinking_enabled, false);
  assert.equal(body.search_enabled, false);
  assert.equal(body.preempt, false);
  assert.deepEqual(Object.keys(body).sort(), [
    'action', 'chat_session_id', 'model_type', 'parent_message_id', 'preempt',
    'prompt', 'ref_file_ids', 'search_enabled', 'source', 'thinking_enabled',
  ]);

  // PoW 头
  const powHeaderName = Object.keys(comp.headers).find((k) => k.toLowerCase() === 'x-ds-pow-response');
  assert.ok(powHeaderName, '必须带 X-DS-PoW-Response');
  const decoded = JSON.parse(Buffer.from(comp.headers[powHeaderName], 'base64').toString('utf8'));
  assert.equal(decoded.answer, POW_ANSWER);
  assert.equal(decoded.target_path, '/api/v0/chat/completion');
  assert.equal(decoded.salt, 'TESTSALT');
  assert.equal(decoded.signature, 'the-signature');
  assert.equal(comp.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(comp.headers.accept, 'text/event-stream');
});

test('putText：等不到回复就报错，并把会话里实际有什么打出来', async () => {
  // 只有我们发进去的那条，模型还没回
  const server = makeServer({
    messagesFor: () => [{ message_id: 'u-1', role: 1, content: buildRepeatPrompt('要念的这句话') }],
  });
  await assert.rejects(
    putText({
      text: '要念的这句话',
      token: TOKEN,
      fetchImpl: server.fetchImpl,
      pollIntervalMs: 1,
      waitTimeoutMs: 60,
    }),
    (err) => {
      assert.equal(err.kind, 'transport');
      assert.match(err.message, /等到模型的回复/);
      assert.ok(Array.isArray(err.details.messages));
      return true;
    },
  );
});

test('putText：completion 返回非 2xx 要报错', async () => {
  const server = makeServer({ completionStatus: 403 });
  await assert.rejects(
    putText({ text: 'x', token: TOKEN, fetchImpl: server.fetchImpl, pollIntervalMs: 1, waitTimeoutMs: 200 }),
    /HTTP 403/,
  );
});

test('putText：参数不对走 usage 错', async () => {
  const server = makeServer();
  await assert.rejects(putText({ text: '', token: TOKEN, fetchImpl: server.fetchImpl }), (e) => e.kind === 'usage');
  await assert.rejects(putText({ text: '   ', token: TOKEN, fetchImpl: server.fetchImpl }), (e) => e.kind === 'usage');
});

// ---------------- say 全链路 ----------------

test('say：整条链路 + 念完把临时会话删掉', async () => {
  const server = makeServer({
    messagesFor: () => [
      { message_id: 'u-1', role: 1, content: buildRepeatPrompt('念我') },
      { message_id: 'a-1', role: 2, content: '念我' },
    ],
  });
  const { FakeWS, instances } = makeWs(okTtsScript);

  const result = await say({
    text: '念我',
    token: TOKEN,
    fetchImpl: server.fetchImpl,
    webSocketImpl: FakeWS,
    waitTimeoutMs: 3000,
  });

  assert.equal(result.scratch.sessionId, 'sess-1');
  assert.equal(result.scratch.messageId, 'a-1');
  assert.equal(result.scratch.kept, false);
  assert.equal(result.frameCount, 2);
  assert.deepEqual([...result.audio], [0x11, 0x11, 0x22, 0x22]);
  assert.equal(result.format, 'pcm');

  // ws 连的是那个临时会话，念的是模型那条
  assert.ok(instances[0].url.includes('chat_session_id=sess-1'));
  assert.ok(instances[0].url.includes('message_id=a-1'));

  // 最后把会话删了，而且只删一次
  const dels = callsTo(server.calls, '/chat_session/delete');
  assert.equal(dels.length, 1);
  assert.deepEqual(JSON.parse(dels[0].body), { chat_session_ids: ['sess-1'] });
});

test('say(--keep)：不删会话', async () => {
  const server = makeServer({
    messagesFor: () => [
      { message_id: 'u-1', role: 1, content: buildRepeatPrompt('念我') },
      { message_id: 'a-1', role: 2, content: '念我' },
    ],
  });
  const { FakeWS } = makeWs(okTtsScript);
  const result = await say({
    text: '念我',
    token: TOKEN,
    keepSession: true,
    fetchImpl: server.fetchImpl,
    webSocketImpl: FakeWS,
    waitTimeoutMs: 3000,
  });
  assert.equal(result.scratch.kept, true);
  assert.equal(callsTo(server.calls, '/chat_session/delete').length, 0);
});

test('say：合成被拒就直接抛，不重试', async () => {
  const server = makeServer({
    messagesFor: () => [
      { message_id: 'u-1', role: 1, content: buildRepeatPrompt('念我') },
      { message_id: 'a-1', role: 2, content: '念我' },
    ],
  });
  const { FakeWS, instances } = makeWs((ws) => {
    ws.emitText({ event: 'ready', audio_id: 'a', format: 'pcm', voice_id: 'mira' });
    ws.emitText({ event: 'finish', code: 6, msg: 'no content' });
  });
  await assert.rejects(
    say({ text: '念我', token: TOKEN, fetchImpl: server.fetchImpl, webSocketImpl: FakeWS, waitTimeoutMs: 3000 }),
    (err) => {
      assert.equal(err.code, 6);
      return true;
    },
  );
  assert.equal(instances.length, 1, '只连一次 ws，没有第二遍');
  // 失败也要清干净
  assert.equal(callsTo(server.calls, '/chat_session/delete').length, 1);
});

test('say：塞消息那步就失败时，会话照样被清掉', async () => {
  // 模型一直不回，putText 会超时
  const server = makeServer({
    messagesFor: () => [{ message_id: 'u-1', role: 1, content: buildRepeatPrompt('念我') }],
  });
  const { FakeWS } = makeWs(okTtsScript);
  await assert.rejects(
    say({
      text: '念我',
      token: TOKEN,
      fetchImpl: server.fetchImpl,
      webSocketImpl: FakeWS,
      waitTimeoutMs: 80,
    }),
  );
  assert.equal(callsTo(server.calls, '/chat_session/delete').length, 1);
});

test('say：没有 token 直接 auth 错，一个请求都不发', async () => {
  const server = makeServer();
  const { FakeWS } = makeWs(okTtsScript);
  await assert.rejects(
    say({ text: 'x', fetchImpl: server.fetchImpl, webSocketImpl: FakeWS }),
    (e) => e.kind === 'auth',
  );
  assert.equal(server.calls.length, 0);
});
