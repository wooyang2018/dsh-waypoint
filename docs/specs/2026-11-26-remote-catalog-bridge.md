# 镜像会话的远端命令与技能目录

状态：设计已定稿，**已实现**（1.1.4）。本文件保留为「代码为什么长成这样」的记录；
实现切片见 §11。

## 1. 背景与目标

镜像（「影子」）会话的 `/` 菜单是空的：既没有预设级命令，也没有工程技能。原因是结构性的，
不是回归。

- 镜像门面 Agent 用 `createScope(ctx, this)` 创建，从未对某个预设代系调用过
  `bindScopeParent`（`packages/local-plugin/src/mirror/service.ts`，
  `RemoteMirrorAgent` 与 `LazyRemoteMirrorAgent` 的构造函数），所以 `ScopedLayers.merge` 只能看到
  全局层（`dsh-scope/src/store.ts` 的 `merge`）。
- Web 表面关闭了承载这些注册的主机平面行——`skill-filesystem`、`tool-skill`、`command-goal`、
  `plan-mode`、`command-compact`、`agent-instructions`——它们只由 agent 预设挂载
  （`dsh-web-app/cordis.patch.yml`、`dsh-web-app/presets/standard.patch.yml`）。
- 隧道从未承载过命令或技能。`docs/remote-workspace-mechanism.md` §5.3 早已写明
  远端上下文注入不属于镜像协议的一部分。

目标：镜像会话的 `/` 菜单与命令执行，行为与远端主机自己的 Web UI 一致。

成功信号：

1. 镜像会话的 `/` 菜单列出远端预设的命令、远端全局命令，以及远端工程技能。
2. `/compact`、`/goal`、`/plan`、`/permission` 作用于远端会话。
3. 旧 agent 或关闭的开关，能复现今天的现行为且不报错。

## 2. 范围与非目标

范围内：命令目录、技能目录、含附件的命令执行、无会话草稿的解析、能力协商、测试与文档。

范围外：

- 把镜像 Agent 绑定到本地预设代系（见 §4 被否决方案 A）。
- 实现远端上下文注入；`inject()` 保持空实现。
- 为命令附件做流式上传路由。超过内联上限的文件继续以既有的 UI 错误失败，
  与今天的提示词文件行为一致。
- 客户端改动。`dsh-client-ui-commands` 与 `dsh-client-ui-skill` 读取的主机 Remote
  其响应形状不变。
- 提升 `PROTOCOL_VERSION`。它保持 `1`；新特性以能力名做门禁。

## 3. 用户与场景

1. **诊断一次卡住的排查。** 用户打开镜像会话输入 `/` 想用 `/compact`。今天这个条目不存在；
   改动后它由远端主机会作答的同一份目录提供。
2. **在镜像工作区开始工作。** 用户在镜像工作区新建任务，输入 `/`，期望在第一条消息存在之前
   就能看到 agent 自己的命令。菜单必须在不创建远端会话的前提下就有内容。
3. **把命令路由到拥有状态的主机。** 用户选 `/goal <文本>`，期望推进的是远端会话的目标，
   而不是本地门面的。

## 4. 决策

**采用：远端权威 + 主机平面适配器。**

本地主机继续拥有浏览器调用的那些 Remote 命名空间（`commands.list`、`commands.execute`、
`skills.list`），但对镜像会话改为转发给远端 agent，而不是用自己那几层作答。
本地不注册任何东西，也不逐命令做翻译。

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 把镜像 Agent 绑定到本地预设代系 | 命令处理器通过 `invocation.agent` 生效（`dsh-commands/src/index.ts` 的 `execute`）。`/compact` 会去压缩一个空的本地上下文，`/goal` 会写本地目标状态，`/permission` 会改写本地审批策略——全部作用在错误的对象上。 |
| B. 把远端描述符注册成本地作用域命令 | 名字看起来是本地函数，处理器却没有地方可跑。成本与 C 相同，还多了一个可能与远端漂移的注册表。 |
| C. 只转发执行，目录保持在本地 | 被报告的症状是条目从菜单里消失了。目录留在本地什么也修不了。 |

**为什么插桩主机服务实例而不是加客户端代理**：Typert 网关按调用解析 Remote 方法
（网关 `prepareInvocation` 里的 `Reflect.get(receiver, implementation)`），所以替换实例方法
才能改变浏览器观察到的东西。这正是 `packages/local-plugin/src/remote/files.ts` 已经记录的范式；
客户端代理观察不到这次解析。

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。功能需求如下。

- **R1** 镜像会话的命令目录就是远端会话的命令目录。
- **R2** 镜像会话的技能目录就是远端会话的技能目录，在远端 cwd 上解析。
- **R3** 草稿镜像会话（尚无远端会话）能在不创建远端会话的前提下回答这两份目录。
- **R4** 镜像会话上的 `/name …` 在远端主机执行，其 `command/run`/`command/done` 生命周期
  抵达本地会话记录。
- **R5** 不具备新能力的 agent，或 `mirrorRemoteCatalog: false`，精确复现今天的现行为。
- **R6** 命令附件以远端自己的暂存凭据抵达远端主机。
- **R7** 非镜像会话不受影响：三个被适配的方法一律委托。

## 6. 设计

### 6.1 归属与数据流

```
浏览器 `/` 菜单
  └─ ctx.remote.commands.list(sessionId)          线上参数名 `agent`
     └─ 主机: Reflect.get(ctx.get('commands'), 'list') → 适配器方法
        ├─ 非镜像 / 无能力 / 开关关闭 → 原方法
        └─ 镜像 + 有能力 → POST /catalog/commands
             body: { sessionId } | { agentPreset, cwd }
             └─ 远端 RemoteCatalogService
                ├─ 活跃会话 : ctx.commands.list(agent)
                └─ 草稿     : ctx.commands.list(lease.key)
```

执行是同一形状：`execute(agent, line, submittedAttachments, signal)` 变成
`POST /commands/execute`，由远端调用 `ctx.commands.execute(...)`。远端自己写
`command/run` 和 `command/done`，两个事件经镜像日志返回，由 `dsh-client-ui-chat` 的命令节点渲染。
**本地不合成任何事件。**

技能走第三条路：`sessionSkillCatalog.list(request, signal)` 拥有主机上的 `skills` 命名空间，
所以适配器插桩的是那个实例。

### 6.2 地址解析

```ts
interface CatalogRequest {
  /** 已存在的远端会话。 */
  readonly sessionId?: string
  /** 草稿镜像的远端 Agent 预设。 */
  readonly agentPreset?: string
  /** 草稿镜像的远端工作目录；与 agentPreset 一起发送。 */
  readonly cwd?: string
}
```

- **活跃会话。** 远端通过 `sessionQuery.observeSession` 读取 `workingDirectory` / `header.cwd` /
  `agentPreset`，并在存在活的 Agent 时用 `workingDirectory.ensure(agent)` 收敛 cwd。
  这与 `SessionSkillCatalog` 用的是同一个来源，所以两份目录不可能对「哪些工程根在发挥作用」产生分歧。
- **草稿。** `agentPresets.acquireScope(agentPreset ?? defaultId)` 产出一个作用域 key。命令读
  `ctx.commands.list(key)`；技能读 `skills.list({ cwd, scope: key })`。`commands.list` 的参数
  名义上是 `Agent`，但实现只把它当 `ScopeKey` 用（`ScopedLayers.merge(agent, …)`），
  所以该断言在调用点有文档说明，且一旦 DSH 日后暴露按作用域寻址的列表，改动是一行。
- 每个租约都在 `finally` 中释放（或用 `await using`），所以一次目录读取不会让某个预设代系继续存活。
- 本地侧由 `RemoteMirrorService.catalogAddressFor(localSessionId)` 提供地址，覆盖活跃记录与
  `#pendingBlanks` 两种情况（后者答 `{ agentPreset, cwd: remoteRoot }`）。它沿用了既有的
  `mirrorFor()` 读取模式。

### 6.3 命令执行

- 远端执行 `ctx.commands.execute(remoteAgent, line, parts, signal)`。`signal` 源自隧道请求的取消，
  所以关闭连接会中止处理器。
- **草稿通过物化来执行。** `execute` 必须绑定一个真正的 Agent，因为它要把生命周期事件追加到
  `agent.session`，所以本地侧复用 `RemoteMirrorService.materializeBlank`。**列出从不物化。**
  这个不对称是刻意的：打开 `/` 菜单不得创建远端会话，而执行 `/goal …` 与发送第一条消息是同一件事。
- **超时。** `/compact` 会跑一次摘要调用，远超 `RemoteAgentClient` 默认的 15 秒。
  客户端因此增加按调用的 `timeoutMs`（客户端选项；线上不变），并新增
  `mirrorCommandTimeoutMs` 设置，默认 `120000`。超时不会丢失结果：远端继续运行，
  它的 `command/done` 随后经镜像日志抵达。本地在此期间报 `success`，这会像已结算的命令一样消费掉草稿。
- **本地白名单。** 镜像会话上的 `export` 与 `feedback` 在本地运行。`/export` 的客户端钩子监听
  `command/executed` 并用本地会话 id 下载，而远端处理器只答 `REQUESTED`，
  转发会让下载去读错误的日志；`/feedback` 记录的是关于这个浏览器会话的备注。
  两者都是关于本地会话的动作，不是远端 agent 的状态。

### 6.4 命令附件

**浏览器交给主机的形状**（`dsh-client-ui-conversation` 的输入契约）：

```ts
type SubmitAttachment =
  | { type: 'image'; mediaType; data /* base64 */; name? }
  | { type: 'file'; receiptId }        // 由本主机铸造的暂存凭据
```

**拦截点。** 适配器替换 `commands.execute(agent, line, submittedAttachments, signal)`，
因此在本地准入之前就看到浏览器的原始部分。不会产生本地孤儿对象，也不必伪造本地凭据。

**线上不新增形状。** `RemoteCommandAttachment` 就是 `PromptImagePart | PromptFilePart`，
两者都已存在。其字段与 `CommandSubmitAttachment` 一一对应。

**流程**

1. 若解析出的命令名在缓存描述符中 `input.attachments !== true`，而请求携带附件，
   适配器返回 `dsh-commands` 会产生的同一段错误文本，且不花一次上传。
   缓存未命中则转发，由远端产出同样的结果。
2. 逐个部分：图片原样变成 `PromptImagePart`；文件经本地附件库解析、按流读取并施加上限，
   产出 `PromptFilePart`。无法解析的凭据变成错误结果，把草稿及其附件留在输入框里。
3. 对不支持 `session.file-attachment` 的 agent 使用文件部分会显式失败，与提示词路径
  「缺能力绝不静默丢弃」的规则一致。
4. 在远端，图片直接透传；文件经既有的 `#admitForwardedFile(sessionId, data, name)`，
   用**该主机自己**的 `fileUploads.upload` 暂存字节，返回一个该主机拥有的凭据。
   重塑后的 `{ type: 'file', receiptId }` 部分再进入 `ctx.commands.execute`。`dsh-commands` 无需改动。

**为什么这就化解了凭据问题。** 凭据是一个主机针对它暂存那次上传的**确切 Session 对象**铸造的权威，
无法跨机器。提示词路径已经用「发送字节、抵达后重新铸造凭据」解决了它，命令附件是同一个问题，
因此采用同一答案。不需要任何拒绝码。

**图片不会先存本地。** 浏览器的图片部分已经携带 base64，所以归一化与摘要只做一次，
且发生在执行处理器的机器上。

**上限、取消、错误**

- 本地读取复用提示词路径的内联上限及其面向用户的错误，所以命令文件与提示词文件行为一致。
- `/commands/execute` 路由接受 12 MiB 请求体，与 `session-prompt` 一致，而不是默认的 256 KiB。
- 客户端的 signal 作为请求 signal 传递，远端把连接的取消转成处理器的 signal：
  取消会在远端产出 `kind: 'error'` 的 `command/done`。
- 远端的 `AttachmentError` 或 `RemoteError` 变成错误结果而非抛出，这正是把草稿与附件留在输入框的原因。

**当前状态。** 今天随附的八个命令注册（`command-goal`、`command-compact`、`command-feedback`、
`plan-mode`、`session-log-export`、`permission-presets` 的两个、`deepseek-account`）
都没有声明 `input.attachments`。因此这条路径是在还没有流量时先立下的规则；
当某个命令开始声明附件时，设计已经覆盖。

**显示名来自暂存引用，而不是提交内容。** 浏览器的文件部分是 `{ type: 'file', receiptId }`，
不携带文件名，所以名字必须从凭据所指的引用上读出来。第一次端到端运行抓到了这一点：
没有它，远端会把对象存成字面量 `file`，而单元测试因为传了一个浏览器从不发送的 `name` 而掩盖了缺陷。

### 6.5 序号重映射

`command/done` 携带的 `sourceEventSeq` 是**远端**编号。`appendRemoteEvent` 只重映射
`sourceEventSeqs`。镜像同样必须把 `command/done` 的 `sourceEventSeq` 经 `remoteToLocalSeq` 重映射，
并在目标未知时丢弃该字段——否则命令节点会引用一个无关的本地事件。

**执行返回值携带的 `sourceEventSeq` 原样透传，这是刻意的。** `/commands/execute` 的响应里
`result.sourceEventSeq` 同样是远端编号；适配器既不映射也不丢弃。此刻本地通常还没有它对应的
映射（`command/done` 尚未回放），猜一个本地 seq 只会把命令节点指向无关的事件；而聊天侧的
命令节点由**回放后的事件**渲染，节点引用的序号已经由 `commandDoneData` 重映射过。返回值里的
这个字段因此只属于远端编号空间，不是本地 seq。§11 记录该取舍。

### 6.6 契约检查

`remote/patch-contract.ts` 增加 `REQUIRED_COMMAND_METHODS = ['list', 'execute']` 与
`REQUIRED_SKILL_CATALOG_METHODS = ['list']`。这些字面列表的存在，是为了把插件**打算**替换的内容
与活的服务实际暴露的内容作比对，这样某个方法在版本中被悄悄删掉时，检查会失败，
而不是产出一个永远不会运行的适配器。

### 6.7 菜单新鲜度（可选，已接受）

`ui-commands` 缓存一个会话的目录，并在 `commands/change`、`agent-preset/selected`、
`connection/reset` 时失效。远端不会宣告它在会话中途安装的插件，所以适配器在远端描述符集合变化时
发一次 `commands/change`。这只是一行，用的是已在转发白名单上的事件；
省掉它的代价仅是在那一种场景下需要刷新页面。

## 7. 边界与失败

| 条件 | 行为 |
|---|---|
| 远端缺 `session.catalog` | 三个适配器全部委托；今天的现行为，不报错 |
| 远端缺 `session.command` | `execute` 委托：`/export` 与 `/feedback` 仍可用；其他命令降级为普通提示词文本，与今天一致 |
| `mirrorRemoteCatalog: false` | 全部委托 |
| 目录请求被丢弃或超时 | 返回原本的本地答案并记一条警告；菜单绝不会变成错误 |
| 执行超时 | 草稿按成功消费；结果随后经镜像日志抵达 |
| 草稿镜像的远端预设未知 | 远端答 `agent-preset/not-found`；本地委托 |
| 镜像的子会话 | 当 `subagentAddress` 已设置时，客户端本就短路两个来源；不变 |
| 向不接受附件的命令发送附件 | 用 DSH 自己的文本快速失败；草稿保留 |
| 文件凭据已无法解析 | 错误结果；草稿保留 |
| 超过内联上限的文件 | 提示词路径既有的「太大」错误 |
| 镜像会话被并发归档 | 远端自己的错误码浮现（`session/not-live` 等） |

## 8. 质量属性

- **兼容性。** `PROTOCOL_VERSION` 保持 `1`。两个新能力只在 agent 能服务它们时才上报，
  与今天 `session.file-attachment`、`attachment.read` 的判定方式一致。
- **安全性。** 转发只针对用户已经配对过的主机；远端执行它自己的命令定义，本地不编写任何命令语义。
- **可观测性。** 委托的目录、一次超时、一次白名单命中，各自记一条日志，所以用户报告仅凭日志即可定位。
- **性能。** 目录按会话缓存并带 TTL，并置于单飞（single-flight）获取之后，
  所以一次按键不会花掉一次隧道往返。客户端同样按会话缓存。

## 9. 依赖与假设

- 依赖已在 `main` 上的附件能力：`session.file-attachment`、`attachment.read` 与 `#admitForwardedFile`。
- 假设本地与远端 DSH 处于同一发行线（`>=0.2.2-rc.5`）；更旧的远端会降级。
- 假设远端组合了 `agentPresets`，Web bundle 总是如此；缺席时草稿目录委托。
- 假设 §11 中的两项取舍成立。
- 与并发附件工作的冲突面仅限于新增 `catalogAddressFor()`；`#promptContent`、
  `#prefetchAttachments` 以及 Agent 的 `model` 面均未触碰。

## 10. 验证

**单元与包级测试**

- `packages/protocol/test/catalog.test.ts` —— 守卫、路由匹配、按调用超时。
- `packages/remote-agent/test/catalog.test.ts` —— 活跃地址、带租约释放的草稿地址、执行转发、
  文件部分凭据重铸，以及主机无法服务时能力被省略。
- `packages/local-plugin/test/remote-catalog.test.ts` —— 非镜像的委托、镜像的转发、草稿路由、
  旧 agent 的降级、`mirrorRemoteCatalog: false`、本地白名单，以及附件的快速失败 / 超上限 /
  凭据缺失用例。
- `packages/testkit/src/fake-host.ts` —— 为上述测试实现三条新路由。
- `packages/local-plugin/test/mirror-lifecycle.test.ts` —— `command/done.sourceEventSeq` 的重映射，
  以及无法映射的值被丢弃。

**验收**

1. *给定*一个远端预设挂载了 `command-goal`、`command-compact` 与 `plan-mode` 的镜像会话；
   *当*用户输入 `/`；*则*菜单提供远端预设命令、远端全局命令与工程技能，与远端 Web UI 一致。
2. *给定*同一会话；*当*用户执行 `/goal do X`；*则*远端日志记录 `command/run` 与 `command/done`，
   本地会话记录就地渲染命令节点，且远端目标推进。
3. *给定*一个没有消息的草稿镜像；*当*用户输入 `/`；*则*菜单有内容且远端会话数量不变。
   *当*用户随后执行 `/goal do X`；*则*远端会话被创建，与发送一条消息完全一样。
4. *给定*镜像会话上的 `/compact`；*则*远端完成压缩且本地会话记录渲染命令节点；
   压缩检查点作为 replacement 回放，窗口放不进去时降级为只显示命令节点
   （机制与边界见 `docs/remote-workspace-mechanism.md` §5.8）。
5. *给定*一个不具备新能力的远端 agent；*则*菜单与执行与今天的现行为一致，日志无错误。
6. *给定*一个携带 `sourceEventSeq` 的远端 `command/done`；*则*本地命令节点绝不引用无关的本地事件。
7. *给定*一个非镜像的本地会话；*则*三个被适配的方法返回值与改动前完全一致。
8. *给定*一条携带附件的命令；*则*不接受附件的命令在本地失败并保留草稿，
   接受附件的命令在远端收到图片与文件块，其中文件经重铸的远端凭据。

## 11. 已接受的取舍

- `/export` 与 `/feedback` 在镜像会话上本地运行。转发它们需要改动客户端的下载钩子，本次工作不含此项。
- 菜单通过 `commands/change` 自愈。若复用其他特性的事件名被否决，省掉这一步的代价是：
  在会话中途远端安装插件后需要刷新页面。
- 命令附件与提示词路径共用内联上限；流式上传路由是另一项独立工作。
- **`/commands/execute` 的返回值透传远端序号。** §6.5 只要求回放的事件重映射
  （`command/done.sourceEventSeq`），因为命令节点由回放后的事件渲染；返回值里的同一个字段
  在本地没有按本地 seq 消费它的读者，而此时通常也还没有映射可查。映射一个不存在的目标只能
  靠猜，丢弃又会抹掉「这条命令指向远端哪个事件」的信息，所以保留原值并在 §6.5 写明它的编号空间。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档，加上 `README.md` 的一条 Documentation 条目 | 文档自检 |
| 1 | 协议：两个能力、三条路由、守卫、带按调用超时的客户端方法 | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | 远端 agent：`src/catalog.ts`、能力上报、三条 HTTP 路由（含 12 MiB 执行体与取消接线） | `packages/remote-agent/test/catalog.test.ts` |
| 3 | 本地插件：`src/remote/catalog.ts`、patch-contract 列表、两个设置项 | `remote-catalog.test.ts` |
| 4 | 镜像：`catalogAddressFor`、`command/done` 重映射、`commands/change` 的发送 | `mirror-lifecycle` 的补充用例 |
| 5 | 文档：`docs/protocol.md` 的能力/路由/错误表、`docs/remote-workspace-mechanism.md` §5.3 与新增一节、以及 CHANGELOG 条目 | 文档自检 |

切片 1 → 2 → 3 → 4 按依赖排序；切片 5 可以跟在切片 3 之后。每片以 `pnpm typecheck` 收尾；
整体完成需要 `pnpm install && pnpm typecheck && pnpm test && pnpm build`。
