# deepseek-tts-api

让 DeepSeek 把话**念出来**。

躺着的时候、走路的时候、眼睛累了不想看字的时候——它念给你听喵。

DeepSeek 网页版本来就有个朗读按钮，只是藏得比较深，而且还在灰测。这个小工具把那个按钮背后
的东西单独拎出来了，所以你能：

- 让它念刚跟你说的那段话
- 让它念**你自己写的句子**（晚安、加油、随便什么）
- 换四个不同音色，男的女的都有
- 把声音存成文件，想听几遍听几遍

不需要懂代码，跟着下面走就行。

---

## 先装一个东西

要装个 Node.js。免费，官网下载，一路「下一步」就好：

👉 https://nodejs.org/

装完之后，打开终端：

- **Windows**：按 `Win + R`，输入 `powershell`，回车
- **Mac**：按 `Command + 空格`，输入 `terminal`，回车

然后把这行粘进去，回车：

```
npx github:Eyeing0721/deepseek-tts-api help
```

出来一堆说明，就说明装好了喵。（第一次会下载，等十几秒。）

---

## 登录一次就好

这个工具要用你自己的 DeepSeek 账号，所以得给它一个「通行证」。

这一步最烦，但一辈子只用做一次，忍一下 🐟

1. 电脑浏览器打开 **chat.deepseek.com**，确认是登录状态
2. 按 **F12**（Mac 是 `Option + Command + I`），右边会弹出一个面板
3. 找到上面的 **Console**（中文版叫「控制台」）标签，点它
4. 把下面这行**粘进去**，回车：

   ```js
   JSON.parse(localStorage.getItem('userToken')).value
   ```

5. 会吐出来一串东西，大概这么长：`AbCd1234...`（64 个字符）
6. **把它整个复制下来**，别带引号

> 如果它不让你粘贴，先在 Console 里手打 `allow pasting` 回车，再粘。

拿到这串东西之后，在终端里这样用（把 `你的通行证` 换成刚复制的那串）：

```
# Windows（PowerShell）
$env:DS_TOKEN = '你的通行证'

# Mac
export DS_TOKEN='你的通行证'
```

关掉终端就没了，下次要重新设。嫌麻烦可以写进系统环境变量，不细说了喵。

**这串东西只在你自己的电脑上跑**，不会上传到任何地方，程序也不写文件、不打日志。
不信可以翻 `src/http.mjs`，很短。

---

## 想听什么就让它念

```
dstts say "今天辛苦了，早点睡。"
```

等一下下，声音就出来了（大概三秒）。

一次念长一点也行：

```
dstts say "很久很久以前……" -o 故事.wav
```

加 `-o` 就会存成文件；不加的话存成 `ds-say-时间戳.wav`，就在你当前所在的文件夹里。

换音色：

```
dstts say "晚安喵" --voice tide
```

### 它其实是怎么做到的

DeepSeek 的朗读接口有个奇怪的限制：**你只能告诉它「念哪条消息」，不能直接给它文本。**

所以 `say` 会偷偷在你会话列表里建一个临时会话，把你给的句子发进去，让它念，念完立刻删掉。
干净利落，不留痕迹。

偶尔你可能会在会话列表里瞥见它一闪而过，别慌喵。

---

## 四个音色

先试试哪个合你耳朵：

| 名字 | 音色 | 感觉 |
|---|---|---|
| `mira` | 贝壳 ♀ | 百变活泼（默认） |
| `echo` | 白浪 ♂ | 明朗坚定 |
| `stella` | 海星 ♀ | 俏皮甜美 |
| `tide` | 暗潮 ♂ | 低沉浑厚 |

试听要下载，一条命令：

```
dstts demo tide -o 试听.mp3
```

`mira` 和 `echo` 会说 29 种语言，`stella` 和 `tide` 会说 10 种（包括粤语）。
念中文四个都行。

---

## 其他能干的

```
dstts voices                              看四个音色的详细信息
dstts probe                               检查一下能不能用
dstts say "..." --voice tide -o out.wav   指定音色并存文件
dstts say "..." --keep                    念完别删临时会话
dstts help                                所有用法
```

想让它念**已经聊过的某条回答**（而不是自己写句子），用 `read`：

```
dstts read --session <会话id> --message <消息id> -o out.wav
```

会话 id 在网页地址栏里，`/a/chat/s/` 后面那一串。

---

## 万一出问题

出错了它会说人话，照着对一遍：

**「缺少登录态」** → 通行证没设上，回头看「登录一次就好」那节。

**「token 无效或已过期」** → 重新去浏览器复制一次。登出过、换过设备都会失效。

**「朗读额度用完了（今日限额）」** → 今天念太多了，明天再来喵。

**「请求太频繁，被限流了」** → 念太快了，歇两分钟。

**「这条消息没有可朗读的正文」** → 加 `--via reply` 重试，让它先复述一遍再念。

**「服务端未对该账号放行」** → 朗读还在灰测，没轮到你。这个真没办法，只能等。
先跑一下 `dstts probe`，它会把每一步的结果都打出来，不会莫名其妙地失败。

**「内容被安全过滤挡了」** → 换句话试试。

**声音存下来打不开** → 默认是 WAV，双击就能播。如果你手动加了 `--format opus`，
那个格式官方给的是「裸包」，普通播放器不认，去掉就好。

---

## 给自己写点代码玩

上面那些都不用看，下面的给会写 JS 的人喵。

```js
import { writeFile } from 'node:fs/promises';
import { synthesize, pcmToWav } from 'deepseek-tts-api';

const r = await synthesize({ sessionId: '...', messageId: '...' });
await writeFile('out.wav', pcmToWav(r.audio));
```

`synthesize()` 返回音频 Buffer 和一堆元信息（帧数、时长、有没有缺帧、服务端实际给的格式……
完整字段见 `docs/PROTOCOL.md`）。想一边收一边播就用 `onChunk`。

还有 `issueTicket` / `listVoices` / `setVoice` / `probeProtocol` / `resolveDemoUrl` 可以用，
想知道服务端到底在干什么，`docs/PROTOCOL.md` 里全写着。

出错统一是 `DeepSeekTtsError`，带 `kind` 和 `code`：

```js
catch (e) { e.kind; e.code; e.codeName; e.describe(); }
```

---

## 它不知道的两件事

**账号可能没被放行。** 朗读还在灰测，不是所有人都开了。这不是这个工具能解决的，得等官方。

**协议随时会变。** 这东西是照着网页版的实现逆出来的，官方一改就可能失效。到时候提 issue 喵。

其他已知的坑（票只能用一次、错误码都是什么意思、opus 为什么不带容器）都写在
`docs/PROTOCOL.md` 和 `VERIFY.md` 里，想深挖可以翻。

---

## 关于我喵

我是 [@Eyeing0721](https://github.com/Eyeing0721)，主页在 **https://0721.luxe/**。

写这个是因为我自己想听。官方只给了个按钮，藏在灰测里，那就自己拆出来。
写着写着觉得还挺顺手，就整理出来放这儿了。

要是它陪你过了几个晚上，来主页请我喝杯奶茶喵 🐟

---

## 免责

非官方小工具，跟 DeepSeek 没有任何关系，也没得到他们认可。

只拿来自己听，别拿去批量刷。账号是你自己的，被封了我也没办法喵。

MIT，版权 Eyeing0721。
