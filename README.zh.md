# dsh-waypoint

[![CI](https://github.com/wooyang2018/dsh-waypoint/actions/workflows/ci.yml/badge.svg)](https://github.com/wooyang2018/dsh-waypoint/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-waypoint.svg)](https://www.npmjs.com/package/dsh-waypoint)

[English](README.md) | 简体中文

把远端开发变成和本地 Session 一样的体验。

添加一次 SSH 主机后，插件会自动准备远端 DSH 运行时，把远端工作区和 Session 镜像到本地侧边栏，并在**普通 Conversation UI** 中打开远端 Session。转录、输入框、工具卡片、停止按钮和 Session 列表都与本地 Session 一致。

```text
本地 DSH                                        远端主机
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ 普通侧边栏 + Conversation UI         │          │ dsh web（由插件安装）        │
│  本地镜像 Session + Agent façade     │  SSH     │ dsh-waypoint-agent             │
│  主机注册 / 自动安装                 │◀────────▶│  workspace/session 写入      │
│  直连 key 或本地 key proxy           │          │  远端工具 + 模型调用          │
│  已认证的 /api 路由                  │  隧道    │                              │
└──────────────────────────────────────┘          └──────────────────────────────┘
```

## 支持环境

本插件面向 **[官方 DSH Desktop 客户端](https://github.com/deepseek-ai/deepseek-harness)** 开发。支持的 DSH 版本：

| 组件 | 版本 |
|---|---|
| [DSH Desktop / 官方客户端](https://github.com/deepseek-ai/deepseek-harness) | [**0.2.2-rc.3**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)（已测试） |
| 插件 | [**1.1.1**](https://www.npmjs.com/package/dsh-waypoint) |
| 远端 DSH 运行时 | [**0.2.2-rc.3**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)（已测试；新安装跟随本机 DSH 版本） |
| 远端 Node.js | [**22.19+**](https://nodejs.org/en/download)（可在主机卡片一键安装 nvm + 最新 LTS） |
| 远端操作系统 | Linux 或 macOS |

没有测试过其他 DSH GUI 插件、社区 fork、修改过的客户端、非 DSH GUI，以及其他 DSH 版本。
包的依赖范围为了安装兼容性写得较宽，但不代表兼容性承诺或支持范围。桌面客户端和远端运行时
均已在 `0.2.2-rc.3` 上测试；新远端安装默认跟随本机 DSH 版本，可用 `remoteDshVersion` 固定。

## 已实现功能

下列功能都在真实 SSH 主机上验证过，且不需要改动客户端：

- 插件页一键安装
- 基于 SSH 的远端自动安装
- 主机注册、发现、SSH 隧道、健康检查、重连
- 远端工作区出现在本地工作区列表
- 远端 Session 出现在普通侧边栏，并在普通 Conversation UI 中打开
- UI 跟随 DSH 语言（中文 / 英文）
- Prompt、停止、转录、工具卡片、usage
- 按主机选择模型 Key 来源（本地代理或远端直连）
- 远端模型目录，并出现在镜像 Session 的模型菜单里
- 不重新安装、只重启远端 DSH（`systemd` 部署；`nohup` 部署用重新安装）
- 经隧道打开远端 DSH Web UI
- 远端文件树和文件预览，经 SSH 隧道的 agent API
- 原生文件面板里的远端工作区搜索，按条目名或工作区相对路径
- 每个 Session 的远端终端——本地 Session 用本地 PTY，远端 Session 用经 SSH 隧道的远端 agent PTY
- 右侧栏浏览器预览远端 dev server，经 loopback 端口转发（见下文）
- 主机/工作区/Session 的 Agent 工具
- 审批提示接入本地 UI

**不支持**的部分——Windows 远端、relay/NAT 穿透——列在[已知限制](#已知限制)里，并附有可用的替代做法。

> 文件/终端操作要求新版 agent API。远端 agent 过旧时，操作会提示 Reinstall，而不会再额外建立 SSH 连接。

## 安装

### 从 DSH 插件页安装

打开 **Plugins → Add plugin**，输入：

```text
dsh-waypoint
```

DSH 会从 npm 安装 bundle。这个包已经包含远端 agent 资源，不需要再安装其他包。按插件页提示重启 DSH，然后 **Settings → Remote development** 会出现。

如果 npmjs.com 对刚发布版本的 `latest` 解析仍旧滞后，可以改为安装当前的精确版本：

```text
dsh-waypoint@1.1.1
```

每次发新版本时同步更新这个版本号。

### 从源码安装

开发时克隆仓库并运行安装脚本：

```sh
cd /path/to/dsh-waypoint
pnpm install
pnpm -r build
node scripts/install-local.mjs
```

脚本会构建 workspace，生成一个单插件 tarball，并完成安装——默认装进 `desktop` profile：

```sh
node scripts/install-local.mjs              # desktop profile
node scripts/install-local.mjs --profile web
```

`desktop` profile 会在解析参数阶段拒绝 `dsh plugin`，所以脚本改为调用 CLI 自己导出的 `runCli`，并传入
那道检查要找的进程内许可。这与运行中的 Host 走的是同一条代码路径，包含 bundle 注册步骤，因此没有任何
一部分被重新实现，profile 的文件锁也照常生效。又因为只有应用自己的运行时能读 `app.asar` 内部，脚本在
普通 Node 下启动时会自己换用该运行时重新执行。

运行中的 DSH 会占用插件文件，而 pnpm 替换包靠的是重命名目录，所以安装前请退出应用，装完再打开以加载
新的 host 与 client bundle。之后出现 **Settings → Remote development**。

## 使用

1. 在 **Settings → Remote development** 输入 SSH 目标（例如 `my-host`），点击 **Save and connect**。
2. 首次连接时，插件会发现或安装远端 agent，启动远端 `dsh web`，建立 loopback 隧道，并应用一个模型 Key 来源：按默认种子，它会把解析到的模型 key 写入远端环境。主机卡片会显示 **Installing → Connected**，行内状态为 **Remote direct**；如果希望 key 留在本机，可在卡片上把 **模型 Key 来源** 切换到 **本地 Key 代理**。
3. 在侧边栏 **Workspaces** 标题栏点击 **+**。新建工作区弹窗可以选择 **This computer** 或已连接的 **Remote device**，再点 **Add** 选择源目录。本机目录使用系统原生目录选择器；远端目录使用只读 SSH 浏览器。
4. 创建流程会创建远端 Session、在本地建立镜像，并在**普通 Conversation UI** 中打开。工作区行的 **New session** 使用同一个远端目录。
5. 在普通输入框中输入。远端 DSH 执行本轮任务，本地转录实时更新；工具调用、usage、停止和多轮 follow-up 都与本地 Session 一致。
6. **Workspace files** 和 **New terminal** 面板跟随当前 Session：本地 Session 使用本机，远端镜像 Session 使用远端工作区。

Settings 页面只负责主机和工作区管理，会话本身不是弹窗。

## 移除本地镜像工作区

从本地侧边栏移除一个镜像工作区会暂停它的本地同步。远端工作区、文件、正在运行的会话，以及本地缓存的历史都会保留。目录刷新、重连和插件重启都不会把这个行加回来。

要恢复，用 **添加工作区** 再次选择同一台远端设备和目录。插件会恢复已有的本地历史，并从远端日志补齐（受配置的快照窗口限制）。从已移除的工作区创建会话必须先做这次显式添加；仅在远端目录里发现它不会恢复同步。

## 测试 / CI 工作区可见性

测试隔离由测试 DSH home 里的一个测试专用清单控制，不是 Settings 选项，也不是 agent 工具：

```text
$DSH_HOME/waypoint/test-visibility.json
```

```json
{"hiddenPaths": ["/tmp/dsh-waypoint-tests"], "hiddenWorkspaceIds": ["remote-workspace-id"]}
```

`hiddenPaths` 在创建工作区时就阻止本地注册。`hiddenWorkspaceIds` 在测试跑完之后隐藏一个已经可见的测试工作区；本地镜像会话会被归档而不是删除，移除该条目后恢复。详见 [docs/testing.md](docs/testing.md)。

## 开发与测试

面向 agent 的测试说明在 [AGENTS.md](AGENTS.md)。UI / 集成工作请使用隔离环境：

```sh
node scripts/test-sandbox.mjs
```

测试工作区可见性见 [docs/testing.md](docs/testing.md)。

## 原生 Session 的实现方式

插件不嵌入第二套聊天 UI，也不 iframe 远端页面。它会：

1. 根据远端 Session 已提交的事件日志，在本地创建真实的 `Session`；
2. 为这个本地 Session 注册一个小型自定义 Agent façade；
3. 把本地的 `followup` / `steer` / `cancel` 路由到远端 agent API；
4. 跟随远端日志，把新提交的事件追加到本地 Session；
5. 让 DSH 现有的 Session Controller、侧边栏、Conversation assembler、输入框和工具渲染器像显示本地 Session 一样显示它。

远端 DSH 仍然是执行所有者；本地 Session 是持久、实时的镜像，普通客户端代码路径负责渲染、选择、流式更新和转录。

## 模型凭据

**来源按主机选择。** 每张主机卡片上有 **模型 Key 来源** 开关，两个取值（**本地 Key 代理** / **远端直连**）；收起时的行内状态显示实际生效的结果：**Local proxy**、**Remote direct** 或 **Remote default**：

- **本地 Key 代理** —— key 只留在本机。远端 DSH 获得 `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` 和一个占位 key；SSH 隧道增加 `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`；本地代理校验每个主机独立的 proxy token，注入真实 key，再转发到 `credentialProxyUpstream`。
- **远端直连** —— 插件从本地 DSH 凭据存储读取 `DEEPSEEK_API_KEY`，写入远端 `dsh web` 环境（systemd unit 或 `nohup` 环境），并设置 `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`。远端主机直接调用 DeepSeek。

切换某台主机的来源会重启它的远端 DSH。profile 级 `credentialProxy` 现在只给从未选择过的主机做种子：`false` 种子为“远端直连”，`true` 种子为“本地 Key 代理”；已经选过的主机保持自己的选择。

如果本地没有可解析的 key，插件仍会安装并连接；此时需要配置远端 DSH 自己的凭据。该行会显示 **Remote default**，表示插件没有提供 key、远端使用自己的凭据。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `remote_hosts_list` | 主机、阶段、远端信息 |
| `remote_host_add` | 添加 SSH 主机并开始安装 |
| `remote_host_connect` | 连接/重连/刷新 |
| `remote_host_provision` | 强制重新安装/重启并重连 |
| `remote_host_restart` | 只重启远端 DSH 服务，不重新安装 |
| `remote_workspace_add` | 注册远端目录 |
| `remote_workspaces_list` | 列出远端 workspace |
| `remote_session_create` | 创建远端 Session |
| `remote_sessions_list` | 列出远端 Session |
| `remote_session_prompt` | 发送 prompt |
| `remote_session_snapshot` | 读取一页转录 |
| `remote_session_cancel` | 取消当前 turn |

主机写操作（`remote_host_add`、`remote_host_connect`、`remote_host_provision`、`remote_host_restart`）会走 DSH approval UI：它们可能发起 SSH 连接，直连模式下安装还会把本机模型 key 写入远端服务环境。`remote_host_restart` 依赖安装器创建的 systemd user unit；`nohup` 部署请改用**重新安装**或手动重启。`remote_host_add` 默认不自动连接。

这里**刻意没有**发布端口的工具。转发只有对持有 SSH 连接的那台机器才有意义，而那正是画浏览器的那台，所以它由点击触发，而不是由 agent 触发（见下）。

### 预览远端 dev server

右侧栏浏览器在**你的**机器上渲染页面，所以往里输入 `http://localhost:5173` 找的是本机的服务，不是远端。在从远端镜像过来的会话里，**直接点转录里的回环地址**就够了：插件把那个端口发布到本机 loopback，并在会话旁的「浏览器」标签里打开。

可识别的地址是 `127.0.0.1`、`localhost`、`[::1]`、`0.0.0.0`，必须带显式端口，写成 `http://…` 或裸的 `localhost:5173` 都行。指向非回环主机的链接不会被处理——每条转发的远端固定是字面量 `127.0.0.1`，所以 `192.168.x.x` 这类地址无法转发。

优先使用同一端口号，dev server 自己生成的绝对链接因此仍然有效。该端口在本机已被占用时会改用临时端口，主机卡片会提示"写死原端口号的绝对 URL 会失效"——此时请改用相对路径，或设置 dev server 的 base/origin。HMR 可用：转发的是原始 TCP，包含 WebSocket。

已发布的端口只存在于内存里：DSH 重启或主机重连后都不保留，也不会攒出需要清理的记录——再点一次就重建。Settings 里展开主机后会列出当前已发布的端口，绑定被拒的原因也显示在那里。

## 环境要求

**本地：** 官方 [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)，或同核心版本的 DSH Web；需要可通过 key 或 ssh-agent 免交互认证的 `ssh`。只有官方 Desktop 客户端是经过验证的 GUI 目标。

**远端：** Linux 或 macOS，带 SSH server。[Node.js 22.19+](https://nodejs.org/en/download) 通过该账号自己的 shell 探测，所以 PATH、nvm、Volta、fnm、Bun、asdf、mise、Nix、Homebrew 都会被识别。安装流程**不会**自行安装 Node.js：选哪个运行时版本是你的决定，机器上多一份正是两个运行时争抢同一个命令的起因；找不到或版本过低时会停下并说明探测到了什么。需要插件代劳时，主机卡片上有 **远端 Node.js → 安装**：先探测，再安装 nvm 与最新 LTS（`nvm install --lts`），且从不修改 shell 启动文件。不支持 Windows 远端。

远端终端用一个 Python 辅助脚本（标准库 `pty`）而不是原生 `node-pty` 编译产物，所以 **New terminal** 需要远端有 `python3`。其它都不需要它：安装、连接、会话、prompt、文件与 transcript 在没有 `python3` 时照常工作，只有 **New terminal** 会失败——终端面板能打开，并报告 PTY 启动失败。`python3` 随主流 Linux 发行版与 macOS 自带；通常只在精简容器镜像里缺失。

`pnpm` 和 `@deepseek-ai/dsh` 一律**全局安装**到 `npm prefix -g` 给出的前缀，因此插件启动的 `dsh` 和你自己敲的 `dsh` 是同一个文件、同一个版本。想换前缀就设 `remoteGlobalPrefix`，没有兜底位置——把 `dsh` 悄悄装到别处才是这次要去掉的分歧。如果该前缀不在你登录 shell 的 `PATH` 上，安装日志会打印唯一一行 `export PATH=…` 让人自行加入；安装器从不改你的 shell 启动文件。前缀不可写时安装会带着 npm 原始错误失败，而不是改装到别处。注意 npm 写的是 `<prefix>/lib/node_modules` 和 `<prefix>/bin`，两者可以一个可写一个不可写，这正是要跑 `dsh-waypoint-install doctor` 的原因。

如果远端需要代理，把 `remoteInstallProxy` 设为**从远端能访问的**代理 URL，例如端口转发后暴露在远端的 `http://127.0.0.1:17890`。安装流程会为 bootstrap 导出 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `npm_config_*`。留空时会使用该账号真实的登录 shell（bash、zsh、fish 等）及其登录/交互启动文件读取 `HTTPS_PROXY` / `HTTP_PROXY`。同一个代理也会写入远端 systemd unit（或由 `nohup` 进程继承），因此远端模型请求也会走代理，而不只是安装阶段。

## 安全

- SSH 是传输层；隧道只绑定 `127.0.0.1`。
- 主机 key 默认 TOFU（`accept-new`）；严格校验时使用 `yes` 并准备 `known_hosts`。
- 远端 agent 只监听 loopback，并使用 bearer token。它的写能力限制在 workspace/session 创建、prompt 和 cancel。prompt 可以让远端 DSH 在远端 sandbox 和审批策略下使用它自己的工具。
- 默认直连模式下，模型 key 会写入远端 systemd/nohup 环境。只应在可信远端账号上使用；systemd unit 以 `0600` 写入。设置 `credentialProxy: true` 可把 key 留在本地，并通过反向 SSH 隧道代理模型请求。代理请求需要每个主机独立的 token，远端无关本地用户不能复用该凭据端点。
- 浏览器请求走 DSH Connection 的已认证 `/api` Fetch 路由。token/凭据保存在 `0600` 文件中，永远不会返回浏览器。
- 文件树、预览、终端流量都在已认证的 SSH 隧道内。
- 只连接可信远端账号；远端 DSH 拥有该账号的权限。

## 配置

```yaml
- id: dsh-waypoint
  config:
    autoProvision: true
    remoteDshHome: ~/.dsh
    # pnpm 与 @deepseek-ai/dsh 的全局安装前缀；留空则用 `npm prefix -g`
    remoteGlobalPrefix: ''
    # remoteDshVersion: 0.2.2-rc.3  # 固定远端 DSH 版本；省略则跟随本机 DSH 版本
    remotePnpmVersion: 11.21.0
    # 远端可访问的代理；留空则读取远端登录 shell 的环境变量
    remoteInstallProxy: ''
    remoteInstallNoProxy: 127.0.0.1,localhost
    remoteStart: systemd          # systemd | nohup | none
    credentialProxy: false
    copyModelKey: true
    remoteModelBaseUrl: https://api.deepseek.com/anthropic

    # 可选：本地代理模式
    credentialProxyUpstream: https://api.deepseek.com/anthropic
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY

    mirrorSessions: true
    mirrorPollMs: 1500
    mirrorMaxEvents: 2000

    # 点击转发 dev server 端口的总开关。设为 `false` 时，影子会话里的回环链接
    # 会按原样导航。
    portForwarding: true
```

远端 agent 还支持高级配置：

```yaml
- id: dsh-waypoint-agent
  config:
    stateFile: ''
    token: ''
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## 已知限制

- 完整的远端 DSH 浏览器 UI 是诊断入口，不是主流程。远端 agent 保持 `dsh-api-remotes` 启用，该界面照常启动；审批桥以 `prepend` 注册，镜像审批仍会到达本地原生 UI。需要远端浏览器时（例如安装远端插件），用主机卡片上的 **打开远端 Web UI**。
- 本地 workspace anchor 只是元数据句柄。文件列表、预览和终端会路由到远端；远端 diff 和部分高级文件操作仍使用原生 Session 的工具结果。
- 原生 **Workspace files（工作区文件）** 面板可直接浏览远端工作区，**不需要任何第三方侧栏插件**：插件替换了宿主的
  `workspaceFiles` 服务方法，因此该面板的列目录、预览、搜索与变更监听都由远端 agent 经隧道应答。若某个 DSH 版本改
  了其中任一方法名，这层路由即失效——此时「设置 → 远程开发」会显示文件路由已 bypass，而不是只留一个没有解释的空树。
- 超过 `mirrorMaxEvents` 的远端 Session 会从可用尾部里第一个完整 turn 开始镜像；更早的历史留在远端 Session。想镜像更早的内容就调大限制，或直接在远端打开该会话查看。
- 转发的 dev server 端口发布在 `http://127.0.0.1:<端口>/`；侧栏浏览器的 iframe 策略（`X-Frame-Options`、混合内容）仍然生效，所以拒绝被嵌入的站点需要改自己的响应头，或改用**在系统浏览器打开**。本地端口与远端不一致时，写死远端端口号的绝对 URL 会失效。
- 不支持 Windows 远端，也不支持 relay/NAT 穿透。

## 故障排查

| 现象 | 处理 |
|---|---|
| **Installing** 一直不结束 / `Waiting for remote dsh web…` | 检查 `ssh -o BatchMode=yes my-host true`。安装流程通过你的 shell 探测 Node.js（nvm/Volta/fnm），自身从不安装；缺失或版本过低会直接停下并说明探测到了什么。用主机卡片上的 **远端 Node.js → 安装**（nvm + 最新 LTS），或自行装好 [Node.js 22.19+](https://nodejs.org/en/download)，然后点 **重新安装** |
| 安装报“Node.js 未找到”，且卡片不再自动重试 | 这是永久性原因，自动重连会停下而不是空转。点 **远端 Node.js → 安装**（先探测，再装 nvm + 最新 LTS，不改 shell 启动文件），然后点 **重新安装**；或在该账号的交互式 shell 下自行装好，确认 `bash -lic 'command -v node'` 能输出路径后重装 |
| `does not accept POST` | 远端 agent 太旧；点 **Reinstall** |
| 侧边栏没有远端 workspace | 用 **Workspaces +** 创建，或到 Settings → Remote development → Workspaces 查看 |
| 原生 Session 没有回复 | 检查主机行的 **Local proxy / Remote direct / Remote default** 状态；配置远端凭据，或改为本地 Key 代理 |
| `DeepSeek Messages request failed (404)` | Proxy upstream 必须是 `https://api.deepseek.com/anthropic`；重新安装插件并重连 |
| 本地出现审批，但远端工具仍失败 | 本地决定已经发出；检查远端工具结果 |
| 本地终端打开本地 shell | 本地 Session 的预期行为；远端 Session 使用 `Remote · <dir>` 终端 |
| 远端终端打开本地 zsh | 另一个 patch 禁用了 stock terminal-controller 行，导致没有任何服务提供终端；请去掉那条 disable |
| 远端重启后端口变化 | 隧道会断开并自动重连，重连时重新发现；也可点 **重启远端 DSH** 或 **重装远端 agent** 手动触发 |
| 安装报 npm 全局前缀相关错误 | npm 无法写入该账号的 `<prefix>/lib/node_modules` 或 `<prefix>/bin`，或 `npm prefix -g` 输出为空。把 `remoteGlobalPrefix` 指向一个你自己拥有的目录（如 `~/npm-global`）后重试 |
| 装完了自己的 shell 里找不到 `dsh` | 安装日志打印了要加到 shell 启动文件的那行 `export PATH=…`；安装器不会代你修改这些文件 |
| 切换 Node.js 版本后远端 DSH 起不来 | nvm/Volta 切版本会连 npm 全局前缀一起搬走，服务里烘焙的 `dsh` 路径随之失效。点 **Reinstall**；`dsh-waypoint-install doctor --target …` 会报 `global_dsh` 与 `login_path_has_dsh` |
| 远端 agent 端口乱跳 / 主机反复断连 | 有两个 `dsh web` 在写同一个 `agent.json`。每个 `DSH_HOME` 只跑一个；`doctor` 会报 `dsh_web_processes` |
| 某个端口显示 `error: local port N is already in use` | 本机已有进程占着这个号码。把**本地端口**留空让插件另选，或先停掉那个进程 |
| 转发出来的页面能开，但静态资源 404 | 本地端口与远端不同，写死远端端口号的绝对 URL 解析不到。改用相对路径或设置 dev server 的 base/origin，或者先在本机腾出那个端口号再点一次链接 |

远端日志：

```sh
journalctl --user -u dsh-waypoint-agent -f
# 或
$DSH_HOME/waypoint-agent/web.log
```

## 验证

```sh
pnpm verify
```

测试覆盖 protocol/SSE/cursor/write 契约、安装器渲染、proxy 转发和 client bundle。原生路径已在一个真实 Linux 远端主机上验证：插件安装、远端 workspace/session 创建、通过本地 key proxy 发送 prompt、实时事件镜像、第二轮 follow-up，以及远端工具调用/结果。

## 与上游的关系

`dsh-waypoint` 起源于 [Golden-Pigeon/dsh-remote](https://github.com/Golden-Pigeon/dsh-remote) 的 fork。
下面的改动曾试图合并回上游，被拒绝后，这项工作以独立项目的名义继续在这里维护。两者都是 MIT
许可，原作者在 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中保留署名，
仓库历史（包含每一个上游提交）原样保留。

改名同时改变了 DSH 持久化的身份，因此两者是**两份独立安装**，互不读取对方的状态：

| | 上游 `dsh-remote` | 本项目 |
|---|---|---|
| 插件包 | `dsh-remote-local-plugin` | `dsh-waypoint` |
| 远端 agent | `@goldenpigeon/dsh-remote-agent` | `dsh-waypoint-agent` |
| 主机注册表 | `$DSH_HOME/remote` | `$DSH_HOME/waypoint` |
| 远端 agent 状态 | `$DSH_HOME/remote-agent` | `$DSH_HOME/waypoint-agent` |

不会自动迁移。如果要切换过来，请先卸掉旧插件（`dsh plugin --profile <p> remove
dsh-remote-local-plugin`），避免同时出现两个设置分区；再按 `docs/operations.md` 搬迁主机注册表，
并清理远端主机上遗留的 `dsh-remote-agent.service`。

## 文档

- [Wire protocol](docs/protocol.md)
- [远程工作区原理](docs/remote-workspace-mechanism.zh.md)——远端目录如何变成侧边栏里的工作区：
  发现、隧道、会话镜像、文件与终端路由（英文正文：[remote-workspace-mechanism.md](docs/remote-workspace-mechanism.md)）
- [Operations guide](docs/operations.md)
- [Development](docs/development.md)
- [Testing](docs/testing.md)
- [Adapting to a new DSH release](docs/adapting-to-dsh-releases.md)
- [Releasing](RELEASING.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## 包结构

| 包 | 作用 |
|---|---|
| [`@dsh-waypoint/protocol`](packages/protocol) | Wire 类型、surface metadata、cursor、SSE、typed client |
| [`dsh-waypoint`](packages/local-plugin) | 自动安装、隧道、proxy、**原生 Session 镜像**、工具、Settings |
| [`dsh-waypoint-agent`](packages/remote-agent) | 远端 DSH 插件：workspace、session、prompt、SSE |
| [`@dsh-waypoint/installer`](packages/installer) | 插件使用的 bootstrap 库/CLI |
| [`@dsh-waypoint/testkit`](packages/testkit) | Fake host 和 wire 契约测试 |

## License

MIT。见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
