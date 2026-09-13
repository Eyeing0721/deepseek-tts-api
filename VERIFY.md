# 验证记录

本机跑出来的原始输出，不是我复述的。分两轮：第一轮是 TTS 基础（`voices` / `demo` / `wav` /
`probe` / 合成），第二轮加了 `say`（现场造会话+消息）和 PoW。

**顶要紧的一句先放前面**：全程没有 token，所以**任何真正需要登录态的网络路径，一次都没跑过**。
`voices`（内置表）、`demo`（公开 CDN）、`wav`（纯本地）是真的跑通了；
`probe` 只验了"没登录态时给的是人话"；`synthesize()` 的真实网络路径、以及第二轮的整条
`say` 链路，都**没有端到端证据**。别把这份文档当成"能用了"的证明。

## 环境

```
工作目录: D:\eye-labs\deepseek-tts-api
node:      v25.8.0
ffprobe:   ffprobe version 8.1.2-essentials_build-www.gyan.dev (2026)
DS_TOKEN:  unset（全程没设过）
```

复现命令：

```powershell
cd D:\eye-labs\deepseek-tts-api
node --test
node bin/dstts.mjs voices
node bin/dstts.mjs demo mira -o demo-mira.mp3
node bin/dstts.mjs wav tone-440-0.5s-24k-mono-s16le.pcm tone-440.wav
node bin/dstts.mjs probe
```

## 1. node --test

```
✔ 七个子命令都认得 (1.1756ms)
✔ say：位置参数拼成文本，选项各就各位 (0.3436ms)
✔ say：--text 也能给文本 (0.1642ms)
✔ --via 只认 user / reply / auto (0.3016ms)
✔ --header 可以重复给，收成数组 (0.1483ms)
✔ --header 只给一次时也收成数组（省得下游判断两种类型） (0.1066ms)
✔ parseHeaderList 把 "名: 值" 拆开 (0.5516ms)
✔ --max-iterations / --wait 必须是正整数，并且会进 numericOptions (0.2758ms)
✔ read：长短选项混着来 (0.15ms)
✔ demo：位置参数是 voice_id，-o 是输出 (0.1855ms)
✔ wav：两个位置参数 (0.2048ms)
✔ voices 不带任何选项 (0.0832ms)
✔ --out=值 这种内联写法也认 (0.1523ms)
✔ 开关型选项不吃后面的值 (0.1123ms)
✔ --format 只认 pcm / opus (0.1155ms)
✔ --ack-mode 只认 count / index (0.0845ms)
✔ 数字型选项必须是正整数 (0.1328ms)
✔ 不认识的选项报错，但不影响后面的解析 (0.0809ms)
✔ 短选项不认识也报错 (0.0763ms)
✔ 选项后面缺值 (0.0436ms)
✔ 开关型选项带值要报错 (0.0412ms)
✔ -- 之后一律当位置参数 (0.0377ms)
✔ 裸 - 当位置参数，不当选项 (0.0388ms)
✔ 没参数就是 help (0.0504ms)
✔ -h 和 --help 都开 help (0.0542ms)
✔ --version (0.0377ms)
✔ 不是子命令的第一个词会掉进位置参数，command 保持 null (0.0307ms)
✔ 子命令后面再跟一个子命令名，第二个当位置参数 (0.0283ms)
✔ token 能从选项里读到（但别指望它会打印出来） (0.0373ms)
✔ seq 是大端 uint32，不是小端 (1.5271ms)
✔ seq = 0 / 1 这两个边界值读得对（官方状态机 receivedSeq 初值 -1，按 0 起算） (0.1865ms)
✔ payload 是原 buffer 的视图，不是复制 —— 但长度只到帧尾 (0.1216ms)
✔ 带 offset 的 TypedArray 视图也能正确解析（别把整个底层 buffer 当帧） (0.1402ms)
✔ ArrayBuffer 和 Uint8Array 两种入参结果一致 (0.1532ms)
✔ encodeAudioFrame / parseAudioFrame 来回一致 (0.1432ms)
✔ 不足 4 字节的帧要报错，不能硬读 (0.5876ms)
✔ 只有 4 字节（空负载）是合法的，payload 长度 0 (0.1359ms)
✔ 入参不是二进制就报参数错 (0.1778ms)
✔ 顺序到达：每帧立刻吐出来，最后没有 pending (0.5452ms)
✔ 乱序到达：最终 buffer 还是按 seq 排好的，晚到的低 seq 会被记账 (0.2548ms)
✔ 重复帧被丢掉，且不影响拼出来的音频 (0.1778ms)
✔ 缺帧：missing 里点名缺了谁，contiguous 为 false (0.1522ms)
✔ 起始 seq 不是 0 也能过：基准就是第一帧 (0.1611ms)
✔ 中间有洞时，后来补上的帧会跟着前一段一起吐出来 (0.8919ms)
✔ assembleFrames 是个方便入口 (0.206ms)
✔ 空帧集合不炸 (0.0949ms)
✔ 非法 seq（负数/小数/字符串）直接抛 (0.1916ms)
✔ buildTtsUrl 拼出来的 query 跟官方一致，且顺序稳定 (0.2951ms)
✔ buildTtsUrl 带续传参数时补上 audio_id / received_seq / played_seq (0.1296ms)
✔ buildTtsUrl 缺东西时给的是 usage 错误，不是 TypeError (0.1544ms)
✔ DeepSeekHashV1 跟产物 worker 逐位一致（13 组 golden） (3.7121ms)
✔ 输出恒为 64 个十六进制字符 (1.1069ms)
✔ 它既不是 SHA3-256 也不是 Keccak-256 —— node:crypto 替代不了 (0.5819ms)
✔ 空串也有确定的摘要，不是全 0 (0.1423ms)
✔ 同一个输入永远同一个结果（可重复） (0.1639ms)
✔ sponge 的 clone/squeeze 不改原状态（求解器靠这个语义） (0.9352ms)
✔ challenge 能解出预先埋好的答案 (10.8109ms)
✔ prefix 用的是 expire_at，不是 signature —— 这是最容易搞错的地方 (0.7493ms)
✔ camelCase 的 expireAt 也认（官方前端会把它驼峰化） (0.2614ms)
✔ 找不到答案时报清楚的错，不返回半个结果 (1.1315ms)
✔ maxIterations 会截断搜索，并在报错里说清楚 (0.4798ms)
✔ 难度上界只支持正整数 (0.4212ms)
✔ 缺字段 / 算法不对 / 参数不是对象，都要报 protocol 错 (0.3707ms)
✔ PoW 请求头就是 base64(JSON)，字段和官方一一对应 (0.3303ms)
✔ base64 就是标准 base64（web 端 platform=web 时 base64Encode 就是 btoa） (0.1547ms)
✔ powPrefix 就是 salt_expireAt_ 两段下划线 (0.0876ms)
✔ 没有 token：不抛异常，判决里写清楚是缺登录态 (20.9514ms)
✔ 没有 token 时不会去碰网络（把 fetch 换成会炸的也没事） (0.1822ms)
✔ token 无效（40003）：报告里是 auth 失败，仍然不抛 (0.613ms)
✔ token 长度不对会留一条 note，但不拦 (0.2334ms)
✔ --no-ws 时试连被跳过，理由写明白 (0.3722ms)
✔ buildRepeatPrompt 里带上了原文，并且明确要求原样输出 (1.1912ms)
✔ messageText 兼容 string / 对象 / 空 (0.2028ms)
✔ isUserMessage：role 是字符串时按 role，认不出来时退回正文比对 (1.0206ms)
✔ pickMessage 按 want 挑人，且不依赖 role 枚举 (0.2418ms)
✔ pickMessage 在回复还没长出来时不硬挑 (0.1313ms)
✔ pickMessage 忽略没有 id 的条目 (0.1038ms)
✔ putText(via=user)：建会话 → 解 PoW → 发文本 → 拿 user message_id (5.0483ms)
✔ putText(via=reply)：发的是复述提示语，挑回来的是模型那条 (4.6329ms)
✔ putText：等不到消息就报错，并把会话里实际有什么打出来 (65.9771ms)
✔ putText：completion 返回非 2xx 要报错 (0.7329ms)
✔ putText：参数不对走 usage 错 (0.3308ms)
✔ say(via=user)：整条链路 + 念完把临时会话删掉 (3.0469ms)
✔ say(--keep)：不删会话 (0.8542ms)
✔ say(via=auto)：user 念不了（code=6）就自动换 reply 重来 (701.3901ms)
✔ say(via=user)：念不了就直接抛，不偷偷换 (1.0446ms)
✔ say：塞消息那步就失败时，会话照样被清掉 (703.2916ms)
✔ say：没有 token 直接 auth 错，一个请求都不发 (0.2093ms)
✔ 顺利跑完：收帧、拼装、时长、元数据都对 (4.7117ms)
✔ onChunk 拿到的顺序就是 seq 顺序 (0.7756ms)
✔ 重复帧丢掉，计数如实；音频不受影响 (0.6993ms)
✔ 有洞就报错，不交一个错位的音频出去 (1.7307ms)
✔ 服务端 finish 带错误码 -> protocol 错误，码和名字都在 (0.7768ms)
✔ 一帧都没收到就 finish -> 报错，不给空文件 (0.4644ms)
✔ 连接 1006 断掉、零帧 -> 提示 ticket 可能已经用过 (0.4841ms)
✔ 服务端把 format 改成别的 -> 听服务端的，并留一条 warning (0.4591ms)
✔ ackMode=count 时 received_seq 发的是「帧数」（官方口径） (54.338ms)
✔ ackMode=index 时 received_seq 发最后一个 seq（省事口径） (46.2428ms)
✔ 没有 token -> auth 错误，文案里说清楚缺什么 (12.6825ms)
✔ token 无效（40003）-> auth 错误，带上服务端原话 (0.221ms)
✔ 取票返回 biz_code 9（未放行）-> protocol 错误 (0.1329ms)
✔ 参数不全走 usage 错误，不是 TypeError (0.2196ms)
✔ 传了 voice 就先切音色，而且切音色发生在取票之前 (0.3959ms)
✔ 每次建连都重新取票（票是一次性的，两次连就是两张） (0.3362ms)
✔ AbortSignal 能中断，且走的是 abort 事件 (32.2593ms)
✔ 非 JSON 的文本帧只记 warning，不炸 (0.5121ms)
✔ 正好四个音色，id 就是这四个 (2.2887ms)
✔ 中文名 / 性别 / 描述 逐个对 (0.3461ms)
✔ 语言数：贝壳/白浪 29，海星/暗潮 10 (0.1136ms)
✔ 默认音色只有 mira 一个 (0.1271ms)
✔ 内置的试听地址只有实测过的那两个，而且是 https + .mp3 (0.3702ms)
✔ 两个哈希是各自独立的 —— 别以为换个音色名就能拼出来 (0.1897ms)
✔ getVoice 大小写不敏感，空值/未知给 undefined (0.1524ms)
✔ 表是冻结的，防止运行时被改 (0.4284ms)
✔ 错误码表就是 main.js 里那 13 个，一个不多一个不少 (0.202ms)
✔ codeName / isSuccessCode / codeHint 行为正确 (0.3872ms)
✔ 44 字节头，8 字节数据：逐字节对上手工算的期望 (1.6818ms)
✔ sampleRate 字段确实是 24000（0x5DC0），别把 byteRate 抄进去 (0.1971ms)
✔ 实测那次 pcm 的字节数（124426）套出来 RIFF/data 长度对得上 (0.1504ms)
✔ pcmToWav 把数据原样接在头后面，长度正好 44+n (0.5029ms)
✔ parseWavHeader 读回自己写的东西，valid 自洽 (2.6689ms)
✔ 长度不是 blockAlign 整数倍就报错，不悄悄补齐 (0.6536ms)
✔ 空 PCM 也能封出一个合法的空 WAV (0.2813ms)
✔ 立体声/别的采样率也算得对 (0.1442ms)
✔ wavHeader 拒绝明显不合法的参数 (0.6319ms)
✔ 常量本身就是 24k 单声道 16bit —— 别改错了没人发现 (0.5992ms)
ℹ tests 126
ℹ suites 0
ℹ pass 126
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1623.0225
```

## 2. 第一轮：TTS 基础

### dstts voices（不需要登录）

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
实测不带 token / 带垃圾 token 打过去，拿到的都是

```
HTTP 200  {"code":40003,"msg":"INVALID_TOKEN","data":null}
```

（HTTP 状态码是 200，只有 body 里能看出失败。）所以 `dstts voices` 不带登录态时打的是本地内置表，
不是实时接口。带 `DS_TOKEN` 才会走网络。

### dstts demo mira（公开 CDN，真不需要登录）

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

### dstts wav（本地 PCM → WAV），再用 ffprobe 验

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

写出来的 44 字节头（十六进制）：

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
- 数据段逐字节比对：`wav 长度 24044 = 44 + 24000 ? true`，
  `第 45 字节起与原 PCM 完全一致? true`。

### dstts probe（不带 token）

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

### 其余错误路径

```
$ dstts read --session sess-x --message msg-y          # 不带 token
错误（auth）：缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。取 userToken 的办法见 README 的「登录态」一节 —— 本包不会去读你的浏览器数据。
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
```

## 3. 第二轮：PoW（这一轮唯一硬的东西）

`dstts say` 这条路必须先过工作量证明。算法 `DeepSeekHashV1` 是自定义哈希，
既不是 SHA3-256 也不是 Keccak-256，`node:crypto` 替不了。所以我把产物自己的 PoW worker
用 `node:vm` 起起来当参照物，逐位对拍。

做法（`node:vm` + 一个假的 `self`/`postMessage`/`fetch`）：

- WASM 版 worker：`static/37627.ebf6d8f55d.js` + `static/sha3_wasm_bg.7b9ca65ddd.wasm`
- JS 版 worker：`static/76608.8f2a9fa413.js` + polyfill `static/8138.63461459c3.js`
  （文件名是从 `main.js` 里的 chunk 映射表 `h.u` 解出来的）

跑出来的原文：

```
JS worker: function WASM worker: function

=== 1) DeepSeekHashV1 逐位对拍 ===
  OK   len=  0 ""
  OK   len=  3 "abc"
  OK   len= 11 "hello world"
  OK   len= 20 "SALT_1789318365550_0"
  OK   len=  4 "中文测试"
  OK   len=135 "xxxxxxxxxxxxxxxxxxxxxxxx"...
  OK   len=136 "yyyyyyyyyyyyyyyyyyyyyyyy"...
  OK   len=200 "zzzzzzzzzzzzzzzzzzzzzzzz"...
  OK   len= 13 "1789318760524"
  一致 9/9
  随机串对拍: 一致 120/120，不一致 0

=== 2) 用我的哈希出题，看产物 worker 认不认 ===
  #0 i0=1418  JS=1418  WASM=1418
  #1 i0=943  JS=943  WASM=943
  JS worker 解出 10/10，WASM worker 解出 10/10
```

结论：

- `src/deepseek-hash.mjs` 跟产物的 JS 实现 **9/9 + 120/120 逐位一致**（135/136/200 覆盖了
  rate=136 的翻页边界）。
- 拿本包的哈希出的题，产物的 **JS worker 和 WASM worker 各 10/10** 解得出来 —— 说明两个实现
  是同一个算法，抄 JS 那份是安全的。
- 反过来的对照：拿**标准 SHA3-256** 出的题，两个 worker 都 **0/8** 解不出来。
  这就是"它不是 SHA3-256"的证据。

13 组 golden vector 已经固化进 `test/pow.test.mjs`，所以以后改坏了会立刻红，
不用再联网拉产物。

一个差点栽进去的坑：**prefix 用的是 `expire_at`，不是 `signature`**。
官方 `})(e,r,n,i,s)` 而参数签名是 `(t,e,r,n,i)`，第 5 个位置传的是 `expireAt`。
我一开始按 `salt_signature_i` 拼，怎么都对不上（两个 worker 都 0/25），
换成 `salt_expireAt_i` 立刻全中。

## 4. 第二轮：say 的 CLI 行为

```
$ dstts say "你好世界"                       # 不带 token
错误（auth）：缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。取 userToken 的办法见 README 的「登录态」一节 —— 本包不会去读你的浏览器数据。
EXIT=1

$ dstts say                                  # 没给文本
错误（usage）：say 需要文本：`dstts say "要念的内容"` 或者 --text "..."
EXIT=1

$ dstts say x --via nope
参数错误：--via 只支持 user / reply / auto，收到 "nope"
EXIT=2

$ dstts say x --header "没有冒号"
错误（usage）：--header 得写成 "名字: 值" 的形式，收到 "没有冒号"
EXIT=1
```

`dstts help` 里 `say` 那两行：

```
  dstts say <文本> [-o out.wav]                  随便给一段文本，现场造一个一次性会话念出来
             [--voice mira] [--via user|reply|auto] [--keep]
```

**真实链路没跑过**（没 token）。`say` 的整条离线链路（建会话 → PoW → completion → history →
合成 → 删会话）是用假 fetch + 假 WebSocket 演的，17 个用例覆盖了 `--keep`、`auto` 回退、
失败时清理会话这些分支 —— 但那只能证明"按我理解的协议，代码会发这样的请求"。

## 5. 第二轮回归（确认没把第一轮搞坏）

```
$ dstts demo mira -o demo-mira.mp3
试听 mira/zh（来源：内置表）
  下载 OK  HTTP 200  audio/mp3  59.8 KiB
  写到 demo-mira.mp3
EXIT=0

$ ffprobe demo-mira.mp3
codec_name=mp3 / sample_rate=24000 / channels=1 / duration=7.577375

$ dstts wav tone-440-0.5s-24k-mono-s16le.pcm tone-440.wav
  24000Hz / 1ch / 16bit / 12000 采样 / 0.50s
$ ffprobe tone-440.wav
codec_name=pcm_s16le / sample_rate=24000 / channels=1 / bits_per_sample=16 / duration=0.500000

$ dstts probe          # 无 token
判决：用不了 —— 缺少登录态。
EXIT=1
```

## 没能验证的部分

按重要性排，这些我确实没验，别当成已知事实：

1. **真实的取票 / 建 ws / 合成，一次都没跑过。** 没有 userToken。`synthesize()` 的正确性目前只有
   「产物代码 + 2026-09-12 的历史实测记录 + 假 WebSocket 回放测试」三层支撑，
   **没有本次的端到端证据**。拿真 token 先跑 `dstts probe --session <id> --message <id>`。

2. **`say` 整条链路一次都没在真账号上跑过。** 建会话、取 challenge、发 completion、拉 history、
   删会话 —— 请求体和请求头都是从产物抄的，但服务端认不认没人验过。
   这是第二轮的第二个大窟窿。

3. **PoW 只对拍了"客户端实现"，没对拍过"服务端要什么"。**
   我证明了本包的哈希跟产物 worker 逐位一致，也证明了产物两个实现一致；
   但**服务端是不是按同一套算**，没有任何直接证据（那需要真 challenge）。
   间接理由是：客户端在线上是能用的，所以服务端必然认它这套。这条推理成立与否你自己判断。

4. **`via=user` 到底能不能念。** 服务端肯不肯念一条用户消息，只能真机试，被拒大概是
   `code=2` 或 `code=6`。本包默认 `auto` 就是为这个准备的，但回退路径本身也没在真机上验过。

5. **`difficulty` 的真实量级。** 服务端给多大的搜索上界完全未知（本地合成题只用到几千）。
   本包默认上限 500 万次迭代，超了会明确报错而不是无限跑。

6. **缺不缺指纹头。** 官方前端在 completion 上还带 `x-hif-leim` / `x-hif-dliq` /
   `x-client-*` 这些浏览器指纹头，本包不伪造。服务端哪天真要，用 `--header` 自己塞。

7. **seq 从 0 开始** —— 从官方状态机 `receivedSeq = -1` / `receivedCount = receivedSeq + 1`
   推断的，没有逐帧抓包确认。实现没写死起点，0 还是 1 都能工作。

8. **`received_seq` 到底该发帧数还是最后一个下标** —— 从官方代码读出来是帧数，
   但 2026-09-12 那次跑通的探针发的是最后一个下标，也收全了帧。**服务端两种都收**这个结论
   是两个样本对比出来的，没做对照实验。

9. **ack 是不是必须的** —— 官方每 1000ms 发一次。完全不发会怎样（会不会被掐），没测过。

10. **HTTP 还需要别的头吗** —— 目前只发了 `content-type` / `accept` / `user-agent` /
    `authorization` / `x-ds-pow-response`。

11. **ws 握手要不要 `Origin`** —— 浏览器必定带，Node 默认不带。本包默认塞一个
    （undici 非标准扩展，塞不进去会静默回退）。服务端是否校验，不知道。

12. **opus 那条路** —— 只确认了负载是裸 Opus 包（依据是 chunk 里解码器链
    `["wasm","webcodecs","pcm"]` 和 WebCodecs 的 `{codec:"opus",sampleRate:24000,numberOfChannels:1}`，
    全文没有 `ogg` 字样）。每个包多少采样、能否独立解码、拼起来能不能封 Ogg，都没试过。

13. **`echo` / `stella` 的试听地址** —— 拿不到。CDN 文件名里的哈希是「每个音色+语言各一份」的
    内容哈希（`mira_en.79e34098.mp3`、`echo_zh.79e34098.mp3` 实测都是 404），CDN 也不给目录列表。

14. **`role` 的枚举值** —— 只知道客户端写的是 `role === MessageRole.ASSISTANT ? ASSISTANT : USER`，
    具体值没记。所以选消息时**不依赖 role**，用「正文恰好等于我发的 prompt」这个判据。

15. **断线续传** —— `buildTtsUrl` 支持传 `resume` 参数并有单测，真实断线重连没跑过，
    `synthesize()` 也没实现自动续传（断线直接报错）。

16. **额度 / 限流 / 内容过滤（4 / 5 / 12）** —— 错误码名字是从 `main.js` 的枚举里读出来的，
    真实触发时服务端长什么样，没遇到过。

## 附：验证时落下的文件

```
demo-mira.mp3                       61268 字节，ffprobe 认的 mp3（.gitignore 忽略了 *.mp3）
tone-440-0.5s-24k-mono-s16le.pcm    24000 字节的裸 PCM（*.pcm 已忽略）
tone-440.wav                        24044 字节，上面那个 PCM 套的头（*.wav 已忽略）
```

这三个都是能一条命令重新生成的，删掉不影响任何东西。

产物那几个 chunk（`main.*.js`、`76608.*.js`、`37627.*.js`、`8138.*.js`、`sha3_wasm_bg.*.wasm`）
只在系统临时目录里放着做对拍用，**没有进仓库** —— 那是别人的代码，不该往里塞。
golden vector 已经把结论固化了。
