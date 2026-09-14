#!/usr/bin/env node
/**
 * dstts —— 非官方 DeepSeek 朗读（TTS）命令行。
 *
 * 这个文件只做「读参数 -> 调 src/ -> 打印结果」。协议逻辑全在 src/ 里。
 * 关于 token：只从 --token 或 DS_TOKEN 读，不写盘、不打日志、不回显。
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import {
  COMMANDS,
  DeepSeekTtsError,
  PCM,
  assertToken,
  fetchBinary,
  listVoices,
  numericOptions,
  parseArgv,
  parseHeaderList,
  parseWavHeader,
  pcmToWav,
  probeProtocol,
  requireOption,
  requirePositional,
  resolveDemoUrl,
  resolveToken,
  say,
  synthesize,
  usageError,
} from '../src/index.mjs';

const VERSION_FALLBACK = '0.0.0';

const USAGE = `dstts —— 非官方 DeepSeek 网页版朗读（TTS）客户端

用法：
  dstts voices                                   列音色
  dstts demo <voice_id> [-o out.mp3] [--lang zh] 下试听 demo
  dstts probe [--session <id> --message <id>]    取票 + 试连，打印判决
  dstts read --session <id> --message <id>       从已有会话消息合成
             [-o out.wav] [--voice mira] [--format pcm|opus]
  dstts say <文本> [-o out.wav]                  随便给一段文本，现场造一个一次性会话念出来
             [--voice mira] [--keep]
  dstts wav <in.pcm> <out.wav> [--rate 24000] [--channels 1]
  dstts help

登录态：
  所有命令都要登录态。DS_TOKEN 环境变量，或者 --token <值>。
  本程序不会去读你的浏览器数据，也不会把 token 写进任何文件。

通用选项：
  -o, --out <路径>     输出文件
      --format <格式>  pcm（默认）或 opus
      --voice <id>     先切音色再合成
      --token <值>     userToken
      --timeout <ms>   超时，默认 read=90000 / probe=15000
      --json           机器可读输出（voices / probe）
  -h, --help           这个
      --version        版本号

say 专属：
      --keep           念完不删那个临时会话（默认删）
      --wait <ms>      等消息落库的上限，默认 60000
      --max-iterations <n>  PoW 搜索上限，默认 5000000
      --header "名: 值"     额外请求头，可以给多次（官方前端还带一批指纹头，本包不伪造）

没有正文参数这件事是真的：/chat/tts 的请求里只有 chat_session_id + message_id，
读什么文字由服务端从你的会话消息里取 —— 所以 say 干的就是先把文本变成一条消息。
服务端不念用户消息（code=6），所以要绕一道：让模型先复述一遍，念它那条。
`;

async function readPkgVersion() {
  try {
    const txt = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return JSON.parse(txt).version ?? VERSION_FALLBACK;
  } catch {
    return VERSION_FALLBACK;
  }
}

/** 万一有异常信息里混进了 token，兜一下再往外打。 */
function makeScrubber(token) {
  if (!token || token.length < 8) return (s) => String(s);
  return (s) => String(s).split(token).join('<redacted>');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function fmtDuration(sec) {
  if (sec === undefined || sec === null || !Number.isFinite(sec)) return '?';
  return `${sec.toFixed(2)}s`;
}

function looksLikeMp3(buf) {
  if (buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0; // MPEG 帧同步
}

async function cmdVoices(parsed, ctx) {
  // 音色列表这个接口是要登录态的，不带就 40003。以前会静默退回内置表，
  // 结果有人拿着过期的表来问为什么对不上——现在要求必须登录。
  const token = assertToken(resolveToken(parsed.options.token));

  const live = await listVoices({ token });

  if (parsed.options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          source: 'api',
          defaultVoiceId: live.defaultVoiceId,
          currentVoiceId: live.currentVoiceId,
          voices: live.voices,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  process.stdout.write(`音色列表（官方接口 /api/v0/chat/tts/voices）\n`);
  process.stdout.write(`默认 ${live.defaultVoiceId ?? '?'}   当前 ${live.currentVoiceId ?? '?'}\n\n`);
  for (const v of live.voices) {
    const name = v.nameI18n?.zh ?? v.nameI18n?.en ?? '';
    const desc = v.descriptionI18n?.zh ?? v.descriptionI18n?.en ?? '';
    const langs = Array.isArray(v.languages) ? v.languages.length : 0;
    const demos = Object.keys(v.demoUrls ?? {}).length;
    process.stdout.write(
      `  ${String(v.id).padEnd(8)} ${name.padEnd(4)} ${String(v.gender ?? '').padEnd(7)} ` +
        `${desc.padEnd(6)} ${String(langs).padStart(2)} 种语言  试听 ${demos} 个` +
        `${v.isDefault ? '  (默认)' : ''}\n`,
    );
  }
  process.stdout.write('\n');
  for (const v of live.voices) {
    for (const [lang, url] of Object.entries(v.demoUrls ?? {})) {
      process.stdout.write(`  ${v.id}/${lang}  ${url}\n`);
    }
  }
  return 0;
}

async function cmdDemo(parsed, ctx) {
  const voiceId = requirePositional(parsed, 0, 'voice_id', '例如 mira');
  const lang = parsed.options.lang ?? 'zh';
  const out = parsed.options.out ?? `demo-${voiceId}-${lang}.mp3`;

  const token = assertToken(resolveToken(parsed.options.token));
  const { url, source } = await resolveDemoUrl({ voiceId, lang, token });

  process.stdout.write(`试听 ${voiceId}/${lang}（来源：${source === 'api' ? '官方接口' : '内置表'}）\n`);
  process.stdout.write(`  ${url}\n`);

  const { data, contentType, status } = await fetchBinary(url, { maxBytes: 32 * 1024 * 1024 });
  await writeFile(out, data);

  process.stdout.write(`  下载 OK  HTTP ${status}  ${contentType ?? '?'}  ${fmtBytes(data.length)}\n`);
  process.stdout.write(
    `  头 4 字节 ${[...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
      `  ${looksLikeMp3(data) ? '看着像 MP3' : '不太像 MP3，留意一下'}\n`,
  );
  process.stdout.write(`  写到 ${out}\n`);
  return 0;
}

async function cmdProbe(parsed, ctx) {
  const { session, message, format, voice, timeout } = {
    ...parsed.options,
    ...numericOptions(parsed.options),
  };

  const report = await probeProtocol({
    token: parsed.options.token,
    sessionId: session,
    messageId: message,
    format: format ?? 'pcm',
    voice,
    tryWs: !parsed.options['no-ws'],
    ...(timeout ? { timeoutMs: timeout } : {}),
    log: parsed.options.json ? () => {} : (s = '') => process.stdout.write(s + '\n'),
  });

  if (parsed.options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  return report.verdict.usable ? 0 : 1;
}

async function cmdRead(parsed, ctx) {
  const sessionId = requireOption(parsed, 'session', '会话 id');
  const messageId = requireOption(parsed, 'message', '消息 id');
  const { format = 'pcm', voice } = parsed.options;
  const timeout = numericOptions(parsed.options).timeout;

  const ext = format === 'pcm' ? 'wav' : 'opus';
  const out = parsed.options.out ?? `ds-tts-${messageId}.${ext}`;

  // 先把登录态查了再打招呼，免得先报「连接中」再报「你没 token」。
  const token = assertToken(resolveToken(parsed.options.token));

  process.stdout.write(`取票并连接（format=${format}${voice ? `, voice=${voice}` : ''}）…\n`);

  const result = await synthesize({
    sessionId,
    messageId,
    token,
    format,
    voice,
    ...(timeout ? { timeoutMs: timeout } : {}),
    onEvent: () => {},
  });

  process.stdout.write(
    `  ${result.frameCount} 帧 / ${fmtBytes(result.bytes)} / ${fmtDuration(result.durationSec)}` +
      `  seq ${result.firstSeq}..${result.lastSeq}\n`,
  );
  process.stdout.write(
    `  voice=${result.voiceId ?? '?'} format=${result.format}` +
      `${result.audioId ? ` audio_id=${result.audioId}` : ''}` +
      `${result.traceId ? ` trace_id=${result.traceId}` : ''}\n`,
  );
  if (result.duplicates || result.outOfOrder) {
    process.stdout.write(`  重复帧 ${result.duplicates} / 乱序 ${result.outOfOrder}（已处理）\n`);
  }
  for (const w of result.warnings) process.stdout.write(`  [warn] ${w}\n`);

  if (result.format === 'pcm') {
    const wav = pcmToWav(result.audio, {
      sampleRate: result.sampleRate ?? PCM.sampleRate,
      channels: result.channels ?? PCM.channels,
      bitsPerSample: result.bitsPerSample ?? PCM.bitsPerSample,
    });
    await writeFile(out, wav);
    process.stdout.write(
      `  封装 WAV：${result.sampleRate}Hz / ${result.channels}ch / ${result.bitsPerSample}bit` +
        `  → ${out}（${fmtBytes(wav.length)}）\n`,
    );
  } else {
    await writeFile(out, result.audio);
    process.stdout.write(`  写出裸 opus 包 → ${out}（${fmtBytes(result.audio.length)}）\n`);
    process.stdout.write(
      '  提醒：opus 这条路给的是裸 Opus 包，没有 Ogg 容器，多数播放器直接打不开。\n' +
        '  要听的话得自己塞进 Ogg/WebM，或者干脆用 --format pcm。\n',
    );
  }
  return 0;
}

async function cmdSay(parsed, ctx) {
  const text = parsed.options.text ?? parsed.positionals.join(' ');
  if (!text || !text.trim()) {
    throw usageError('say 需要文本：`dstts say "要念的内容"` 或者 --text "..."');
  }
  const { format = 'pcm' } = parsed.options;
  const { timeout, wait, 'max-iterations': maxIterations } = numericOptions(parsed.options);
  const extraHeaders = parseHeaderList(parsed.options.header);
  const token = assertToken(resolveToken(parsed.options.token));

  const ext = format === 'pcm' ? 'wav' : 'opus';
  const out = parsed.options.out ?? `ds-say-${Date.now()}.${ext}`;

  process.stdout.write(`文本 ${text.length} 字，format=${format}\n`);
  process.stdout.write('  1) 建一次性会话 → 2) 解 PoW → 3) 让模型复述一遍 → 4) 取 message_id → 5) 合成\n');

  const t0 = Date.now();
  const result = await say({
    text,
    format,
    token,
    voice: parsed.options.voice,
    keepSession: Boolean(parsed.options.keep),
    ...(timeout ? { timeoutMs: timeout } : {}),
    ...(wait ? { waitTimeoutMs: wait } : {}),
    ...(maxIterations ? { maxIterations } : {}),
    extraHeaders,
    onProgress: (p) => {
      if (p.step === 'session') process.stdout.write(`  会话 ${p.sessionId} 建好了\n`);
      if (p.step === 'pow-done') {
        process.stdout.write(
          `  PoW 解出来了：answer=${p.answer}，试了 ${p.answer + 1} 次，算 ${p.solveMs}ms（含取 challenge 共 ${p.totalMs}ms）\n`,
        );
      }
      if (p.step === 'completion') process.stdout.write('  正在把文本发进会话…\n');
      if (p.step === 'message') {
        process.stdout.write(
          `  message_id=${p.messageId}` +
            `${p.streamBytes !== undefined ? `，SSE 读了 ${fmtBytes(p.streamBytes)}` : ''}\n`,
        );
      }
    },
    log: (s) => process.stdout.write(`  ${s}\n`),
  });

  process.stdout.write(
    `  合成 OK：${result.frameCount} 帧 / ${fmtBytes(result.bytes)} / ${fmtDuration(result.durationSec)}` +
      `  voice=${result.voiceId ?? '?'} format=${result.format}\n`,
  );
  process.stdout.write(`  实际念到的正文：${JSON.stringify(result.scratch.content.slice(0, 80))}${result.scratch.content.length > 80 ? '…' : ''}\n`);

  if (result.format === 'pcm') {
    const wav = pcmToWav(result.audio, {
      sampleRate: result.sampleRate ?? PCM.sampleRate,
      channels: result.channels ?? PCM.channels,
      bitsPerSample: result.bitsPerSample ?? PCM.bitsPerSample,
    });
    await writeFile(out, wav);
    process.stdout.write(`  封装 WAV → ${out}（${fmtBytes(wav.length)}）\n`);
  } else {
    await writeFile(out, result.audio);
    process.stdout.write(`  写出裸 opus 包 → ${out}（${fmtBytes(result.audio.length)}）\n`);
    process.stdout.write('  提醒：opus 是裸包，没有 Ogg 容器，多数播放器打不开。\n');
  }
  process.stdout.write(`  总耗时 ${Date.now() - t0}ms\n`);
  if (result.scratch.attempts > 1) {
    process.stdout.write(`  换了 ${result.scratch.attempts} 种方式才成：${JSON.stringify(result.scratch.problems)}\n`);
  }
  return 0;
}

async function cmdWav(parsed, ctx) {
  const input = requirePositional(parsed, 0, 'in.pcm', '裸 PCM 文件');
  const output = requirePositional(parsed, 1, 'out.wav', '输出 WAV 路径');
  const { rate, channels } = numericOptions(parsed.options);

  const pcm = await readFile(input);
  const wav = pcmToWav(pcm, {
    sampleRate: rate ?? PCM.sampleRate,
    channels: channels ?? PCM.channels,
    bitsPerSample: PCM.bitsPerSample,
  });
  await writeFile(output, wav);

  const head = parseWavHeader(wav);
  const samples = pcm.length / (head.bitsPerSample / 8) / head.channels;
  process.stdout.write(
    `${input}（${fmtBytes(pcm.length)}）→ ${output}（${fmtBytes(wav.length)}）\n`,
  );
  process.stdout.write(
    `  ${head.sampleRate}Hz / ${head.channels}ch / ${head.bitsPerSample}bit / ` +
      `${samples} 采样 / ${fmtDuration(samples / head.sampleRate)}\n`,
  );
  process.stdout.write(`  头自检：${head.valid ? 'RIFF/WAVE/fmt/data 长度自洽' : '头部不自洽！'}\n`);
  return head.valid ? 0 : 1;
}

const HANDLERS = {
  voices: cmdVoices,
  demo: cmdDemo,
  probe: cmdProbe,
  read: cmdRead,
  say: cmdSay,
  wav: cmdWav,
};

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const token = resolveToken(parsed.options.token);
  const ctx = { scrub: makeScrubber(token) };

  if (parsed.version) {
    process.stdout.write((await readPkgVersion()) + '\n');
    return 0;
  }
  if (parsed.errors.length) {
    for (const e of parsed.errors) process.stderr.write(`参数错误：${e}\n`);
    process.stderr.write('\n跑 `dstts help` 看用法。\n');
    return 2;
  }
  if (parsed.help || !parsed.command) {
    process.stdout.write(USAGE);
    return parsed.command || parsed.help ? 0 : 2;
  }

  const handler = HANDLERS[parsed.command];
  if (!handler) {
    process.stderr.write(`不认识的子命令：${parsed.command}\n可选：${COMMANDS.join(' / ')}\n`);
    return 2;
  }

  try {
    return await handler(parsed, ctx);
  } catch (err) {
    if (err instanceof DeepSeekTtsError) {
      process.stderr.write(`错误（${err.kind}）：${ctx.scrub(err.describe())}\n`);
      if (err.kind === 'auth') {
        process.stderr.write(
          '  userToken 从哪来：浏览器登录 chat.deepseek.com 后，localStorage.userToken 里的 value\n' +
            '  （64 字符的不透明串，不是 JWT）。这活你自己做，本程序不去翻你的浏览器数据。\n',
        );
      }
      if (err.details?.result) {
        const r = err.details.result;
        process.stderr.write(
          `  已收到的部分：${r.frameCount} 帧 / ${r.bytes} 字节` +
            `${r.missingSeqs?.length ? `，缺 seq [${r.missingSeqs.slice(0, 10).join(', ')}]` : ''}\n`,
        );
      }
      return 1;
    }
    process.stderr.write(`未预期的错误：${ctx.scrub(err?.stack ?? err)}\n`);
    return 1;
  }
}

process.exitCode = await main();
