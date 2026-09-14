/**
 * 诊断：这个账号到底能不能用。
 *
 * 跑一遍：本地音色表 -> （有票就）真实音色接口 -> 取一张 tts 票 -> 试连一次 ws。
 * 不抛异常（除了参数用错），失败也都变成报告里的一行，方便 CLI 原样打出来。
 *
 * 试连有两种：
 *   - 给了 --session / --message：真的合成一次，是最有说服力的判定。
 *   - 没给：拿空 id 连一次，只看握手成不成、第一个文本帧是什么。
 *     这不能证明「你能合成」，只能证明「票和端点是通的、账号没被挡在门外」。
 */

import { PCM, VOICES, WS_ENDPOINT } from './constants.mjs';
import { DeepSeekTtsError, codeHint, codeName } from './errors.mjs';
import { assertToken, issueTicket, listVoices, looksLikeToken, resolveToken } from './http.mjs';
import { redactUrl, synthesize } from './tts.mjs';

const noop = () => {};

/** 空 id 试连用：不走 buildTtsUrl（它会因为缺 id 直接抛）。 */
function bareTrialUrl({ ticket, format, endpoint }) {
  const qs = new URLSearchParams();
  qs.set('chat_session_id', '');
  qs.set('message_id', '');
  qs.set('ticket', ticket);
  qs.set('mode', 'manual');
  qs.set('format', format);
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}${qs.toString()}`;
}

async function bareHandshake({
  ticket,
  format,
  endpoint,
  timeoutMs,
  webSocketImpl,
  origin,
}) {
  const url = bareTrialUrl({ ticket, format, endpoint });
  const out = {
    kind: 'bare',
    url: redactUrl(url),
    opened: false,
    firstTextFrame: null,
    closeCode: null,
    error: null,
    elapsedMs: 0,
  };
  const started = Date.now();

  await new Promise((resolve) => {
    let ws;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      out.elapsedMs = Date.now() - started;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    try {
      ws = origin ? new webSocketImpl(url, { headers: { Origin: origin } }) : new webSocketImpl(url);
    } catch (cause) {
      out.error = `建 ws 失败：${cause?.message ?? cause}`;
      finish();
      return;
    }
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* ignore */
    }
    ws.onopen = () => {
      out.opened = true;
    };
    ws.onmessage = (ev) => {
      if (typeof ev?.data === 'string' && out.firstTextFrame === null) {
        try {
          out.firstTextFrame = JSON.parse(ev.data);
        } catch {
          out.firstTextFrame = { raw: String(ev.data).slice(0, 200) };
        }
        finish();
      }
    };
    ws.onerror = (ev) => {
      out.error = String(ev?.error?.message ?? ev?.message ?? 'websocket error');
    };
    ws.onclose = (ev) => {
      out.closeCode = ev?.code ?? null;
      out.closeReason = ev?.reason || null;
      finish();
    };
  });

  return out;
}

/**
 * @returns {Promise<object>} 诊断报告，结构见函数末尾。
 */
export async function probeProtocol({
  token: explicitToken,
  sessionId,
  messageId,
  format = 'pcm',
  voice,
  tryWs = true,
  timeoutMs = 15_000,
  endpoint = WS_ENDPOINT,
  origin = 'https://chat.deepseek.com',
  signal,
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  log = console.log,
} = {}) {
  const line = (s = '') => log(s);
  const started = Date.now();
  const report = {
    node: process.version,
    startedAt: new Date().toISOString(),
    token: { present: false, looksValid: false },
    localVoices: VOICES.map((v) => ({ ...v, demoUrls: { ...v.demoUrls } })),
    voices: { attempted: false, ok: false, error: null },
    ticket: { attempted: false, ok: false, error: null },
    ws: { attempted: false, skipped: false, reason: null, ok: false, error: null },
    verdict: { usable: false, reasons: [], notes: [] },
    elapsedMs: 0,
  };

  const token = resolveToken(explicitToken);
  report.token.present = Boolean(token);
  report.token.looksValid = looksLikeToken(token ?? '');

  line(`Node ${process.version}`);
  line('');
  line('本地内置音色表（逆向 + 2026-09-12 实测）：');
  for (const v of VOICES) {
    line(
      `  ${v.id.padEnd(7)} ${v.name}  ${v.gender === 'female' ? '女' : '男'}  ${v.description}` +
        `  ${v.languageCount} 种语言${v.isDefault ? '  (默认)' : ''}`,
    );
  }
  line('');

  if (!report.token.present) {
    report.verdict.reasons.push(
      '缺少登录态：没有 userToken。取票、列真实音色、合成这三步全都需要它。',
    );
    line('判决：用不了 —— 缺少登录态。');
    line('  设 DS_TOKEN 或者传 --token 再来。怎么拿 token 见 README 的「登录一次就好」一节。');
    line('  本包不会去读你的浏览器 cookie / localStorage / LevelDB，这活你自己做。');
    report.elapsedMs = Date.now() - started;
    return report;
  }

  if (!report.token.looksValid) {
    report.verdict.notes.push(
      `token 长度是 ${token.length}，实测的 userToken 是 64 字符的不透明串；可能不影响，但先提一句。`,
    );
  }

  // 1) 真实音色列表
  report.voices.attempted = true;
  const t0 = Date.now();
  try {
    const res = await listVoices({ token, signal, fetchImpl });
    report.voices.ok = true;
    report.voices.latencyMs = Date.now() - t0;
    report.voices.defaultVoiceId = res.defaultVoiceId;
    report.voices.currentVoiceId = res.currentVoiceId;
    report.voices.list = res.voices.map((v) => ({
      id: v.id,
      name: v.nameI18n?.zh ?? v.nameI18n?.en ?? v.id,
      gender: v.gender,
      languages: v.languages.length,
      demos: Object.keys(v.demoUrls),
    }));
    line(`1) 音色接口 GET /api/v0/chat/tts/voices  OK（${report.voices.latencyMs}ms）`);
    for (const v of report.voices.list) {
      line(`   ${String(v.id).padEnd(7)} ${v.name}  ${v.languages} 种语言  demo: ${v.demos.join(',') || '(无)'}`);
    }
    line(`   default=${res.defaultVoiceId}  current=${res.currentVoiceId}`);
  } catch (err) {
    report.voices.error = err instanceof DeepSeekTtsError ? err.describe() : String(err?.message ?? err);
    report.voices.kind = err?.kind;
    line(`1) 音色接口 失败：${report.voices.error}`);
  }
  line('');

  // 2) 取票
  report.ticket.attempted = true;
  const t1 = Date.now();
  let ticket = null;
  try {
    const res = await issueTicket({ token, signal, fetchImpl });
    ticket = res.ticket;
    report.ticket.ok = true;
    report.ticket.latencyMs = Date.now() - t1;
    report.ticket.expiresInSecs = res.expiresInSecs;
    // 票本身一个字符都不打印，只报长度 —— 别让它有机会进日志或 issue。
    report.ticket.length = ticket.length;
    line(`2) 取票 POST /api/v0/auth/ticket {scope:"tts"}  OK（${report.ticket.latencyMs}ms）`);
    line(`   拿到票 ${ticket.length} 字符  expires_in_secs=${res.expiresInSecs ?? '未返回'}`);
    line('   注意：票是一次性的，下面试连会把它用掉，不会再复用。');
  } catch (err) {
    const code = err?.code;
    report.ticket.error = err instanceof DeepSeekTtsError ? err.describe() : String(err?.message ?? err);
    report.ticket.kind = err?.kind;
    if (code !== undefined && code !== null) {
      report.ticket.codeName = codeName(code);
      report.ticket.hint = codeHint(code);
    }
    line(`2) 取票 失败：${report.ticket.error}`);
  }
  line('');

  // 3) 试连
  if (!tryWs) {
    report.ws.skipped = true;
    report.ws.reason = '--no-ws：按你说的跳过了';
  } else if (!report.ticket.ok) {
    report.ws.skipped = true;
    report.ws.reason = '没拿到票，试连没有意义';
  } else {
    report.ws.attempted = true;
    const t2 = Date.now();
    if (sessionId && messageId) {
      try {
        const result = await synthesize({
          sessionId,
          messageId,
          token,
          format,
          voice,
          timeoutMs,
          signal,
          fetchImpl,
          webSocketImpl,
          endpoint,
          log: noop,
        });
        report.ws.ok = true;
        report.ws.kind = 'synthesize';
        report.ws.latencyMs = Date.now() - t2;
        report.ws.frameCount = result.frameCount;
        report.ws.bytes = result.bytes;
        report.ws.audioId = result.audioId;
        report.ws.voiceId = result.voiceId;
        report.ws.traceId = result.traceId;
        report.ws.finish = result.finish;
        if (result.durationSec !== undefined) report.ws.durationSec = result.durationSec;
        line(`3) 试合成 ${format}  OK（${report.ws.latencyMs}ms）`);
        line(
          `   ${result.frameCount} 帧 / ${result.bytes} 字节` +
            (result.durationSec !== undefined ? ` / ${result.durationSec.toFixed(2)}s` : '') +
            `  voice=${result.voiceId} format=${result.format}`,
        );
        if (result.durationSec !== undefined) {
          const expected = (result.bytes / (PCM.bitsPerSample / 8)) / PCM.sampleRate;
          report.ws.durationCheck = { computed: expected, reported: result.durationSec };
        }
      } catch (err) {
        report.ws.error = err instanceof DeepSeekTtsError ? err.describe() : String(err?.message ?? err);
        report.ws.kind = err?.kind;
        report.ws.code = err?.code;
        const partial = err?.details?.result;
        if (partial) {
          report.ws.partial = {
            frameCount: partial.frameCount,
            bytes: partial.bytes,
            missingSeqs: partial.missingSeqs,
          };
        }
        line(`3) 试合成 失败（${Date.now() - t2}ms）：${report.ws.error}`);
      }
    } else {
      const out = await bareHandshake({ ticket, format, endpoint, timeoutMs, webSocketImpl, origin });
      report.ws = {
        attempted: true,
        skipped: false,
        reason: null,
        kind: 'bare',
        ...out,
        ok: Boolean(out.opened) && !out.error,
      };
      line(`3) 空 id 试连（没给 --session/--message，只验握手，不代表能合成）`);
      line(`   ${out.opened ? '握手成功' : '握手没成'}  ${out.elapsedMs}ms`);
      if (out.firstTextFrame) {
        const f = out.firstTextFrame;
        line(`   服务端第一帧：${JSON.stringify(f)}`);
        if (f.event === 'finish' && typeof f.code === 'number') {
          report.ws.finishCode = f.code;
          report.ws.finishCodeName = codeName(f.code);
        }
      }
      if (out.closeCode !== null) line(`   close code=${out.closeCode}${out.closeReason ? ` reason=${out.closeReason}` : ''}`);
      if (out.error) line(`   底层报错：${out.error}`);
      line('   想让试连真正判定「能不能用」，补上 --session <会话id> --message <消息id>。');
    }
  }
  line('');

  // 判决
  const reasons = report.verdict.reasons;
  if (!report.voices.ok) reasons.push(`音色接口不通：${report.voices.error}`);
  if (!report.ticket.ok) reasons.push(`取不到票：${report.ticket.error}`);
  if (report.ws.attempted && report.ws.kind === 'synthesize' && !report.ws.ok) {
    reasons.push(`试合成失败：${report.ws.error}`);
  }
  if (report.ws.attempted && report.ws.kind === 'bare') {
    if (report.ws.finishCode !== undefined && report.ws.finishCode !== 0) {
      // 空 id 被否掉属于预期，反而说明票是有效的、账号没被挡。
      report.verdict.notes.push(
        `空 id 试连拿到 finish code=${report.ws.finishCode}(${report.ws.finishCodeName})，` +
          '这是预期的 —— 说明票有效、端点通，只是 id 是空的。',
      );
    } else if (!report.ws.ok) {
      reasons.push(`空 id 试连没通：${report.ws.error ?? `close code=${report.ws.closeCode}`}`);
    }
  }
  if (report.ws.skipped) report.verdict.notes.push(`ws 试连跳过：${report.ws.reason}`);

  report.verdict.usable = reasons.length === 0 && report.ticket.ok && report.voices.ok;

  if (report.verdict.usable) {
    line('判决：这个账号可以用。');
    if (report.ws.skipped) {
      line('  （ws 那一步跳过了，所以「能合成」还没被直接证明，但票和音色接口都放行了。）');
    }
  } else {
    line('判决：用不了，或者至少现在不行。原因：');
    for (const r of reasons) line(`  - ${r}`);
  }
  for (const n of report.verdict.notes) line(`  · ${n}`);

  report.elapsedMs = Date.now() - started;
  line('');
  line(`耗时 ${report.elapsedMs}ms`);
  return report;
}

export { assertToken };
