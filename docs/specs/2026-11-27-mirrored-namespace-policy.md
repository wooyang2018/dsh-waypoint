# 镜像会话不得静默接受它无法转发的写入

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

## 1. 背景与目标

有若干主机侧 Remote 命名空间以 `Agent` 寻址，而对镜像会话来说那个 Agent 就是门面
`RemoteMirrorAgent`。该门面注册在本地 `agents` 注册表里（这正是会话能渲染出来的原因），
所以 `agents.get(id) === agent` **成立**，每一道 `assertLive` 守卫都能通过。
服务随后就像会话是本地的一样，读写本地状态。

由此产生三种不同的行为，而其中只有一种是可容忍的：

| 行为 | 例子 | 判定 |
|---|---|---|
| **读取正确**，因为事实以回放事件抵达 | `goals.get`、`todos`、权限 chip、计划 chip | 可以，不动 |
| **读取错误或为空**，因为事实只存在于远端进程 | `jobs.list`、`schedule.catalog`、`agentTeams` 状态 | 误导 |
| **写入在本地静默成功、永远到不了远端** | `goals.create/edit/pause/resume/complete/clear`、`subagents.prompt/interruptByUser`、`messageFeedback.put/delete`、`jobs.kill` | 数据丢失陷阱 |

第三行是严重的那一类。用户在镜像会话上设了一个目标，横幅出现了，镜像自己的轮次驱动器
甚至可能开始继续本地投影——而真正在跑这段对话的远端 agent 一无所知。没有任何报错。
这份状态不只是会在下次重建时丢失，它在会话存活期间一直是**错的**，而且会驱动行为。

目标：镜像会话的 Remote 表面积要么把请求转发给拥有状态的主机，要么以用户可以据以行动的原因拒绝。
它绝不能让一次写入假装成功。

成功信号：

1. 在镜像会话上写目标，要么改变远端目标，要么说明为何做不到。
2. `jobs`、`agentTeams` 绝不显示一个自信的空列表或陈旧列表。
3. 每次拒绝都是带本地化消息的具名错误，而不是泛泛的失败。
4. 本地会话不受影响。

（`schedule` 不在信号 2 之列：它在 §2/§6.5 里是范围外的独立特性。初稿把它和 jobs 并列，
于是落地当天这条信号就是假的；review 之后收窄为「被适配的那些命名空间」。）

## 2. 范围与非目标

范围内：把每个以 `Agent` 寻址的 Remote 命名空间针对镜像会话做分类、逐项给出转发或拒绝、
pin/fork 策略，以及一个「设置形状」的例外。

范围外：

- 成体系地实现新的远端能力。只新增两个很窄的能力（§6.3），因为一个无法作答的读取比拒绝更糟；
  其余一律拒绝。
- 镜像远端的后台任务进程。任务属于孵化它的那个进程。
- 调度器。计划是主机全局的、不是会话级的，§6.5 解释为何保持本地。
- 改动任何客户端插件。以上全部是主机侧适配。

## 3. 用户与场景

1. **在镜像会话上设目标。** 用户输入 `/goal do X`。今天目标在本地出现，远端从未看见。
   改动后会抵达远端。
2. **查看后台任务。** 用户在镜像会话打开任务列表。今天无论远端在跑什么，它都是空的；
   改动后要么显示远端的任务，要么说明拿不到。
3. **切换团队模式。** 用户拨动团队开关；它不能静默地什么都不做。

## 4. 决策

**采用：按「是否有回放事件携带该事实」分类，路由成本低的就转发，成本高的就拒绝，
读取本来就正确的一律不动。**

分类本身就是交付物；它应当以一张表的形式活在代码里，这样新增命名空间是一次**有意的决定**，
而不是一次遗漏。

| 命名空间 | 种类 | 镜像行为 | 路由 |
|---|---|---|---|
| `goals` | 写 | **转发** | `POST /sessions/:id/goals`（body 为 `{ op, … }`，§6.3） |
| `jobs` | 读 | **转发** | `GET /sessions/:id/jobs`（§6.3） |
| `jobs.kill` | 写 | 拒绝 | §6.4 |
| `schedule` | 主机全局 | **不适配** —— §6.5 | — |
| `agentTeams.setEnabled` | 写 | 按 §6.6 转发或拒绝 | `POST /sessions/:id/team` |
| `subagents.prompt` | 写 | 拒绝 | §6.4 |
| `subagents.interruptByUser` | 写 | 拒绝 | §6.4 |
| `messageFeedback` | 写 | 拒绝 | §6.4 |
| `toolResults.watch` | 实时流 | 拒绝（空流） | §6.4 |
| `workspace.pinSession` | 本地视图 | 保持本地，写进文档 | §6.7 |
| `session.fork` | 结构性 | 拒绝 | §6.8 |
| `todos`、`permissions`、`plan`、`agentPreset`、`model` | 读 | 不动（本就正确） | §6.2 |
| `terminals` | 混合 | 已由 `remote/terminal-controller.ts` 适配 | — |
| `workspaceFiles`、`fs`、`subprocess`、`sandbox`、`workspaceChanges` | 混合 | 已适配 | — |

表里的命名空间用概念名书写；线上 Typert 命名空间是单数 `job`（`job/list`、`job/follow`、
`job/kill`），`MIRRORED_METHOD_POLICY` 的键用的是线上名。

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。

- **R1** 镜像会话上的任何写入都不得在未抵达远端的情况下报告成功（goal、team）。
- **R2** 镜像会话上的任何读取都不得返回与远端矛盾的本地值（jobs）。
- **R3** 每次拒绝都是带稳定 code 与 `messages.ts` 中 `ui` key 的 `LocalError`。
- **R4** 本地会话在上述每个命名空间上的行为字节级不变。
- **R5** 分类是数据而不是散落的条件分支：每个**被适配的操作**（`<namespace>/<method>`）都在表里
  有一行，`Agent` 寻址命名空间的清单被一条测试钉住，且被适配命名空间上**新增的**操作会由
  `uncoveredEndpoints` 报告出来，而不是默默继承命名空间的默认值。
- **R6** 旧 agent **不**退化为本地的现行为：写操作以 `mirror/unsupported`（`ui` key 为
  `error.agentOutdated`）拒绝，读操作报错而不是给出空值。旧 agent 与断线是同一类事实——远端状态拿不到
  ——答案必须一致。本条的初稿写的是「退化为现行为」，那正是本设计要消灭的静默写入，review 之后改掉。

## 6. 设计

### 6.1 一张分类表（R5）

`packages/local-plugin/src/remote/namespace-policy.ts`：

```ts
export type MirroredPolicy = 'delegate' | 'forward' | 'refuse' | 'local-view'

// 整份命名空间只有一种策略的，按命名空间写。
export const MIRRORED_NAMESPACE_POLICY = {
  session: 'delegate', workspace: 'delegate', schedule: 'delegate',
  terminal: 'delegate', workspaceFiles: 'delegate', /* …其余整份委托的 */
} as const satisfies Record<string, MirroredPolicy>

// 表面积不统一的，**按操作**写，一个端点一行。
export const MIRRORED_METHOD_POLICY = {
  'goals/create': 'forward', 'goals/get': 'delegate', /* …其余六个 op */
  'agentTeams/setEnabled': 'forward',
  'job/list': 'forward', 'job/follow': 'forward', 'job/kill': 'refuse',
  'subagents/prompt': 'refuse', 'messageFeedback/put': 'refuse',
  'toolResults/watch': 'refuse', 'session/fork': 'refuse',
  'workspace/pinSession': 'local-view', /* … */
} as const satisfies Record<string, MirroredPolicy>
```

**为什么不是「一个命名空间一个默认值」。** 初稿那样写在两处会坏事：`jobs` 标成 `forward`，
那么将来 DSH 给 `jobs` 加一个 `restart`，它就会默默跟着转发——而 `kill` 之所以拒绝，正是因为
「对另一台机器的进程下手」需要一条本设计没有引入的路由。同理 `session` 标成 `delegate`，而
`fork` 必须拒绝。所以被适配命名空间的**默认值是「没有策略」**：`policyFor(ns, 未知方法)` 返回
`undefined`，由 `uncoveredEndpoints` 报告出来，新的操作必须先被分类才能生效。

§12 的测试分两层核对：`HOST_REMOTE_NAMESPACES`（本项目锁定的 DSH 版本里以 `Agent` 寻址的命名空间
清单）必须全部有策略；被适配命名空间上的每个操作也必须有策略，多一个就报。

### 6.2 读取本就正确的一律不动（R4）

`todos`、权限预设、计划模式、agent 预设、模型选择都从镜像回放的事件里折叠而来
（`todo/write`、`permission/preset`、`plan/mode`、`agent-preset/selected`、`model/selection`
都在 `KNOWN_SESSION_EVENT_TYPES` 里，且都不在 `isMirrorNoise` 中）。
这些界面已经是对的；动它们只有回归风险、没有收益。§12 用「保持不变」的断言钉住它们，而不是新增代码。

### 6.3 两个被转发的命名空间

**Goals。** 写路径是 `ctx.goals.<op>(agent, …)`，每个都会提交一条本地 `goal/change`。
对镜像改为转发操作、由远端提交：

```ts
POST /sessions/:id/goals   body: { op: 'create'|'edit'|'pause'|'resume'|'complete'|'clear', ...args }
```

在远端，Agent 由会话 id 解析（`ctx.agents.get`），在那里是真正的 Agent。
由此产生的 `goal/change` 回放进本地投影，所以 `goals.get` 无需改动即可继续工作，
横幅从事件更新——不需要第二个写入方。

**Jobs。** `jobs.list` / `jobs.follow` 是读取。这是唯一「拒绝会明显糟于转发」的地方：空任务列表与
「什么都没在跑」无法区分，而盯着一个长构建的人恰恰最会去看它。

路由是两条 **`GET` 流**（`GET /sessions/:id/jobs` 与 `GET /sessions/:id/jobs/:jobId?from=N`），
不是初稿写的一次性 `POST` 列表：名册与输出都是活订阅，快照一返回就开始过期，而成功信号要的正是
「不显示陈旧列表」。本仓库协议自己的规则也是「读路由用 GET」，只有会改状态的动作才用 POST。

### 6.4 拒绝

每次拒绝都是同一种形状：`retryable: false` 且带 `ui` key 的 `LocalError`。

| 操作 | code | 为什么拒绝而不是转发 |
|---|---|---|
| `jobs.kill` | `mirror/unsupported` | 终止需要远端任务 id，而它与本地 id 不同；用错 id 可能杀掉无关进程。携带 id 的路由属于后续工作，不是静默猜测。 |
| `subagents.prompt` | `mirror/unsupported` | 子会话已被镜像，但对它的**控制**属于远端进程状态。转发需要一条子会话寻址路由；本地写入会造出一个远端永远不会孵化的本地子会话。 |
| `subagents.interruptByUser` | `mirror/unsupported` | 同上，而一次打偏的中断比一次拒绝更糟。 |
| `messageFeedback.put/delete` | `mirror/unsupported` | 反馈是关于用户正在阅读的这段对话的遥测。记在本地或许也说得通，但让它与远端的静默分家则不然；拒绝，把决定留给后续改动（§11）。 |
| `toolResults.watch` | 空流 | 实时工具结果流由执行工具的那个进程喂。镜像轮次的流已由 `assistant-events` 承载；再来一条空流会让轨迹视图显得坏掉，而不是不可用。 |

对 `toolResults.watch` 而言形状是「不产出任何帧并完成」，因为消费方把已完成的流理解为
「没有更多实时帧了」——而这正是事实。

### 6.5 计划是主机全局的，不是会话级的

`remote.schedule.*` 不以 Agent 寻址；它是主机全局注册表，而镜像会话的计划在远端。
适配它意味着镜像整套计划目录及其 `schedule/changed` 流——那是另一个特性，不是本特性的缺口。
它**不在范围内**，在此列出是为了让这个省略是刻意的、可被发现的。

### 6.6 团队模式

`agentTeams.setEnabled(sessionId, enabled)` 在会话上写 `team/mode`。对镜像而言这是一个远端永远收不到的
本地事件，而远端自己的团队机制保持原状态——最坏的组合。走与 goals 同一族的路由转发
（`POST /sessions/:id/team`）；远端提交 `team/mode`，镜像回放它。
如果第一轮切片不值得做这条路由，§12 的切片 4 允许先落地**拒绝**——但不能保留静默的本地写入。

### 6.7 Pin 是本地视图偏好（R5，已写入文档）

`workspace.pinSession` / `unpinSession` 写入本地工作区注册表的 `pinnedSessionIds`。
置顶是用户所在机器上侧边栏的排序偏好，与窗口位置同类；远端 Web UI 有它自己的一份。
这**本来就是对的**，本文档记录下来，免得日后被人「修」成转发调用，让用户的远端侧边栏莫名其妙地重排。

### 6.8 Fork 是结构性的，必须拒绝（R1、R3）

镜像上的 `session.fork` 会用 `buildForkSeed(source.events, boundary)` 从回放日志构造本地子会话——
那是投影上的本地序号，得到一个没有远端对应物、没有远端预设组合、
cwd 还是本地锚点的子会话。它看起来像一次成功的 fork，实际不可用。以具名原因拒绝。

### 6.9 契约检查

按既有字面名模式扩展 `remote/patch-contract.ts`，加入每个被适配命名空间所暴露的方法，
这样 DSH 版本重命名其中之一时，症状是被上报的「路由关闭」，而不是一次静默的本地写入。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| agent 早于 goal/job 路由 | 写操作以 `mirror/unsupported` 拒绝（`ui: error.agentOutdated`，消息点名主机）；读操作报错而不是给空值。**不**退化为本地行为：那正是本设计要消灭的静默写入（R6）。 |
| 远端拒绝某次目标操作（它自己的校验） | 远端的错误浮现；不写本地 `goal/change`。 |
| 主机断开 | 转发 reject；操作上报失败。**不得**回落到本地写入。 |
| 本地会话上的被拒操作 | 永远走不到：策略在任何拒绝之前就委托了。 |
| DSH 版本中出现新命名空间 | §6.1 的命名空间清单测试失败，直到它被分类。 |
| DSH 版本给被适配命名空间加了新操作 | `uncoveredEndpoints` 报告它（启动告警 + 测试），且它**没有**继承任何策略。 |

## 8. 质量属性

- **诚实。** 没有任何操作会在状态并不存在于应在之处的情况下报告成功。
- **可发现性。** 每次拒绝都带有用户可读、可据以行动的消息。
- **影响面。** 一个新策略模块、两条窄路由、表驱动的拒绝。既有适配器不变。

## 9. 依赖与假设

- 假设 `ctx.goals`、`ctx.jobs`、`ctx.agentTeams` 保持以 `Agent` 寻址的签名。
- 假设镜像回放 `goal/change`、`team/mode`、`team/task`（确实如此；它们都不被过滤）。
- **拒绝的可见性不如 §9 初稿的假设。** 初稿说客户端会经 `mirrorPromptFailed` 那条通道渲染拒绝；
  那条通道只接提示词转发失败。被拒的 `/goal` 或团队开关走的是**这次 Remote 调用自己的返回**：
  `LocalError` 带 `mirror/unsupported` 与 `ui` key，但 DSH 网关把主机侧抛出的错误折成
  `gateway/internal`，只保留 `message`。所以用户今天看到的是英文原文（它点名操作、说明该去哪里做），
  本地化 key 要等客户端侧有格式化器才生效。见 §11。
- 假设 `session.fork` 仍接受 `{ sessionId, atSeq? }`。

## 10. 验证

**单元与包级测试**

- `packages/local-plugin/test/namespace-policy.test.ts`（新增）——该表覆盖主机暴露的每个
  以 `Agent` 寻址的 Remote 命名空间（从活的服务上枚举，于是新增一个就会失败）；
  每个 `refuse` 条目答出文档规定的 code 与 `ui` key；每个 `delegate` 条目调用原实现。
- `packages/local-plugin/test/remote-goals.test.ts` —— create/edit/pause/resume/complete/clear
  在镜像上转发；回放的 `goal/change` 更新 `goals.get`；远端拒绝时不写本地事件；旧 agent 降级。
- `packages/local-plugin/test/remote-jobs.test.ts` —— `list` 返回远端列表；主机断开时报错而不是返回空列表；
  `kill` 拒绝。
- `packages/local-plugin/test/remote-refusals.test.ts` —— subagents、messageFeedback、toolResults、fork
  各自答出文档规定的 code；`toolResults.watch` 无帧完成。
- `packages/local-plugin/test/pin-local.test.ts` —— pin/unpin 仍写本地注册表且不发远端调用
  （守住 §6.7）。

**验收**

1. *给定*一个镜像会话；*当*用户执行 `/goal do X`；*则*远端的 goal 存在，本地横幅在事件回放后显示它。
2. *给定*同上；*当*远端正在跑一个后台任务；*则*任务列表显示它。
3. *给定*同上；*当*用户尝试 fork 它；*则*出现具名拒绝，且不创建任何会话。
4. *给定*一个本地会话；*则*上述每个命名空间的行为与之前完全一致。
5. *给定*一个新增了以 `Agent` 寻址命名空间的 DSH 版本；*则*策略测试失败，直到它被分类。

## 11. 已接受的取舍

- **`messageFeedback` 选择拒绝而不是记在本地。** 记在本地也说得通（反馈针对的是用户读到的东西），
  但那会让远端的遥测与本地分家且无从对账。拒绝是可逆的；一条错误的记录不是。
- **任务控制选择拒绝而不是转发。** 需要本 spec 未引入的远端 id 映射。
- **转发范围刻意只有两个命名空间。** 每个被转发的命名空间都是一条协议路由加一次远端服务调用；
  拒绝的成本只是零头，却消除了陷阱。后续改动可以把某个拒绝提升为转发，而不必改变这份分类的形状。
- **计划是独立特性。** §6.5。
- **初稿曾把 `schedule` 与 jobs 并列，成稿已收窄。** 初稿 §1 的信号 2 要求计划也不能显示空列表；
  成稿的 §1 与 §2/§6.5 已把计划排除在范围之外（它是主机全局注册表，不是会话级状态），
  §10 也没有任何一条要求计划非空。实现按 §6.5 处理：`schedule` 不改，省略本身在分类表、
  机制文档与 Known limits 里都写明了，于是它是可发现的，而不是被忘掉的。
- **任务路由是 `GET`，初稿写的是 `POST`。** 名册与输出都是 SSE 流，本仓库协议自己的规则是
  「读路由用 GET」；只有会改变状态的动作留在 POST。
- **`op: 'block'` 也转发（七个 op，不是六个）。** 它同样追加 `goal/change`，而本地轮次驱动器会在镜像
  会话上调用它；把它留在本地等于留下最后一处静默写入。
- **`jobs.kill` 的拒绝理由改了。** §6.4 给的理由是「远端 id 与本地不同」；名册转过去之后 id 就是远端的，
  所以现在说的是实情：本次改动没有远端任务控制路由。
- **覆盖检查是「运行时告警 + 固定清单测试」，不是真机 DSH 测试。** 插件不依赖 `dsh-goal`/`dsh-jobs`
  这些包，测试无法把它们启动起来。`reportUnclassifiedNamespaces` 枚举活的 `ctx.typert.local.list()`，
  筛出 `scope.context === 'agent'` 的命名空间并对未分类者告警；测试钉住的是这个 DSH 版本的清单。
  因此升级 DSH 基线时要重新推导这份清单——模块注释就写在那份数据旁边。
- **`ui` key 不跨越 Remote 边界。** DSH 网关把抛出的主机错误变成 `gateway/internal`，只保留 `message`。
  R3 的形状在主机侧成立并被测试钉住；用户今天看到的是英文消息本身（它点名操作并说明该去哪里做）。
  让 key 可见需要客户端侧的格式化器，那是另一件事。
- **转发让若干同步的 goal 方法变成异步。** 诚实的答案需要一次往返；DSH 网关每条 Remote 结果都 await，
  所以线上路径不受影响。进程内调用方只有 `/goal` 命令（镜像上它经目录桥在远端执行，走不到这些方法）
  与轮次驱动器（忽略返回值）。唯一会踩到同步调用方的配置是「远端挂载了 goals 但没有命令目录」，
  这一点写在 `namespaces.ts` 与 Known limits 里。
- **`messageFeedback.list` 不拒绝。** §4 把该命名空间归为写，§6.4 只点名 `put`/`delete`；`list` 读的是
  本地日志并诚实地答「这里没有反馈」，所以委托。
- **review 之后改掉了两处「会把要修的问题放回去」的设计。** 其一，R6 初稿让旧 agent 退化成今天的本地
  行为：对 `goals.create` 那就是横幅出现、远端毫不知情，正是本设计存在的理由；对 `jobs.list` 那就是
  一份自信的空列表。现在旧 agent 与断线得到同一个答案（写拒绝、读报错），并复用既有的
  `error.agentOutdated`（「远端 agent 过旧，点 Reinstall」）。其二，分类表初稿是一命名空间一个值，
  而 `job`（名册转发、kill 拒绝）与 `session`（委托、fork 拒绝）都需要按操作区分；现在被适配命名空间
  按端点逐条登记，默认值改为「没有策略」，新增操作由 `uncoveredEndpoints` 报告。
- **`REPLAYED_PROJECTIONS` 是常量而不是策略行。** `todos`/`permissions`/`plan`/`agentPreset`/`model`
  是投影键、不是 Remote 命名空间；给它们一个策略值等于邀请别人来写适配器。测试断言它们**不在**表里。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | `remote/namespace-policy.ts` + 完备性测试；为 subagents、messageFeedback、toolResults、fork 接上拒绝 | `namespace-policy.test.ts`、`remote-refusals.test.ts` |
| 2 | Goals：协议路由 + agent 处理器 + 本地转发 | `remote-goals.test.ts` |
| 3 | Jobs：协议路由 + agent 处理器 + 本地转发（仅 `list`/`follow`） | `remote-jobs.test.ts` |
| 4 | 团队模式：转发（§6.6），若切片 4 推迟则先落地拒绝 | `remote-goals.test.ts` 的 team 用例 |
| 5 | Pin/fork 文档 + pin 防回归测试 | `pin-local.test.ts` |
| 6 | 文档：`docs/remote-workspace-mechanism.md`（§5.3 下新增一张表、Known limits 增加一行）、`docs/protocol.md` 的路由/能力、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 独立且交付了大部分价值（它消除了每一处静默写入）。切片 2 与 3 互相独立。
每片以 `pnpm typecheck` 收尾；整体完成需要
`pnpm install && pnpm typecheck && pnpm test && pnpm build`。
