# 写 README 用的素材

下面全是**从代码里抠出来的事实**，没有一处是我凭印象写的。你照着挑着写。
标「必写」的是不写用户就会踩坑的，标「可选」的是锦上添花。

---

## 1. 这是什么

- 名称：`deepseek-tts-api`
- 一句话：DeepSeek 网页版「朗读」的非官方客户端 + 命令行
- 形态：Node 包 + CLI，命令名叫 `dstts`
- 版本：0.2.0
- 依赖：**零运行时依赖**（`dependencies: {}`）
- 环境：**Node >= 22**（用的是 Node 自带的 `fetch` 和 `WebSocket`，所以不装 `ws` / `node-fetch`）

### 能干什么（必写）

| 想干的事 | 命令 |
|---|---|
| 看有哪几个音色 | `dstts voices` |
| 下试听听听哪个好听 | `dstts demo mira -o 试听.mp3` |
| 检查自己账号能不能用 | `dstts probe` |
| **让它念我随便写的一段话** | `dstts say "今天辛苦了，早点睡。"` |
| 念已经聊过的某条回答 | `dstts read --session <id> --message <id>` |
| 本地 PCM 套个 WAV 头 | `dstts wav in.pcm out.wav` |

---

## 2. 链接（必写）

- 仓库：https://github.com/Eyeing0721/deepseek-tts-api
- 主页 / 打赏：https://0721.luxe/
- 作者：[@Eyeing0721](https://github.com/Eyeing0721)

---

## 3. 三种跑法（必写，至少给一种）

```bash
# 1. 不装，直接从 GitHub 跑（实测首次 11 秒，含下载）
npx github:Eyeing0721/deepseek-tts-api voices

# 2. 全局装
npm install -g .
dstts voices

# 3. 克隆下来直接跑
node bin/dstts.mjs voices
```

`npm` 上**还没发布**。

---

## 4. 登录态（必写，这是唯一门槛）

需要一个 `userToken`。**所有命令都要**（包括 `voices` 和 `demo`）。

### 怎么拿

登录 `chat.deepseek.com`，按 F12（Mac 是 `Option + Command + I`）打开 DevTools，
切到 **Console / 控制台**，执行：

```js
JSON.parse(localStorage.getItem('userToken')).value
```

得到一串 **64 字符的不透明串**（不是 JWT）。

> 如果 Console 不让粘贴，先在里面手打 `allow pasting` 回车。

### 怎么喂给它

```bash
export DS_TOKEN='那串东西'      # bash / macOS
$env:DS_TOKEN = '那串东西'      # Windows PowerShell
```

或者临时用 `--token <值>`。

### 安全事实（可选写，但写了让人放心）

- 只从 `DS_TOKEN` 环境变量和 `--token` 读
- **不写进任何文件、不打进日志**
- **不读你的浏览器数据**（不翻 localStorage、不碰 cookie、不开 LevelDB）
- `probe` 报告里连票都只报长度；URL 里的票会被替换成 `<redacted>`

---

## 5. 命令细节

### 通用选项

| 选项 | 说明 |
|---|---|
| `-o, --out <路径>` | 输出文件 |
| `--format <格式>` | `pcm`（默认）或 `opus` |
| `--voice <id>` | 先切音色再合成 |
| `--token <值>` | userToken |
| `--timeout <ms>` | 超时，默认 read=90000 / probe=15000 |
| `--json` | 机器可读输出（`voices` / `probe`） |
| `-h, --help` / `--version` | |

### voices

```bash
dstts voices
```

打官方接口列表。带 `--json` 出结构化数据。

输出长这样：

```
音色列表（官方接口 /api/v0/chat/tts/voices）
默认 mira   当前 mira

  mira     贝壳   female  百变活泼   29 种语言  试听 29 个  (默认)
  echo     白浪   male    明朗坚定   29 种语言  试听 29 个
  stella   海星   female  俏皮甜美   10 种语言  试听 10 个
  tide     暗潮   male    低沉浑厚   10 种语言  试听 10 个

  mira/de  https://cdn.deepseek.com/chat/tts/voice-demos/mira_de.83c16287.mp3
  ...（每个音色 × 每种语言的试听地址）
```

### demo

```bash
dstts demo mira -o 试听.mp3          # 默认中文
dstts demo tide --lang yue -o x.mp3  # 指定语言
```

默认文件名 `demo-<音色>-<语言>.mp3`。

### probe

```bash
dstts probe
dstts probe --session <id> --message <id>    # 补上 id 才是"真判定"
```

依次打音色列表、取票、试连一次 ws，最后给判决。每步耗时都打出来。失败也是一行字，不抛栈。

**不给 session/message 时，试连拿的是空 id**，只能证明票和端点是通的，证明不了能合成。

退出码 1 = 用不了。`--json` 出结构化报告。

没登录态时长这样：

```
判决：用不了 —— 缺少登录态。
  设 DS_TOKEN 或者传 --token 再来。怎么拿 token 见 README 的「上手」一节。
  本包不会去读你的浏览器 cookie / localStorage / LevelDB，这活你自己做。
```

### say（重点功能）

```bash
dstts say "今天天气不错，适合睡觉。"
dstts say "念这句" --voice tide -o tide.wav
dstts say "别删会话" --keep
dstts say "..." --wait 60000 --max-iterations 5000000
dstts say "..." --header "名字: 值"
```

专属选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--keep` | 否 | 念完不删临时会话 |
| `--wait <ms>` | 60000 | 等消息落库的上限 |
| `--max-iterations <n>` | 5000000 | PoW 搜索上限 |
| `--header "名: 值"` | — | 额外请求头，可给多次 |

默认输出名：`ds-say-<时间戳>.wav`

**实际跑起来长这样**（实测）：

```
文本 18 字，format=pcm
  1) 建一次性会话 → 2) 解 PoW → 3) 让模型复述一遍 → 4) 取 message_id → 5) 合成
  会话 07429792-6128-4fb9-bc03-139d0c3610d9 建好了
  PoW 解出来了：answer=107230，试了 107231 次，算 760ms（含取 challenge 共 836ms）
  正在把文本发进会话…
  message_id=2，SSE 读了 1.1 KiB
  ws 已连接
  已删掉临时会话 07429792-6128-4fb9-bc03-139d0c3610d9
  合成 OK：36 帧 / 167.3 KiB / 3.57s  voice=mira format=pcm
  实际念到的正文："去掉多余选项之后，再确认一次还能念。"
  封装 WAV → refactor-check.wav（167.4 KiB）
  总耗时 5065ms
```

**为什么中间要"让模型复述一遍"**（必写，否则用户会以为绕了没必要的路）：

合成的请求里只有 `chat_session_id` 和 `message_id`，**没有正文参数** —— 读什么由服务端拿这两个 id
去你会话里查。而服务端**只念模型的消息**，拿用户消息去合成会被 `code=6 NO_CONTENT` 顶回来。

所以 `say` 实际发进去的是一句提示语（实测原文）：

```
请把下面这段文字原样输出一遍，不要翻译、不要总结、不要解释、不要加引号或任何前后缀，一个字都不要改：

<你给的文本>
```

然后等模型那条回复，拿它的 `message_id` 去合成。

**完整链路**：

```
建会话 → 取 PoW challenge → 解工作量证明 → 发复述提示语
      → 拉 history 拿到模型回复的 message_id → 合成 → 删会话
```

### read

```bash
dstts read --session <会话id> --message <消息id> -o out.wav
dstts read --session <id> --message <id> --voice tide --format pcm
```

- `--session`：会话 id，网页 URL 里 `/a/chat/s/<uuid>` 那一段
- `--message`：那条消息的 `message_id`
- 不写 `-o` 默认 `ds-tts-<message_id>.wav`

### wav

```bash
dstts wav in.pcm out.wav
dstts wav in.pcm out.wav --rate 16000 --channels 2
```

默认按 24000 Hz / 单声道 / 16 bit。长度不是 `blockAlign` 整数倍会直接报错（不悄悄补字节）。

---

## 6. 音色表（必写）

| voice_id | 中文名 | 英文名 | 性别 | 描述 | 语言数 |
|---|---|---|---|---|---|
| `mira` | 贝壳 | Mira | female | 百变活泼 | 29（默认） |
| `echo` | 白浪 | Echo | male | 明朗坚定 | 29 |
| `stella` | 海星 | Stella | female | 俏皮甜美 | 10 |
| `tide` | 暗潮 | Tide | male | 低沉浑厚 | 10 |

- 海星/暗潮支持的 10 种语言：`ar en id ja ko ms th vi yue zh`（含粤语）
- 音色是**服务端会话级状态**：切了就一直是那个，直到你再切

---

## 7. 错误码全表（必写，用户最需要）

出错时 CLI 会带上下面这句中文，照着对就行：

| 码 | 名字 | CLI 打的中文 |
|---|---|---|
| 0 | SUCCESS | — |
| 1 | INTERNAL_ERROR | 服务端内部错误 |
| 2 | INVALID_INPUT | 请求参数不对（会话 id / 消息 id 大概率是错的） |
| 3 | SERVICE_ERROR | 服务端业务异常 |
| 4 | QUOTA_EXCEEDED | 朗读额度用完了（今日限额） |
| 5 | RATE_LIMIT_REACHED | 请求太频繁，被限流了 |
| 6 | NO_CONTENT | 这条消息没有可朗读的正文 |
| 7 | UNSUPPORTED_LANGUAGE | 当前语言不支持朗读 |
| 8 | VOICE_UNSUPPORTED_LANGUAGE | 这个音色不支持当前语言 |
| 9 | NOT_AVAILABLE | 服务端未对该账号放行（NOT_AVAILABLE，灰测/地区限制） |
| 10 | RESUME_EXPIRED | 续传票据过期了 |
| 11 | FORBIDDEN | 被拒绝（FORBIDDEN） |
| 12 | CONTENT_FILTER | 内容被安全过滤挡了 |

另外两种非协议错误：

- **auth**：缺少登录态 / token 无效。文案：`缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。取 userToken 的办法见 README 的「上手」一节`
- **参数错误**：`参数错误：不认识的选项：--via` 这种

---

## 8. 得知道的坑（必写）

1. **票是一次性的。** 有效期 600 秒，但**只能用一次**。同一张票第二次建 ws 会被服务端
   1006 断开、零帧、**没有任何错误信息**。程序每次建连前都会重新取票。

2. **账号可能没被放行。** 朗读还在灰测，`code=9 NOT_AVAILABLE` / `11 FORBIDDEN` 都可能。
   这不是工具能解决的。

3. **服务端不念用户消息**（见第 5 节 say）。

4. **`format=opus` 给的是裸 Opus 包，没有容器**（不是 Ogg）。多数播放器打不开。
   默认的 `pcm` 会自动套好 44 字节 WAV 头，拿来就能播。

5. **不伪造浏览器指纹头。** 官方前端在 completion 上还带 `x-hif-leim` / `x-hif-dliq` /
   `x-client-*`，本包不发。服务端要的话用 `--header` 自己塞。

6. **每念一次会在你账号里建一个临时会话**，默认念完删掉。删失败会在输出里说一声。

7. **PoW 要算一会儿。** 服务端强制要求工作量证明，本地解一次大概 300~900ms。
   上限默认 500 万次迭代，超了明确报错。

---

## 9. 性能实测（可选，但数字很能说服人）

| 命令 | 耗时 |
|---|---|
| `dstts voices`（带 token 实拉） | 0.22 s |
| `dstts probe` | 0.26 s（音色接口 86ms + 取票 36ms） |
| `dstts say` 短句（11 字 → 1.8s 音频） | 3.2 ~ 4.2 s |
| `dstts say` 长文本（101 字 → 19.0s 音频） | 7.1 s |
| `npx github:... help` 首次（含下载） | 11.1 s |

拆开看：**固定开销约 3.3 秒**（建会话 + PoW + completion + 拉 history + TTS 握手 + node 启动），
之后**音频按约 5 倍速合成**（每 1 秒音频约 0.2 秒）。

PoW 波动最大，实测 5 万 ~ 13.6 万次迭代，所以总耗时天然有 ±1 秒抖动。

---

## 10. 音频规格

- PCM：**24000 Hz / 单声道 / 16 bit**
- 48kHz 之类不支持，服务端就这么给的
- 帧格式：wss 二进制帧，**前 4 字节大端 seq + 负载**
- 客户端要回 `{"event":"ack","received_seq":N,"played_seq":M}`
  （`received_seq` 是**收到的帧数**；`played_seq` 单位是 **100ms**）

---

## 11. 当库用（可选，给会写代码的人）

```js
import { writeFile } from 'node:fs/promises';
import { synthesize, pcmToWav } from 'deepseek-tts-api';

const r = await synthesize({ sessionId: '...', messageId: '...' });  // token 不给就读 DS_TOKEN
await writeFile('out.wav', pcmToWav(r.audio));
```

`synthesize()` 返回：

```
audio, bytes, format, requestedFormat,
voiceId, audioId, traceId,
frameCount, firstSeq, lastSeq, missingSeqs, duplicates, outOfOrder, contiguous, fullyEmitted,
acksSent, events, finish,
ticket: { expiresInSecs }, url, sessionId, messageId, warnings, closeInfo,
// pcm 才有：
sampleRate, channels, bitsPerSample, samples, durationSec
```

流式收用 `onChunk: (buf) => play(buf)`。

其它导出（共 60 多个，常用的）：`issueTicket` `listVoices` `setVoice` `resolveDemoUrl`
`probeProtocol` `createSession` `deleteSession` `fetchMessages` `putText` `say`
`pcmToWav` `wavHeader` `parseWavHeader` `DeepSeekTtsError` `ErrorCode` `codeName` `codeHint`
`VOICES` `PCM` `FORMATS` `TOKEN_ENV` `parseArgv`

错误统一是 `DeepSeekTtsError`：

```js
catch (e) { e.kind; e.code; e.codeName; e.describe(); }
// kind: usage | auth | protocol | transport | network
```

---

## 12. 目录结构（可选）

```
bin/dstts.mjs          CLI，只做参数 -> 调库 -> 打印
src/constants.mjs      端点、音色表、错误码、pcm 参数
src/http.mjs           取票 / 音色列表 / 切音色 / 下 demo
src/frames.mjs         4 字节大端 seq 解析、收帧器、ws 地址
src/tts.mjs            synthesize()
src/wav.mjs            PCM -> WAV
src/probe.mjs          probeProtocol()
src/deepseek-hash.mjs  DeepSeekHashV1（PoW 用的自定义哈希）
src/pow.mjs            取 challenge / 解 PoW / 拼 X-DS-PoW-Response
src/session.mjs        建一次性会话、塞文本、say() 编排
src/cli-args.mjs       参数解析（纯函数，能单独测）
src/errors.mjs         错误码与中文提示
src/index.mjs          导出
test/                  node --test，124 个用例
docs/PROTOCOL.md       协议细节
VERIFY.md              验证记录（按时间顺序，里面有些是旧状态）
```

---

## 13. 测试（可选）

```bash
npm test        # 就是 node --test
```

**124 个用例，不需要网络也不需要 token。** 跑完约 1.6 秒。

覆盖：WAV 头逐字节、4 字节大端 seq 的乱序/重复/缺帧、音色表、CLI 参数解析、
假 WebSocket + 假 fetch 演的整条 `synthesize()` 和 `say()`、PoW 的 13 组 golden vector + 120 组随机串对拍。

> Node 25 起 `node --test test/` 不再接受目录参数，直接 `node --test`。

---

## 14. 没验到的（可选，写了显得诚实）

- 错误码 `4`（额度）/ `5`（限流）没真触发过
- 断线续传没试（`buildTtsUrl` 支持 `resume` 参数，但 `synthesize()` 没实现自动续传，断线直接报错）
- opus 每包多少采样、能否独立解码，没确认
- 官方那几个指纹头服务端到底要不要，不知道（到目前为止不要）

**已经验过的**：真账号端到端跑通过——建会话 → 解 PoW → 发文本 → 取 message_id → wss 合成 → 出 WAV，
临时会话自动清理，账号里没残留。`VERIFY.md` 里有原始输出。

---

## 15. 免责（必写）

- 非官方，跟 DeepSeek 没有任何关系，也没得到他们认可
- 协议是逆向出来的，官方一改就可能失效
- 仅供个人学习和技术研究，别拿去批量滥用
- 额度、限流、内容过滤都是服务端说了算，账号被封跟作者没关系
- MIT，版权 Eyeing0721

---

## 附：写的时候注意

- **别写"不需要登录"**——所有命令都要，包括 `voices` 和 `demo`
- **别写 `--via`**——这个选项已经删了，`user` 必然被拒、`auto` 白烧一个会话，都去掉了
- 报错文案（第 7 节）**照抄**，用户就是拿着它来对答案的
- 默认输出文件名：`say` 是 `ds-say-<时间戳>.wav`，`read` 是 `ds-tts-<message_id>.wav`，`demo` 是 `demo-<音色>-<语言>.mp3`
