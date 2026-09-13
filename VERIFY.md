# 验证记录

这一份是 2026-09-13 夜里在本机跑出来的原始输出，不是我复述的。

## 环境

```
工作目录: D:\eye-labs\deepseek-tts-api
node:      v25.8.0
ffprobe:   ffprobe version 8.1.2-essentials_build-www.gyan.dev (2026)
DS_TOKEN:  unset（全程没设过）
```

顶要紧的一句先放前面：**这次没有 token，所以真实的取票 / 建 ws / 合成那条路，我一次都没跑过。**
下面第 3、4、5 条是真的连了公网（音色表不联网，demo 走公开 CDN），
第 6 条是真的调了 ffmpeg，第 1 条是 86 个用例全绿。
但「拿真账号合成出一段音频」这件事，本文档里没有证据。别把这份记录当成端到端验证。

复现命令：

```powershell
cd D:\eye-labs\deepseek-tts-api
node --test
node bin/dstts.mjs voices
node bin/dstts.mjs demo mira -o demo-mira.mp3
```

## 1. node --test

```
✔ 五个子命令都认得 (1.0731ms)
✔ read：长短选项混着来 (0.2571ms)
✔ demo：位置参数是 voice_id，-o 是输出 (0.1255ms)
✔ wav：两个位置参数 (0.2386ms)
✔ voices 不带任何选项 (0.1324ms)
✔ --out=值 这种内联写法也认 (0.1351ms)
✔ 开关型选项不吃后面的值 (0.1158ms)
✔ --format 只认 pcm / opus (0.2422ms)
✔ --ack-mode 只认 count / index (0.1536ms)
✔ 数字型选项必须是正整数 (0.2713ms)
✔ 不认识的选项报错，但不影响后面的解析 (0.146ms)
✔ 短选项不认识也报错 (0.0967ms)
✔ 选项后面缺值 (0.0676ms)
✔ 开关型选项带值要报错 (0.0778ms)
✔ -- 之后一律当位置参数 (0.0783ms)
✔ 裸 - 当位置参数，不当选项 (0.1848ms)
✔ 没参数就是 help (0.0744ms)
✔ -h 和 --help 都开 help (0.15ms)
✔ --version (0.1142ms)
✔ 不是子命令的第一个词会掉进位置参数，command 保持 null (0.0885ms)
✔ 子命令后面再跟一个子命令名，第二个当位置参数 (0.0816ms)
✔ token 能从选项里读到（但别指望它会打印出来） (0.0911ms)
✔ seq 是大端 uint32，不是小端 (1.1259ms)
✔ seq = 0 / 1 这两个边界值读得对（官方状态机 receivedSeq 初值 -1，按 0 起算） (0.141ms)
✔ payload 是原 buffer 的视图，不是复制 —— 但长度只到帧尾 (0.109ms)
✔ 带 offset 的 TypedArray 视图也能正确解析（别把整个底层 buffer 当帧） (0.1105ms)
✔ ArrayBuffer 和 Uint8Array 两种入参结果一致 (0.138ms)
✔ encodeAudioFrame / parseAudioFrame 来回一致 (0.139ms)
✔ 不足 4 字节的帧要报错，不能硬读 (0.4542ms)
✔ 只有 4 字节（空负载）是合法的，payload 长度 0 (0.1002ms)
✔ 入参不是二进制就报参数错 (0.1458ms)
✔ 顺序到达：每帧立刻吐出来，最后没有 pending (0.4424ms)
✔ 乱序到达：最终 buffer 还是按 seq 排好的，晚到的低 seq 会被记账 (0.1805ms)
✔ 重复帧被丢掉，且不影响拼出来的音频 (0.1563ms)
✔ 缺帧：missing 里点名缺了谁，contiguous 为 false (0.1042ms)
✔ 起始 seq 不是 0 也能过：基准就是第一帧 (0.0903ms)
✔ 中间有洞时，后来补上的帧会跟着前一段一起吐出来 (0.6631ms)
✔ assembleFrames 是个方便入口 (0.1618ms)
✔ 空帧集合不炸 (0.0551ms)
✔ 非法 seq（负数/小数/字符串）直接抛 (0.1254ms)
✔ buildTtsUrl 拼出来的 query 跟官方一致，且顺序稳定 (0.2296ms)
✔ buildTtsUrl 带续传参数时补上 audio_id / received_seq / played_seq (0.0818ms)
✔ buildTtsUrl 缺东西时给的是 usage 错误，不是 TypeError (0.1013ms)
✔ 没有 token：不抛异常，判决里写清楚是缺登录态 (15.0572ms)
✔ 没有 token 时不会去碰网络（把 fetch 换成会炸的也没事） (0.2201ms)
✔ token 无效（40003）：报告里是 auth 失败，仍然不抛 (0.6825ms)
✔ token 长度不对会留一条 note，但不拦 (0.2061ms)
✔ --no-ws 时试连被跳过，理由写明白 (0.3483ms)
✔ 顺利跑完：收帧、拼装、时长、元数据都对 (2.591ms)
✔ onChunk 拿到的顺序就是 seq 顺序 (0.5091ms)
✔ 重复帧丢掉，计数如实；音频不受影响 (0.4149ms)
✔ 有洞就报错，不交一个错位的音频出去 (0.7153ms)
✔ 服务端 finish 带错误码 -> protocol 错误，码和名字都在 (0.4306ms)
✔ 一帧都没收到就 finish -> 报错，不给空文件 (0.2684ms)
✔ 连接 1006 断掉、零帧 -> 提示 ticket 可能已经用过 (0.2834ms)
✔ 服务端把 format 改成别的 -> 听服务端的，并留一条 warning (0.4771ms)
✔ ackMode=count 时 received_seq 发的是「帧数」（官方口径） (43.2935ms)
✔ ackMode=index 时 received_seq 发最后一个 seq（省事口径） (46.731ms)
✔ 没有 token -> auth 错误，文案里说清楚缺什么 (15.0951ms)
✔ token 无效（40003）-> auth 错误，带上服务端原话 (0.5973ms)
✔ 取票返回 biz_code 9（未放行）-> protocol 错误 (0.2332ms)
✔ 参数不全走 usage 错误，不是 TypeError (0.2209ms)
✔ 传了 voice 就先切音色，而且切音色发生在取票之前 (0.5023ms)
✔ 每次建连都重新取票（票是一次性的，两次连就是两张） (0.3268ms)
✔ AbortSignal 能中断，且走的是 abort 事件 (29.7241ms)
✔ 非 JSON 的文本帧只记 warning，不炸 (0.372ms)
✔ 正好四个音色，id 就是这四个 (1.4547ms)
✔ 中文名 / 性别 / 描述 逐个对 (0.2047ms)
✔ 语言数：贝壳/白浪 29，海星/暗潮 10 (0.1021ms)
✔ 默认音色只有 mira 一个 (0.1271ms)
✔ 内置的试听地址只有实测过的那两个，而且是 https + .mp3 (0.2652ms)
✔ 两个哈希是各自独立的 —— 别以为换个音色名就能拼出来 (0.0976ms)
✔ getVoice 大小写不敏感，空值/未知给 undefined (0.0847ms)
✔ 表是冻结的，防止运行时被改 (0.3916ms)
✔ 错误码表就是 main.js 里那 13 个，一个不多一个不少 (0.1641ms)
✔ codeName / isSuccessCode / codeHint 行为正确 (0.2636ms)
✔ 44 字节头，8 字节数据：逐字节对上手工算的期望 (1.4105ms)
✔ sampleRate 字段确实是 24000（0x5DC0），别把 byteRate 抄进去 (0.2191ms)
✔ 实测那次 pcm 的字节数（124426）套出来 RIFF/data 长度对得上 (0.2071ms)
✔ pcmToWav 把数据原样接在头后面，长度正好 44+n (0.3ms)
✔ parseWavHeader 读回自己写的东西，valid 自洽 (0.2647ms)
✔ 长度不是 blockAlign 整数倍就报错，不悄悄补齐 (0.5305ms)
✔ 空 PCM 也能封出一个合法的空 WAV (0.1983ms)
✔ 立体声/别的采样率也算得对 (0.1265ms)
✔ wavHeader 拒绝明显不合法的参数 (0.2556ms)
✔ 常量本身就是 24k 单声道 16bit —— 别改错了没人发现 (0.1828ms)

ℹ tests 86
ℹ suites 0
ℹ pass 86
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1364.5272
EXIT=0
```

补一句：上面 86 行就是原始输出的全文，逐行照抄，没有省略。

### 一个坑

Node 25 起 `node --test test/` 会把 `test/` 当模块路径，直接报
`Error: Cannot find module '...\test'`。`package.json` 里的 `test` 脚本因此写的是
不带参数的 `node --test`（自动发现），Node 22 和 25 都能跑。

## 2. dstts voices（不需要登录）

```
音色列表（本地内置表；不是实时拉的）
  内置表来自逆向 + 2026-09-12 在真实账号上的实测。
  想拉实时的（也顺便拿到全部试听地址）就设 DS_TOKEN 或传 --token。

  mira     贝壳   女  百变活泼   29 种语言  (默认)
  echo     白浪   男  明朗坚定   29 种语言
  stella   海星   女  俏皮甜美   10 种语言
  tide     暗潮   男  低沉浑厚   10 种语言

内置表里实测能下载的试听：
  mira/zh  https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3
  tide/zh  https://cdn.deepseek.com/chat/tts/voice-demos/tide_zh.42b17eef.mp3

注意：CDN 文件名形如 <voice>_<lang>.<hash>.mp3，哈希是每个「音色+语言」各一份、互不相同，
所以 echo / stella 的地址没法拼——必须带登录态问官方音色接口要。
EXIT=0
```

这里要更正任务书里的一个说法：`GET /api/v0/chat/tts/voices` **是要登录态的**。
我实测不带 token / 带垃圾 token 打过去，拿到的都是

```
HTTP 200  {"code":40003,"msg":"INVALID_TOKEN","data":null}
```

（HTTP 状态码是 200，只有 body 里能看出失败。）所以 `dstts voices` 不带登录态时打的是本地内置表，
不是实时接口。带 `DS_TOKEN` 才会走网络。

## 3. dstts demo mira（公开 CDN，真不需要登录）

```
试听 mira/zh（来源：内置表）
  https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3
  下载 OK  HTTP 200  audio/mp3  59.8 KiB
  头 4 字节 49 44 33 04  看着像 MP3
  写到 demo-mira.mp3
EXIT=0
```

ffprobe 认这个文件：

```
$ ffprobe -hide_banner demo-mira.mp3
Input #0, mp3, from 'demo-mira.mp3':
  Duration: 00:00:07.58, start: 0.046042, bitrate: 64 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 24000 Hz, mono, fltp, 64 kb/s, start 0.046042
EXIT=0
```

- 编解码 `mp3`，24kHz 单声道，7.58 秒，61268 字节，ID3 头（`49 44 33`）。
- 顺带说明公网路径和 `cdn.deepseek.com` 是通的。
- 注意 demo 也是 24kHz 单声道，跟 TTS 输出的采样率一致。

`dstts demo tide` 也跑通了（`tide_zh.42b17eef.mp3`，HTTP 200，34.7 KiB，同样是 ID3 开头的 mp3）。
`dstts demo echo` 在没有 token 时给的是明确的人话提示 + `EXIT=1`，不是崩。

## 4. dstts wav（本地 PCM → WAV），再用 ffprobe 验

先造一段已知的 PCM：0.5 秒 440Hz 正弦，24kHz，单声道，s16le，0.5 幅度（不削顶）。

```
PCM 字节数 = 24000  采样数 = 12000
```

```
$ node bin/dstts.mjs wav tone-440-0.5s-24k-mono-s16le.pcm tone-440.wav
tone-440-0.5s-24k-mono-s16le.pcm（23.4 KiB）→ tone-440.wav（23.5 KiB）
  24000Hz / 1ch / 16bit / 12000 采样 / 0.50s
  头自检：RIFF/WAVE/fmt/data 长度自洽
EXIT=0
```

写出来的 44 字节头（十六进制，分组是我加的）：

```
52 49 46 46  e4 5d 00 00  57 41 56 45  66 6d 74 20
10 00 00 00  01 00  01 00  c0 5d 00 00  80 bb 00 00
02 00  10 00  64 61 74 61  c0 5d 00 00
```

对一遍：

| 偏移 | 值 | 含义 |
|---|---|---|
| 0 | `52 49 46 46` | "RIFF" |
| 4 | `e4 5d 00 00` | 0x5DE4 = 24036 = 36 + 24000 ✓ |
| 8 | `57 41 56 45` | "WAVE" |
| 12 | `66 6d 74 20` | "fmt " |
| 16 | `10 00 00 00` | 16 ✓ |
| 20 | `01 00` | PCM ✓ |
| 22 | `01 00` | 单声道 ✓ |
| 24 | `c0 5d 00 00` | 0x5DC0 = 24000 ✓ |
| 28 | `80 bb 00 00` | 0xBB80 = 48000 = 24000×1×2 ✓ |
| 32 | `02 00` | blockAlign 2 ✓ |
| 34 | `10 00` | 16 bit ✓ |
| 36 | `64 61 74 61` | "data" |
| 40 | `c0 5d 00 00` | 24000 ✓ |

ffprobe 认得：

```
$ ffprobe -hide_banner tone-440.wav
Input #0, wav, from 'tone-440.wav':
  Duration: 00:00:00.50, bitrate: 384 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 24000 Hz, 1 channels, s16, 384 kb/s
EXIT=0
```

- `pcm_s16le`、`24000 Hz`、`1 channels`、`s16` —— 跟要求一致。
- 时长 0.50s，跟造的 12000 采样对得上。
- 完整解码一遍也没有告警：`ffmpeg -v error -i tone-440.wav -f null -` 无输出，`EXIT=0`。
  （只验头部是不够的，所以我又让它整个解了一遍。）
- 数据段逐字节比对：`wav 长度 24044 = 44 + 24000 ? true`，
  `第 45 字节起与原 PCM 完全一致? true`。

## 5. dstts probe（不带 token）

```
$ node bin/dstts.mjs probe
Node v25.8.0

本地内置音色表（逆向 + 2026-09-12 实测）：
  mira    贝壳  女  百变活泼  29 种语言  (默认)
  echo    白浪  男  明朗坚定  29 种语言
  stella  海星  女  俏皮甜美  10 种语言
  tide    暗潮  男  低沉浑厚  10 种语言

判决：用不了 —— 缺少登录态。
  设 DS_TOKEN 或者传 --token 再来。怎么拿 token 见 README 的「登录态」一节。
  本包不会去读你的浏览器 cookie / localStorage / LevelDB，这活你自己做。
EXIT=1
```

没有栈、没有 `TypeError`、没有 `Cannot read properties of undefined`，就是一句人话 + 退出码 1。
`--json` 也是同样的判决（`verdict.usable: false`，`reasons[0]` 是缺登录态那句），只是换成结构化输出。

## 6. 其余错误路径（都跑过，都是人话）

```
$ dstts read --session sess-x --message msg-y          # 不带 token
错误（auth）：缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。取 userToken 的办法见 README 的「登录态」一节 —— 本包不会去读你的浏览器数据。
  userToken 从哪来：浏览器登录 chat.deepseek.com 后，localStorage.userToken 里的 value
  （64 字符的不透明串，不是 JWT）。这活你自己做，本程序不去翻你的浏览器数据。
EXIT=1

$ dstts read --message msg-y                           # 缺 --session
错误（usage）：缺参数 --session（会话 id）
EXIT=1

$ dstts voices --nope                                  # 未知选项
参数错误：不认识的选项：--nope

跑 `dstts help` 看用法。
EXIT=2

$ dstts read --session s --message m --format mp3      # 非法格式
参数错误：--format 只支持 pcm / opus，收到 "mp3"

跑 `dstts help` 看用法。
EXIT=2

$ dstts wav odd.pcm odd.wav                            # 9 字节，不是 blockAlign 整数倍
错误（usage）：PCM 长度 9 不是 blockAlign(2) 的整数倍，流可能被截断了
EXIT=1

$ dstts --version
0.1.0
EXIT=0
```

顺带记一个自己发现并修掉的问题：这里原先 `auth` 错误会带上 `code=11(FORBIDDEN)`，
看起来像是服务端拒绝的，其实服务端一个字都没说，是本地判的「没 token」。已经改成不带协议码了。
另外同一个「缺 token」原本库里和 CLI 里两种说法，现在统一成 `MISSING_TOKEN_MESSAGE` 一份。

## 没能验证的部分

按重要性排，这些我确实没验，别当成已知事实：

1. **真实的取票 / 建 ws / 合成，一次都没跑过。** 没有 userToken，这是最大的窟窿。
   `synthesize()` 的正确性目前只有「产物代码 + 2026-09-12 的历史实测记录 + 假 WebSocket 回放测试」
   三层支撑，**没有本次的端到端证据**。拿真 token 先跑 `dstts probe --session <id> --message <id>`，
   那才是判决书。

2. **seq 从 0 开始** —— 是从官方状态机推断的（`receivedSeq` 初值 `-1`、`receivedCount = receivedSeq + 1`），
   没有逐帧抓包确认。实现上没写死起点，所以起点是 0 还是 1 都能工作，但「官方到底从几开始」我没证据。

3. **`received_seq` 到底该发帧数还是最后一个下标** —— 从官方代码读出来是帧数
   （`sendAck(progress.receivedCount, pipeline.playedFrames)`），但 2026-09-12 那次跑通的探针发的是
   最后一个下标，也收全了帧。**服务端两种都收**这个结论是从两个样本对比出来的，没有做对照实验。

4. **ack 是不是必须的** —— 官方每 1000ms 发一次。完全不发会怎样（会不会被服务端掐），没测过。

5. **HTTP 还需要别的头吗** —— 目前只发了 `content-type` / `accept` / `user-agent` / `authorization`。
   官方前端走自己的 http 封装（`withDefaultHttpContext`），可能还带了别的头。没验证过它还认不认。

6. **ws 握手要不要 `Origin`** —— 浏览器必定带，Node 默认不带。本包默认塞一个
   `Origin: https://chat.deepseek.com`（undici 的非标准扩展，塞不进去会静默回退成不带头）。
   服务端是否校验 Origin，不知道。

7. **opus 那条路** —— 只确认了负载是「裸 Opus 包」（依据是 chunk 里三种解码器
   `["wasm","webcodecs","pcm"]`，WebCodecs 那路配置 `{codec:"opus", sampleRate:24000, numberOfChannels:1}`，
   全文没有 `ogg` 字样）。但每个包多少采样、能否独立解码、拼起来能不能封 Ogg，都没试过。
   历史实测的「24 帧 / 7351 字节」我也没有复核。

8. **`echo` / `stella` 的试听地址** —— 拿不到。CDN 文件名里的哈希是「每个音色+语言各一份」的
   内容哈希，实测 `mira_en.79e34098.mp3`、`echo_zh.79e34098.mp3` 都是 404，
   CDN 也不给目录列表（`NoSuchKey`）。所以这两个音色的 demo 只能带 token 走官方接口。

9. **`gender` 字段的原始值**、**stella/tide 的 10 种语言清单**、**`color_palette` 字段** ——
   分别是「只记了归一化结果」「出自逆向备忘未逐语言核对」「这版客户端没映射它」，
   代码里都按这个分寸写的注释。

10. **断线续传** —— `buildTtsUrl` 支持传 `resume` 参数并有单测，但真实的
    「连到一半断了 → 带 audio_id 重连」这条路没跑过，`synthesize()` 也没实现自动续传（断线直接报错）。

11. **额度 / 限流 / 内容过滤（4 / 5 / 12）** —— 错误码名字是从 `main.js` 的枚举里读出来的，
    但这些码真实触发时服务端长什么样，没遇到过。

## 附：验证时落下的文件

```
demo-mira.mp3                       61268 字节，ffprobe 认的 mp3（.gitignore 忽略了 *.mp3）
tone-440-0.5s-24k-mono-s16le.pcm    24000 字节的裸 PCM（*.pcm 已忽略）
tone-440.wav                        24044 字节，上面那个 PCM 套的头（*.wav 已忽略）
```

这三个都是能一条命令重新生成的，删掉不影响任何东西。
