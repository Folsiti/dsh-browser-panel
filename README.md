# dsh-browser-panel

DeepSeek Harness 插件：**弹出一个真正的浏览器窗口，明确标注是 AI 的，并让模型直接操作它。**

模型通过 Chrome DevTools Protocol 驱动这个窗口：导航、读页面、点击、输入、按键、截图、执行脚本。
窗口是可见的，你可以全程看着 AI 在做什么；需要时也能直接上手接管。

**v0.17.0 起不再使用右侧栏的 Browser 标签页**，插件里也没有渲染层那一半了。
原因见文末「为什么不再动侧栏的 webview」。**v0.18.0 起窗口会自报身份**，见「让用户一眼看出这是 AI 的浏览器」。
**v0.19.0 起不再假设你装了什么浏览器**，见「机器上没有浏览器怎么办」。
**v0.19.2 起不再把「启动器退出」当成失败**，见「浏览器进程的生命周期」。
**v0.20.0 起每个 agent 最多只有一张页面**，页面角标写明负责人，agent 结束后页面保留、后来者可以接手，见「一个 agent 一张页面」。
**v0.20.1 修掉真机首测发现的两个可用性问题**：系统提示词里那条规则之前没真正注入；`browser_panel_status` 现在每页都打印 `(id: …)`，模型能直接拿它 `adopt`。
**v0.21.0 起截图默认是干净的**：角标和琥珀边框照常显示在窗口里，但 `browser_panel_screenshot` 截出的 PNG 里没有它们（`screenshot: marked` 可换回旧行为），见「截图模式」。

## 安装

DSH 的插件由 profile 管理（装进 `~/.dsh/profiles/<profile>/` 并登记到 `dsh.profile.bundles`），所以走 DSH 自己的插件页安装：

1. 侧栏**插件** → **添加插件**（或箭头菜单里的**安装第三方插件**）；
2. 输入包名 `@folsiti/dsh-browser-panel`，可带版本（如 `@folsiti/dsh-browser-panel@0.21.0`）；
3. 选**安装源**（npm 官方源 / 中国大陆镜像源），点**安装**；
4. 装完即生效（profile 开了 HMR 时不用重启；没开则重启 DSH）。

不想走 npm（或者要装本地改动版）也可以，同一个「添加插件」对话框接受：

- **Git 地址**：`https://github.com/Folsiti/dsh-browser-panel`
- **本地绝对路径**：`D:\项目\dsh-browser-panel`（本地目录是 `link:` 安装，改完要重启 DSH 才生效）

一次安装会做三件事：把包写进 profile 的 `package.json` 依赖、加进 `dsh.profile.bundles`、套用包里的 `cordis.patch.yml`。
**只把文件拷进 `plugins/` 目录是不会生效的** —— 这是早期版本 README 写错的地方。

## 九个工具

| 工具 | 作用 |
|---|---|
| `browser_panel_status` | 只读：窗口是否在跑、浏览器版本与路径、pid、调试端口、profile 目录、**窗口名与身份层模式**、窗口矩形、所有标签页（含标记标签页）**各自的负责人、负责人是否还在运行**、本会话绑定的是哪个。**不会启动浏览器** |
| `browser_panel_open` | 启动（如未启动）并加载 URL。**只导航本 agent 已有的页面，不会再开第二个标签页**；`adopt` 可以接手一个负责人已结束的页面（规格见「一个 agent 一张页面」）。窗口自报身份的四层标识见下文 |
| `browser_panel_snapshot` | 读页面：地址、标题、可见文本、可交互元素大纲（带 `ref`） |
| `browser_panel_click` | 按 CSS 选择器或可见文字点击。文字匹配先找 `a`/`button`/带 role 的元素，找不到再退回**任意可见元素里标签完全相同的那个**（于是纯 `<div onclick>` 做的控件也能点到），并取最深的节点避免点到外层容器 |
| `browser_panel_type` | 聚焦输入框并插入文本（`Input.insertText`），可先全选替换（Ctrl/Cmd+A），可 `submit` 回车 |
| `browser_panel_press` | 发送真实按键（Enter / Tab / Escape / 方向键 / PageUp / PageDown / Home / End / Backspace / Delete / Space / 单字符） |
| `browser_panel_navigate` | `back` / `forward` / `reload` |
| `browser_panel_eval` | 在主框架执行一段 JS（async 函数体），返回 JSON 值 |
| `browser_panel_screenshot` | CDP 截图成 PNG 写盘，返回路径与真实像素尺寸。默认 `screenshot: clean`：角标与琥珀边框留在窗口里，但不进图 |

工具返回的都是**结构化 JSON**（PTC 模式下模型看到的是生成 SDK，返回文本会被丢掉），
所以每个工具都声明了 object 根、且 `required` 与 `properties` 完全一致。

## 工作方式

```
工具调用 ──ensureBrowser()──▶ spawn msedge/chrome --remote-debugging-port
         ──attach()────────▶ 每个标签页一条 CDP WebSocket，按 agent id 绑定
         ──send(method)────▶ Page.navigate / Runtime.evaluate / Input.*
```

- 插件主机半边跑在 **DSH 的 Node 运行时进程**里（不是 Electron 主进程），所以它能 `spawn`，也能开 WebSocket。
- Node 24 自带 `fetch` 与 `WebSocket`，**零依赖**讲 CDP：不需要 puppeteer / playwright。
- 首次需要页面的工具调用才会拉起浏览器；`status` 永远只报告，绝不意外弹窗。
- DSH 退出或插件卸载时，浏览器进程会被收掉（Windows 上 Chromium 的子进程随主进程一起走）。

## 浏览器进程的生命周期

这条链路比看起来复杂，因为「我 spawn 的那个进程」和「真正在跑的浏览器」不一定是同一个。

### 端口由浏览器自己记录

插件用 `--remote-debugging-port=0` 启动浏览器，Chromium 会把挑好的端口写进 profile 里的
`DevToolsActivePort`。这比插件自己先找一个空闲端口再传进去更稳：

- 没有「探测到绑定」之间的竞态；
- **这是唯一能找到一个「已经在跑」的浏览器的办法** —— 否则它的端口只有它自己知道。

`debugPort` 设成固定值时仍然按固定端口走（给需要手工挂第二个 CDP 客户端的人用），只是就不写这个文件了。

### 接管上一代留下的浏览器

插件崩溃、DSH 被强杀、或者上一次运行没收尾，都可能留下一个仍在跑、仍占着 profile 的浏览器。
这时新进程去启动只会**把请求转交给它然后自己退出**，不可能再开第二个。

所以插件启动前会先读 `DevToolsActivePort`：端口有应答就**直接接管**，`status.reused` 为 `true`。
接管后 `browser_panel_status` 里的 `pid` 为 0（不是它生的），退出时用 CDP 的 `Browser.close` 让它自己关。
标记标签页也会复用已经存在的那一个，而不是每次接管都多一个。

### 「启动器退出」不等于「浏览器没起来」

Edge 155 起，`msedge.exe` 可能是**启动器**：它把真正的浏览器进程拉起来，自己以退出码 0 退出。
所以判断成败的依据从「子进程是否存活」改成了「调试端口是否应答」：

- 子进程退出码 0 → 继续等端口（浏览器可能正在起）；
- 子进程退出码非 0 → 立刻失败，附上它自己的输出；
- 一直等到超时都只有「转交」没有端口 → 报 `handoff`，并直接说下一步：
  **这个 profile 被一个没有调试端口的浏览器占着（比如你手工打开的那个），关掉它再试**。

## 机器上没有浏览器怎么办

插件需要**一个 Chromium 系浏览器**（Chrome / Chromium / Edge / Brave / Vivaldi / Opera）。
Firefox 和 Safari 用的是另一套协议，**不可能**被这个插件驱动 —— 这句话会直接写在报错里。

### 一、先找：五层发现，每层都记来源

| 层 | 找什么 | `status` 里的 `browserSource` |
|---|---|---|
| 1 | `browserPath`（行配置）。**裸命令名会在 `PATH` 里查**，所以 `browserPath: chrome` 是对的写法 | `config` |
| 2 | 环境变量 `DSH_BROWSER_PANEL_BROWSER` | `environment` |
| 3 | 平台惯用安装路径：Windows 的 Edge/Chrome/Brave/Vivaldi/Opera 各频道、Scoop、winget links；macOS 的 `/Applications`、Canary、Arc、Homebrew；Linux 的 `/usr/bin`、`/opt`、flatpak exports、nix profiles | `known-path` |
| 4 | `PATH` 上的可执行名 | `path` |
| 5 | 机器上**已经下载过的** Playwright / Puppeteer 浏览器缓存，包括插件自己下载的那份 | `browser-cache` |

找到多个时按「最不容易坏」排序：**原生安装优先于 snap / flatpak** —— 后两者跑在各自的
confinement 里，需要额外照顾 profile 位置才不崩。`browser_panel_status` 会把找到的**每一个**都列出来，
所以你随时能挑一个用 `browserPath` 钉住。

### 二、找不到：加载时检测，使用时在 DSH 界面里问

按你的要求，流程是这样：

1. **插件加载时**就做一次检测（纯文件系统检查，不问任何人、不启动任何东西），结果记在日志和 `status` 里。
   为什么这里不问？因为 DSH 的提问通道**只接受带活跃 agent 的请求**，而插件加载时没有 agent ——
   这是 `dsh-user-questions` 的硬约束，不是偷懒。
2. 第一次真正要用浏览器时（`browser_panel_open`），如果还是没有，就在 **DSH 界面里弹一个问题**
   （接管聊天输入框的那种提问卡片），两个选项：

   > **需要浏览器**：这台机器上找不到可以自动化的浏览器（Chrome / Chromium / Edge / Brave 都没有）。要我现在下载一个吗？
   >
   > - **下载一个 Chrome for Testing (Recommended)** —— 官方稳定版，约 **196 MB**，放进 `~/.dsh/browser-panel/browsers/`，不动你系统里的任何浏览器
   > - **不用了，先停用这个插件** —— 插件保持停用，不再询问

3. **选下载**：取 Google 官方的 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
   稳定版（`fetch` + `zlib` 自己解包，**不需要 npm / pnpm / 任何包管理器**，也不需要管理员权限），
   解压时逐条目校验 CRC（下载被截断会明确报「checksum mismatch」而不是给你一个跑不起来的浏览器），
   装完**直接接着把原来那次 `browser_panel_open` 做完**。
4. **选停用**：记住这个决定（`~/.dsh/browser-panel/state.json`），之后每次调用都立刻失败并说明原因，
   **不会再问第二遍**。
5. **自己装**：随时都行。每次要用之前都会重新发现一次，**不需要重启 DSH**，
   而且发现到浏览器后会自动解除之前的停用状态。
6. **关掉提问卡片 / 跳过**：不算拒绝，只是这次不下载，下次需要时还会问。

`provision: auto` 可以跳过提问直接下载（无人值守用），`provision: never` 则从不询问也从不下载。

### 三、Linux：真正会咬人的五个坑

「Linux 上没有 Edge」根本不是问题（本来就没有）。真正会让插件默默失败的是这些，都有对应处理：

| 环境 | 现象 | 处理 |
|---|---|---|
| 没有 `DISPLAY` / `WAYLAND_DISPLAY`（服务器、容器、SSH） | Chromium 直接退出 | **自动降级为 headless**，`status.headlessReason` 与 `open.note` 写明原因。CDP 截图、读写、点击全都照常，只是没有窗口 |
| 以 root 运行（容器里很常见） | Chromium 拒绝启动 | 自动加 `--no-sandbox`，并在 `status.noSandbox` 里明说「渲染进程沙箱被关掉了」 |
| snap 版 Chromium | AppArmor 拒绝对 `~/.dsh/…` 的写入 | profile 自动落到 `~/snap/<name>/common/dsh-browser-panel/` |
| flatpak 版 | 只允许 `~/.var/app/<id>/` | profile 自动落到 `~/.var/app/<id>/config/dsh-browser-panel/` |
| 老 Chromium（< 112）不认 `--headless=new` | 启动即退出 | 自动用老的 `--headless` 重试一次 |

另外 WSL 会提示「窗口会开在 Windows 那一侧」，因为那时你在另一侧看不到它。

### 四、失败也有分类，不再只有一句话

`browser_panel_open` 的失败现在分四类，每类都带下一步：

| 类型 | 什么时候 | 报错里有什么 |
|---|---|---|
| `missing` | 五层全空 | 找过哪些路径、**该平台的一条安装命令**、两个覆盖手段、「Firefox 不行」 |
| `not-executable` | `browserPath` 指向的不是可执行文件（Linux 上还检查执行位） | 具体路径 + `chmod +x` 提示 |
| `exited` | 启动了但立刻退出 | **浏览器自己的 stderr**、退出码、环境备注，以及「这是 snap/flatpak/缺库/无显示器/root 的典型形状」 |
| `silent` | 活着但调试端口不响 | stderr、`debugPort` 建议 |

浏览器的输出是通过**临时文件**而不是管道抓的 —— 管道在受限运行模式下会被直接拒绝，
而一个读不到 stderr 的浏览器，就是一个没法解释自己为什么失败的浏览器。

（真实对比：以前指向一个非浏览器时，245 ms 后只有一句 `the browser window closed (exit code 2)`；
现在同一次失败会告诉你它是 `where.exe`、退出码 2、输出是 `ERROR: Invalid pattern is specified`。）

## 让用户一眼看出这是 AI 的浏览器

开箱状态下它和一个普通 Edge 窗口长得一样：同样的图标、同样的标题栏。所以插件从**桌面**一路标到
**页面内容**，叠了四层标识，用户往哪儿看都能认出来。

| 层 | 用户看到什么 | 靠什么实现 |
|---|---|---|
| 1. 系统窗口标题 | `页面标题 - AI 浏览器 - Microsoft Edge`；任务栏悬浮提示、Alt-Tab 同样是这个名字 | 浏览器**首次启动之前**把名字写进 profile 的 `Local State`（`profile.info_cache.Default.name`）。晚一步都不行——profile 一旦跑起来，名字就固化成「用户配置 1」了 |
| 2. 最左侧标记标签页 | `🤖 AI 浏览器 · dsh-browser-panel`，一张说明卡 | 启动时收养浏览器自己的 `about:blank` 标签页，跳到 `about:blank#dsh-ai-browser`，由注入脚本画卡片 |
| 3. 页面右下角角标 | `● AI 浏览器 · 空闲 · 负责人 主会话 #add7af` | `Page.addScriptToEvaluateOnNewDocument` 注入：跨导航存活，且不受页面 CSP 约束 |
| 4. 操作中的边框 | 视口四周亮起 3px 琥珀色边框，角标变成 `AI 正在点击` | 每次工具调用前后各推一次状态 |

**蓝色 = AI 空闲**（窗口是它的，但现在没动它）；**琥珀色 = 正在操作**。

实况图（真机截图，`e2e/capture-window.ps1` 从桌面上裁出窗口区域）：
标记标签页里的说明卡见 `e2e/window-marker.png`，页面右下角的角标与最左侧的标记标签页见 `e2e/window-demo.png`。

### 几个刻意的取舍

- **只标记，不拦截。** 所有标记节点都是 `pointer-events: none`，也完全不冻结页面。用户随时可以直接
  在这个窗口里接手点击和输入。v0.16.2 那套「AI 操作时锁定面板」在这里没有意义——窗口本来就摆在
  用户眼前，而 CDP 合成的输入本来也不走操作系统的输入队列。
- **不污染模型看到的内容。** 角标虽然画在页面 DOM 里，但 `browser_panel_snapshot` 读取前会先把它
  `display:none` 再读 `innerText`，元素大纲里也会跳过带 `data-dsh-ai` 的节点。模型读到的页面文本
  不含插件自己画的东西。（截图默认也干净：`screenshot: clean` 会为按快门的那一瞬间藏起角标与边框；想在图里留下「这是 AI 在操作」的证据就把模式设成 `marked`。）
- **用户关掉标记标签页就不重建。** 跟人抢标签页比少一个提示更糟；窗口标题那层标识还在。
- **角标跑在页面主世界**，这是为了让宿主可以直接推状态。它是「告知」而不是「防篡改」：一个铁了心要
  隐藏它的页面能把它删掉，但删不掉窗口标题和标记标签页。
- **样式全部走 CSSOM**（`cssText`），不用 `<style>` 元素、也不用 `style=` 属性，因为后两者会被
  `style-src` 拦掉。e2e 里有一个 `default-src 'none'; script-src 'none'; style-src 'none'` 的
  fixture 页专门验证这一点。
- **角标固定在右下角**，可能压住某些站点的浮窗。真介意的话把 `ownership` 设成 `operating`，
  它就只在 AI 动手时出现。
- **`windowName` 只在首次启动前生效**：profile 已经有了别人起的名字（你自己改的）就绝不覆盖；
  已经是 Chromium 自动生成的「用户配置 N」则会被替换。

## 截图模式

身份层是画在页面里的真实 DOM（右下角角标、操作时四周的琥珀边框），而截图是模型看页面的主要方式。
两边需要一个折中，所以 `screenshot` 有两个模式：

| 模式 | 窗口里 | PNG 里 | 适用 |
|---|---|---|---|
| `clean`（默认） | 角标与边框照常显示 | **没有**，图就是页面本身 | 给模型看页面、留档页面内容 |
| `marked` | 角标与边框照常显示 | 带着，角标上写着「正在截图」 | 需要一张图证明「当时是 AI 在驱动」 |

`clean` 不是关掉身份层：它只是在**按快门的那一瞬间**把身份层 `suspend()`，等一帧、截图、再 `resume()`。
窗口里该显示的一直在（除了约 0.1–0.3 秒的一眨眼，那是「截一张没有标识的图」本身要付的代价）。
`ownership: 'off'` 时没有层可藏，两个模式出图一样。

实测（纯白 fixture 页，headless 与 visible 都跑过）：`clean` 的四角是 `rgb(255,255,255)`、右下 460×90 区域最暗像素 luma **255**；
同一页切到 `marked`，四角变成 `rgb(252,204,80)`（`rgba(251,191,36,.8)` 压在白色上）、右下最暗 luma **79.6**（角标），
截图返回后角标仍在屏幕上。像素是这里唯一可信的证据 —— 读 DOM 只能证明「样式改了」，证明不了「图里真的没有」。

## 一个 agent 一张页面

同时可能有多个会话（甚至多个 agent）在跑，这个窗口由它们共用。规则只有一条：

> **一个 agent 最多操作一张页面。想要第二张？派一个子 agent，它有自己的那一张。**

这不是一句写在提示词里的口号，而是插件的行为：

- `browser_panel_open` **只导航本 agent 已经拥有的那张页面**，不会因为再调一次就新开标签页。
  旧版本「默认新开、旧页留下」正是「agent 开了一堆页面、旧的没人用」的来源。
- 没有页面的 agent 才会拿到一张：优先收养浏览器启动时的空白页，其次新开一张 —— 一个 agent 只会走到这一步一次。
- 子 agent 有自己的 `agentId`，因此天然拥有自己的一张页；父 agent 的页面不受影响，也不允许去操作它。
- 某个 agent 的页面被用户关掉后，下一次调用会明确报「call browser_panel_open again」。

### 页面负责人的标注

每个页面右下角的角标、标记标签页的状态行、以及 `browser_panel_status` 的 `pages[]` 都会写明**这张页归谁负责**：

| 场景 | 显示成 |
|---|---|
| Team 会话 | 成员名，例如 `lead`、`researcher-a`（来自 `agentTeams` 服务） |
| 普通主会话 | `主会话 #add7af`（会话 id 的可读尾段） |
| 子 agent | `子 agent L1 #b26f74`（深度来自 session header 的 `delegationDepth`） |
| 负责人已结束 | 同上，角标追加 `（已结束）` |

`browser_panel_status` 的每个 `pages[]` 条目因此带 `owner`（agent id）、`ownerLabel`（就是角标上那串）和
`ownerActive`（负责人是否还在跑）。原生渲染还会在每行末尾打印 `(id: …)`，那就是 `adopt` 要的 targetId——
所以模型只靠 `status` 的文本输出就能接手页面，不需要别的渠道。模型和用户都能一眼对上「这个页面是谁的」。

### 页面比 agent 活得久

agent 结束时**不关它的页面**：用户可能正要看效果，而且页面里的登录态、滚动位置、填了一半的表单都还有用。

- 页面保留，角标改成 `负责人 xxx（已结束）`，`ownerActive` 变成 `false`；
- 后来的 agent 想接着在这个页面上干活，用 `browser_panel_open({ adopt: "<targetId>" })`
  （targetId 从 `browser_panel_status` 拿；想顺便导航就再给 `url`）。这个页面就归它了，
  它自己原来的页面会被**释放**——仍然开着，但不再属于任何人，不会被关掉；
- 只能接手**负责人已经结束**的页面：还在跑的 agent 的页面会被拒绝，避免两个 agent 抢同一张页；
- 被接手的 agent 之后再被唤醒时会重新 `open` 一张自己的页，不会去抢回来。

这套约定同时写进了插件的系统提示词（`ctx.systemPrompt.section()`），所以模型在第一次调用之前就知道
「重复 open 只会导航，不会多开」，以及接手页面要用 `adopt`。

其余多会话细节不变：

- 第一个标签页永远是**标记标签页**，不属于任何 agent，也不会被任何 agent 收养或接手；
- 自动分配只会收养空白页，不会主动抢用户自己打开的标签页（显式 `adopt` 除外，见上）；
- 需要真实键鼠输入时（click / type / press）会先 `Page.bringToFront` ——
  Chromium 会丢弃发给**非前台标签页**的合成键鼠事件，不切到前台就会「点/输入了个空」。

## 配置行

`cordis.patch.yml` 里的 `sidebar-browser` 行：

| 键 | 默认 | 说明 |
|---|---|---|
| `actionTimeoutMs` | 20000 | 单条 CDP 命令、以及等待页面加载的上限 |
| `maxSnapshotChars` | 12000 | 快照返回的页面文本上限（下限 500） |
| `browserPath` | `''` | 空 = 自动探测：Edge → Chrome → Brave → Linux 常见路径。也可用环境变量 `DSH_BROWSER_PANEL_BROWSER` 覆盖 |
| `profileDir` | `''` | 空 = `~/.dsh/browser-panel/browser-profile` |
| `headless` | false | 只有显式 `true` 才不开窗（无人值守才用） |
| `windowWidth` / `windowHeight` | 1280 / 800 | 窗口尺寸 |
| `windowX` / `windowY` | -1 | -1 = 交给系统摆放 |
| `debugPort` | 0 | 0 = 让浏览器自己挑端口并写进 profile 的 `DevToolsActivePort`（推荐：顺带让上一次遗留的浏览器可以被接管）。设固定值则按固定端口走，适合要手工挂第二个 CDP 客户端的场景 |
| `startUrl` | `about:blank` | 启动时那一个标签页的地址 |
| `allowOrigins` | `''` | `browser_panel_open` 的白名单：逗号分隔的域名后缀；空 = 任意 http(s)。**只约束 agent 的入口，不是防火墙** |
| `windowName` | `AI 浏览器` | 写进 profile 的名字，也就是 OS 窗口标题里那一段 |
| `ownership` | `always` | 页面上的身份层：`always`（常驻角标）/ `operating`（只在操作时出现）/ `off`（完全不要，连标记标签页也不建）。填了没见过的值会回落到 `always`，打错不会把标识藏起来 |
| `screenshot` | `clean` | `browser_panel_screenshot` 出图带不带身份层：`clean`（角标与琥珀边框留在窗口里、不进图）/ `marked`（画进图里，事后回看截图仍能看出是 AI 在操作）。填了没见过的值会回落到 `clean` |
| `markerTab` | true | 是否创建最左侧那张说明卡标签页。只有显式 `false` 才关 |
| `provision` | `ask` | 机器上没有浏览器时怎么办：`ask`（加载时检测，第一次 `open` 时在界面里问是否下载）/ `never`（从不问也从不下载）/ `auto`（不问直接下载）。填了没见过的值会回落到 `ask`，**绝不会静默下载** |

`profileDir` 是登录态能跨重启保留的原因，它刻意与你自己日常用的浏览器分开。

## 安装位置

npm 安装的在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@folsiti\dsh-browser-panel\`；
从本地目录安装的是一个 `link:` 依赖，指向你给的那个目录（早期版本曾放在 `plugins\dsh-sidebar-browser\`）。
不管哪种，包里都是 `host.js`、`package.json`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`。

**v0.16.2 → v0.17.0 的变化：`client.js` 已删除，`package.json` 里的 `dsh.client` 元数据也已移除。**
装了新版本后请把插件目录里遗留的 `client.js` 删掉。**v0.17.0 之后都只是 `host.js` /
`cordis.patch.yml` 的改动。** 改完 host 半边**需要重启 DSH**。

## 自测

```
npm test          # 97 个用例，不需要浏览器
npm run test:e2e  # 34 项真机检查，会真的拉起 Edge
npm run test:e2e -- --visible          # 用真窗口跑（会短暂弹窗）
npm run test:e2e -- --visible --hold 8000   # 弹窗后停留 8 秒给你看
npm run test:e2e -- --visible --hold 8000 --marker-front   # 停在标记标签页上
```

Windows 上想亲眼确认「窗口真的在屏幕上、标题真的写着 AI 浏览器」，就趁 `--visible --hold` 期间执行
`e2e/capture-window.ps1`：它按 profile 目录认出插件拉起的那个 Edge 进程、把窗口置顶并裁到窗口矩形，
存成 `e2e/window-demo.png`（`-Out 别的名字.png` 可以改输出）。
仓库里那两张图就是这么来的。

- `test/tool-contract.test.mjs`（12 条）—— 九个工具的 schema 在强制子集内、输出 object 根且 `required` 与声明完全一致、
  每个 `execute` 的返回值逐字段符合自己的 schema、render 文案不退化、`apply` 注册九个工具并接上 dispose
  与 agent 生命周期、`open` 只声明 `url`/`adopt`（没有「再开一个」的开关）、
  `status` 打印每页 `id` 并在有「已结束负责人」时提示 `adopt`、
  `normalizeConfig` 的钳制（含「只有显式 `true` 才 headless」「打错的 ownership 回落到 always」「已废弃的桥接配置不会复活」）。
- `test/cdp-client.test.mjs`（12 条）—— CDP 客户端：id 递增与配对、协议错误带自己的 message 上抛、
  静默命令按方法和预算超时且不留残渣、未知 id 与非法帧被忽略、事件分发（一个抛异常的监听器不能影响其它监听器）、
  退订生效、`waitForEvent` 到点安静返回 null 且不留监听器、close/socket 掉线让所有在飞的命令失败、`connect` 成功与拒绝。
- `test/host-helpers.test.mjs`（10 条）—— 地址规则（裸域名补 HTTPS、拒绝 file:/javascript:/data:/内嵌凭据、allowOrigins 按域名边界匹配）、
  按键映射、PNG 尺寸、浏览器探测（win32/darwin/linux 候选与配置/环境变量优先级）、四个页面端表达式能编译且输入以 JSON 注入。
- `test/ownership.test.mjs`（23 条）—— 身份层：注入脚本能编译、幂等、每个节点都带 `data-dsh-ai`、
  不碰 `pointer-events`、不含 `<style>`／`style=`／`innerHTML`（CSP 安全）、角标与标记卡两条路径都在；
  `ownershipExpression` 把状态与标签当 JSON 注入；`sessionTag` 取 id 尾部；
  `agentLabel` 的名字优先与「主会话／子 agent L<n> + 短 id」兜底；
  系统提示词里的「一个 agent 一张页面」规则包含 `adopt`；
  快照表达式会 suspend/resume 并跳过身份层节点；`seedProfileName` 的五种情形（新 profile 写入、
  替换 Chromium 自动生成的名字、绝不覆盖用户起的名字、无法解析的 `Local State` 不碰、已经对了就不重写）；
  `ownership: 'off'` 一个字节都不注入；推状态失败（比如页面正弹着 dialog）也绝不弄挂动作；
  `clean` 截图的调用顺序（paint busy → suspend → 截图 → resume → paint idle）、`marked` 不 suspend、
  `ownership: 'off'` 时截图一个字节都不发给页面。
- `test/provisioning.test.mjs`（40 条）—— 「这台机器不是我这台」的四种情况：
  **发现**（五层各自能找到、裸命令名走 PATH、配错的 `browserPath` 被如实报出、原生安装压过 snap、
  PATH 只按具体名字找——`launcher.exe` 曾把 JetBrains 工具链当成浏览器、缓存根包含插件自己的下载目录）；
  **运行环境**（无 DISPLAY 自动 headless 并说明、显式 headless、有 DISPLAY 就不加 flag、root 加 `--no-sandbox`、
  snap 与 flatpak 的 profile 重定位、WSL 提示、老 `--headless` 回退、调试端口永远只绑 loopback、startUrl 在最后）；
  **授权**（加载时检测但不提问、提问卡片的文案与两个选项、选下载→安装→发现→`ok`、
  选停用→落盘→第二次不再问、新控制器读取已有决定、自己装浏览器会解除停用、跳过不算拒绝、
  没有回答者时不问也不挂、`never`/`auto` 的行为、下载失败带上原因、装完仍找不到也算失败、
  缺浏览器的报告列出每一层并排除 Firefox）；
  **解包**（手写 zip 的读写分离验证、目录结构与 stored/deflate 两种压缩、CRC 校验抓住被篡改的条目、
  `../` 与绝对路径被拒绝、非 zip 文件、zip64 被明确拒绝、CRC-32 对已知值）；
  **已在运行的浏览器**（只相信有应答的端口、启动器退出 0 不再算失败、非 0 立刻失败、
  转交但没人应答报 `handoff`、接管的浏览器 `running`/`reused` 正确、接管后退出不会去 kill 别人的进程且可以重复 dispose）。
- `e2e/browser.mjs`（34 项）—— 真机全链路：本地 fixture 站点，先起浏览器再依次调用九个工具，
  覆盖「status 不启动浏览器」「窗口以 OS 会显示的方式自报身份」「标记标签页存在且不属于任何会话」
  「每个页面都有角标且换文档后还在」「CSP 为 `default-src 'none'` 的页面照样有角标」
  「标记卡渲染并跟随状态」「角标不泄漏进模型读到的页面文本」
  「快照 ref 可点击」「maxChars 上限与下限」「eval 的 async 与 await」
  「真实键盘输入与 clear」「拒绝不可输入元素」「按键与未知按键拒绝」「按文字点击并读回新 URL」
  「点击落空如实上报」「历史后退与刷新」「截图是真实 PNG 且尺寸取自文件头」
  **「clean 截图的四角与右下角没有角标与琥珀边框（逐像素解码 PNG 验证），截图后角标仍在屏幕上」
  「marked 截图里两者都在」**
  「status 报告运行中窗口与绑定标签页」「第二个会话拿到自己的标签页且互不串台」
  **「同一个 agent 的第二次 open 只导航、绝不新增标签」「负责人仍在运行时的页面拒绝被接手」
  「负责人结束后可以用 adopt 接手，页面数不增加、被释放的页面仍在但不再属于任何人、角标换成新负责人」**
  「没标签页的会话被明确告知去 open」「type+Enter 与 press+Enter 都能真的提交表单」「dispose 不留进程」
  **「拿一个不是浏览器的可执行文件当浏览器时，报错说出它是谁、退出码多少、它自己的输出是什么」**
  **「完全没有浏览器时 status 说明原因，open 先提问，选了停用后第二次不再问」**
  **「按文字点到一个只有 onclick 的 div，并确认它的处理器真的跑了」「按文字点不到时列出页面里最接近的标签」**
  **「Tab 真的把焦点移到下一个控件」「第二个控制器接管已在运行的浏览器，并且复用标记标签页」**。
  机器上没有任何 Chromium 系浏览器时会跳过而不是失败。

## 本机验证记录

**v0.20.0 ～ v0.21.0，真机跑通**（DSH desktop 0.2.1-rc.2 / Node 24 / 中文 Windows / Edge **155.0.4283.45** 与 **156.0.4314.50**；
表里也保留 v0.19.x 时期的验证结论）：

| 项目 | 实测结果 |
|---|---|
| 探测浏览器 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（来源 `known-path`） |
| 五层发现 | 裸 `browserPath: where.exe` 经 PATH 解析到 `C:\WINDOWS\system32\where.exe`（来源 `config`）；配错的绝对路径被报为 `missingConfigured` 而不是被跳过 |
| 非浏览器 | `C:\Windows\System32\where.exe` 当浏览器：**220 ms** 内报出「`where.exe` exited before it could be driven / It exited with code 2 / Its output was: ERROR: Invalid pattern is specified in "path:pattern".」——以前这里只有一句 `the browser window closed (exit code 2)` |
| 无浏览器 | 假造的「什么都没有」环境：`status.browserAvailable === false`、`browserFound: []`、`browserRemedy` 给出 `winget install Google.Chrome`；`open` 提问一次，选停用后落盘 `state.json`，第二次调用直接以 `declined` 失败且**不再提问** |
| Chrome for Testing | 官方索引可达，Stable `154.0.8037.57`，win64 包 `205808814` 字节（≈196 MiB），首字节 `PK\x03\x04` |
| 系统窗口标题 | `Fixture Two 和另外 2 个页面 - AI 浏览器 - Microsoft Edge`；停在标记标签页时是 `🤖 AI 浏览器 · dsh-browser-panel 和另外 2 个页面 - AI 浏览器 - Microsoft Edge` |
| 标记标签页 | `about:blank#dsh-ai-browser`，标题 `🤖 AI 浏览器 · dsh-browser-panel`，`agentBound: false` |
| 角标 | `AI 浏览器 · 空闲 · 负责人 主会话 #agent1 @folsiti/dsh-browser-panel`；一次工具调用期间读到 `AI 浏览器 · 正在执行脚本 · 负责人 主会话 #agent1` |
| 角标存活 | reload 之后仍在；`default-src 'none'; script-src 'none'; style-src 'none'` 的页面上也在 |
| 不污染读取 | 快照既包含 fixture 正文 `strict csp body`，又不含 `AI 浏览器` / `dsh-browser-panel` / `空闲`，大纲里也没有 `dsh-ai` 节点 |
| `open` | `Edg/154.0.4258.37`，新建标签页并加载 fixture，标题 `Fixture One` |
| 可见窗口 | `Browser.getWindowForTarget` → `1100x720 at 10,10`，`windowState: normal` |
| `snapshot` | 大纲给出 `#next`（`tag=a`、`href=…/second`、文本 `Go to second`）与 `#field` |
| `click` | 按可见文字「Go to second」命中，URL 变为 `…/second`，标题 `Fixture Two` |
| `type` + `submit` | 字段值读回 `fixture query`，表单真的提交到 `/second?q=fixture+query` |
| `press` | `Tab`/`Enter`/`z` 生效；`F5` 被如实拒绝（`is not a key this tool expresses`） |
| `navigate` | `back` 回到 `…/`（bfcache 下 110 ms 完成），`reload` 正常 |
| `screenshot` | 真实 PNG，尺寸取自 IHDR，与返回的 `width/height` 一致 |
| `eval` | `return document.title`、`return await Promise.resolve(42)` 都正确返回 |
| 多会话 | agent-1 与 agent-2 各持一张页面，切换后互不串台；agent-1 的第二次 `open` 仍停在自己的页面上，页面总数不变 |
| 页面接手 | agent-2 结束后，agent-1 用 `adopt=<agent-2 的 targetId>` 接手：页面总数不变，agent-1 原来的页面被释放（仍开着、`agentBound: false`），角标改成 `负责人 主会话 #agent1`；agent-2 再调用时被告知去 `open` |
| dispose | 浏览器进程退出，`status.running === false` |
| 两轮全绿 | headless 34/34、visible 34/34 |
| 页面归属（v0.20.0） | 同一 agent 第二次 `open` 返回 `reuse: true`、`note: navigated the page this agent already owns (one page per agent)`，`status.pages` 数量与 `selected` 均不变；负责人仍在运行时 `adopt` 被拒（`still owned by an active agent`）；`markAgentDisposed` 后 `adopt` 成功，`adoptedFrom: 主会话 #agent2`、`released` 指向自己原来的页面，页面总数不变，角标变为 `负责人 主会话 #agent1` |
| 真机首测（v0.20.0） | 首次 `open` 的 `owner: lead`、角标 `负责人 lead`；一次性子 agent 的页 `owner: 子 agent L1 #bda78a`，父页不受影响；子 agent 结束后 `[owner: …, finished]`；活着的负责人页 `adopt` 被拒、结束后按 id 接手成功，页面数 3→3，`released` 的旧页仍在但无 owner，角标变 `负责人 lead` |
| v0.20.1 复测 | 系统提示词规则在 lead 与一次性子 agent 的 prompt 中都出现（子 agent 逐字复述，含 `adopt=<targetId>` 与「never operate another agent's page」）；`status` 每行打印 `(id: …)`，有「已结束」页时追加 `call browser_panel_open with adopt set to that page's (id: …)`，接手后该行消失；只按 `status` 里打印的 id 执行 `adopt` 即成功，全程未借助 devtools 端点 |
| 截图模式（v0.21.0） | 纯白 fixture 页：`clean` 四角 `rgb(255,255,255)`、右下 460×90 区域最暗像素 luma **255**（没有角标与边框）；`marked` 同一页四角 `rgb(252,204,80)`、右下最暗 luma **79.6**（角标在）；截图返回后角标仍在屏幕上。headless 34/34、visible 34/34 |
| 实况图 | `e2e/window-demo.png`（角标 + 标记标签页 + 表单已提交）、`e2e/window-marker.png`（标记卡） |
| 真实站点 | 一个自建的多模型对话站（公网 HTTP，非本仓库 fixture）走了一遍完整会话操作：登录 → 新建对话 → 切换模型 → 输入消息 → Enter → 拿到回复。全程可见窗口，页面右下角的角标同步显示「正在执行脚本 / 正在截图 · #driver」 |
| HTTPS 站点 | 一个使用自签 / 内部证书的 HTTPS 控制台：`isSecureContext: true`，无证书拦截页；读到登录卡片，`#loginUser` 真实键入并读回、Tab 被页面自己拦在登录框内（是站点行为，fixture 上 Tab 正常移动焦点）、点「登录」触发站点自己的校验「用户名和口令都要填」 |
| Edge 155 回归 | v0.19.1 在 Edge **155.0.4283.45** 上完全无法启动（启动器退出 0）；v0.19.2 修好后同一台机器上启动正常，调试端口来自 `DevToolsActivePort`（如 `52279`），接管场景 `reused: true` |

真机踩到并修掉的坑（都有对应用例）：

1. **bfcache 的历史导航不触发 load 事件** —— 只等 `Page.loadEventFired` 时，`back` 会白等满 15 秒。
   现在同时等「load 事件」与「URL 变化」，谁先到算谁。
2. **Enter 必须带 `text: '\r'`** —— 只发 `rawKeyDown` 时 Chromium 派发了 keydown 但**不执行默认动作**，
   表单永远不提交。
3. **非前台标签页会吞掉合成键鼠事件** —— 第二个会话把标签页推到后台后，第一个会话的输入全部落空。
   现在 real input 之前先 `Page.bringToFront`。
4. **Edge 首启会弹「同步你的浏览数据」账号对话框** —— 新 profile 撞上已登录的 Windows 账号就会出现，
   盖住用户本该看着的页面。现在启动时带上 `--disable-sync --no-service-autorun
   --disable-background-networking --disable-features=…msImplicitSignin,msEdgeSyncPromo…`。
5. **`about:blank` 加个 fragment 是「同文档导航」** —— 启动页本来就是 `about:blank`，跳到
   `about:blank#dsh-ai-browser` 不会产生新文档，所以 `addScriptToEvaluateOnNewDocument` 根本不会触发，
   标记卡画不出来。现在 `installOwnership` 除了注册，还会在**当前文档**里把脚本跑一遍（脚本自身幂等），
   并在跳转之后重画一次。
6. **`existsSync` 忘了导入** —— 被 `seedProfileName` 里那个「命名失败不能拦住启动」的 `catch` 吞掉了，
   表现为窗口标题怎么都不带 AI 标识。用例直接把它抓出来了：静默兜底必须有用例盯着。
7. **按文字点击对 `<div onclick>` 无效** —— 在一个真实站点上撞到的：模型下拉框是纯 `<div>`，
   没有 role，而 `click` 的按文字匹配只在「`a` / `button` / 带 role」这个集合里找，
   于是「明明看得见却点不到」，报错还只说「没有可点击元素带这个文字」。
   现在会退回「任意可见元素里标签完全相同的那个」并取最深层节点（避免点到包住它的容器），
   失败时还会列出页面里最接近的几个标签，让模型自己改口。这类界面遍地都是，这个坑值得记一笔。
8. **Edge 155 的启动器让整个插件失灵** —— 一个 20 天后回来的会话里，`browser_panel_open` 一调用就报
   「exited before it could be driven. It exited with code 0」，但浏览器其实起来了。查下去是：
   我们 spawn 的进程把活交给真正的浏览器进程、自己退出 0（它的 stdout 就写着「正在现有浏览器会话中打开。」），
   而插件把「子进程退出」当成了「浏览器没起来」。修法是**判断依据从进程改成端口**：
   用 `--remote-debugging-port=0` 让浏览器把端口写进 `DevToolsActivePort`，只要端口应答就算成功；
   顺带让「上一代遗留的浏览器」也可以被接管，而不是变成启动失败。
   教训：进程能不能活，和浏览器能不能用，是两件事。
9. **`open` 默认新开标签页，旧页面被搁置** —— 调试时模型每调一次 `open` 就多一张页，
   旧页面只是解除 CDP 绑定、**并没有关**，于是窗口里堆满没人用的页面。
   v0.20.0 把「一个 agent 一张页」做成结构约束而不是一句提示词：`open` 只导航自己的页，
   想要第二张就派子 agent；agent 结束后页面保留（用户还要看结果），后来者用 `adopt` 接手。
   规则同时通过 `ctx.systemPrompt.section()` 写进系统提示词。
10. **系统提示词里那条规则其实没注入** —— 首版直接访问 `ctx.systemPrompt.section()`，但
   `ctx.systemPrompt` 只有插件 `inject` 了该服务时才存在；异常被安全兜底吞掉，工具照常工作，
   而子 agent 在真机上明确报「NO RULE IN PROMPT」。改成和其它可选服务一样的 `ctx.get('systemPrompt')`。
   教训：静默兜底必须有用例盯着 —— 单测现在用一个「只按名字提供 systemPrompt 服务」的 ctx，
   断言规则真的注册了、文本与顺序都对。
11. **`status` 不打印 targetId，`adopt` 在原生模式下没法用** —— 真机首测时模型只能看到标题和负责人，
   拿不到 `adopt` 需要的 id（我那次是从 devtools 端点手工取的）。现在每个标签行末尾打印 `(id: …)`，
   并在存在「负责人已结束」的页面时提示用 `adopt` 接手。

## 已知限制

- **只支持主框架**：`snapshot` / `click` / `type` / `eval` 都在主框架里执行，跨域 iframe 内部读不到、点不到。
- **快照大纲只列「可交互集合」里的元素**（`a[href]`、`button`、`input`、`select`、`textarea`、
  `summary`、`[role=…]`、`[contenteditable=true]`）。纯 `<div onclick>` 做的控件不会出现在大纲里 ——
  但它**可以按完全相同的可见文字点到**（见上文 `click` 的行为），拿不到 ref 时用文字即可。
- **不能复用你正在用的那个浏览器**：调试端口必须在浏览器启动时给，事后加不上。所以插件开自己的窗口和
  自己的 profile（`~/.dsh/browser-panel/browser-profile`），第一次登录要手动登一次，之后会保留。
- **所有 agent 共用一个窗口**，但每个 agent 最多一张页面；不是「每个会话一个窗口」。
- 下载、文件上传、原生弹窗、权限授予（摄像头/麦克风/定位）不做处理，都由 Chromium 默认拒绝或忽略。
- 页面里的 `window.open` 会开成新标签页，我们不做特殊处理；新标签页不属于任何 agent，
  但某个 agent 可以用 `browser_panel_open({ adopt })` 显式接手它（接手不会让它多占一张页：它原来的页面会被释放）。
- `allowOrigins` 只约束 `browser_panel_open` 的入参，页面自己跳到哪儿它管不了。
- 浏览器进程被强杀（比如任务管理器）后，下一次工具调用会报「the browser window is not open」，
  再调一次 `open` 即可重新拉起。
- Web 载体（浏览器里的 DSH）同样可用，因为它不依赖 Electron，只要机器上有 Chromium 系浏览器。
- 用 `browserPath` 指向的必须是真正的浏览器可执行文件；指向目录会在启动前就被拒绝。

身份层自己也有几条边界：

- **角标不是防篡改的**：它跑在页面主世界，页面可以把它删掉。它是「告知」，不是「管控」。
- **角标固定在右下角**，可能压住某些站点的浮窗或客服气泡；`ownership: 'operating'` 可以让它只在 AI 动手时出现。
- **`windowName` 只在浏览器首次启动前写入**：profile 已有名字时，除了 Chromium 自己生成的
  「用户配置 N」，一律不动。想让一个已经跑过的 profile 改名，得删掉它重新来。
- **标记标签页被关掉就不再创建**（不跟用户抢标签页），窗口标题那层标识仍然在。
- **headless 模式下身份层只剩页面里的角标**：`headless: true` 时没有窗口可看，`windowName` 和标记标签页
  都没有对象，这套设计是为「用户看着 AI 干活」准备的。
- **截图默认不含角标**（`screenshot: clean`）：它不会出现在 `browser_panel_snapshot` 的文字与大纲里，
  也不会出现在 `browser_panel_screenshot` 的 PNG 里。想在图里留下「这是 AI 在操作」的证据，就把模式设成 `marked`。
- **`clean` 截图会有一眨眼**：按快门那一瞬间角标与边框会被藏起来，随后立刻回来（约 0.1–0.3 秒）。
  这是「截一张没有标识的图」本身要付的代价；`marked` 不藏，但图里就会带着它们。

关于「没有浏览器」这条路，也有几条边界：

- **子 agent 问不了人**：DSH 的提问通道只接受活跃的运行时根 agent，子 agent 发起的提问会被拒绝。
  所以子 agent 直接调 `browser_panel_open` 时不会弹卡片，它会拿到「没有浏览器 + 怎么装」的报错，
  由主 agent 去走提问流程。这是 DSH 的约束，不是这里能绕开的。
- **下载要联网、要磁盘**：约 196 MB 下载 + 解压后更多。放在 `~/.dsh/browser-panel/browsers/`，
  整个目录删掉就是卸载。下载超时上限 15 分钟。
- **不能用「让插件复用你正在用的浏览器」这条捷径**：调试端口必须在浏览器启动时给，事后加不上；
  而 DSH 自带的 Electron 也不能当浏览器用（打包版 Electron 只能加载它自己 `app.asar` 里的 app，
  而且桌面壳有单实例锁）。所以只有「你装一个」或「插件下一份」两条路。
- **snap / flatpak 的 profile 会被搬进它自己的沙箱目录**（见上文），那里的登录态与
  `~/.dsh/browser-panel/browser-profile` 不是同一份。
- **换浏览器会换 profile**：`browserPath` 指向另一个浏览器时，用的是**那个浏览器**的 profile 目录默认位置，
  登录态不会跟着走。

## 为什么不再动侧栏的 webview

「把右侧栏那个 Browser 弹成独立窗口」在插件层面做不到，因为侧栏 Browser 是桌面壳主进程持有的
Electron `<webview>`，而主进程把每一条出路都封死了（`app.asar` → `lib/main.js`）：

| 事实 | 位置 |
|---|---|
| 主窗口 `setWindowOpenHandler` 一律 `deny`，http(s) 交给 `shell.openExternal` | `lib/main.js:10541` |
| `will-navigate` 只放行 `dsh-app:` 与自身 origin | `lib/main.js:10601` |
| 只有主窗口拿到 `webviewTag: true`，其余窗口（登录/更新/快捷键）都是 `false` | `lib/main.js:10537`、`8786` |
| guest 里的 `window.open` 也被 `deny`，只转成 `browserOpenRequested` → 开**新的侧栏 tab** | `lib/main.js:9158` |
| webview 是「租约」制：主进程审批 `browserAcquire`，`will-attach-webview` 强制加固 `webPreferences` 并拒绝嵌套 webview | `lib/main.js:9122`、preload 只暴露 `acquire/release` |

要弹窗就得改 DSH 本体（签名与自动更新一起坏），所以本项目选择**让插件自己拥有浏览器**。
如果你只是不想要侧栏那个 tab，那是官方支持的开关，在 profile patch 里加：

```yaml
- id: ui-sidebar-browser
  disabled: true
```

v0.16.2 那一代的实现整块删掉了，连同它必须解决的麻烦一起：Remote 命名空间、长轮询桥、
`agentId → frame` 归属表、唤出侧栏、唤出导致导航后把地址放回去、`UnknownVizError` 兜底、
以及「AI 操作期间冻结面板」——现在窗口就是可见的，用户本来就看得到 AI 在做什么。

## 许可

MIT
