# 编辑或删除排队中的消息，必须抵达远端队列

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

## 1. 背景与目标

镜像会话维护着自己的待发队列，用户在输入框里能看到它。DSH 客户端允许用户对它动手：
`QueueDock` 的行内提供**编辑**、**删除**以及（运行中时）**转为 steer**，全部走同一个 Remote 方法：

```ts
// dsh-api-session-controller/src/client/sessions/session.ts
async updateQueue(itemId: MessageId, action: QueueAction) {
  return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
}
```

在主机侧，`updateQueue` 按身份在**活的 Agent 收件箱**里查找该项：

```ts
// dsh-api-session-controller/src/commands.ts
const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
const located = nextTurn === undefined
  ? nextStep === undefined ? undefined : { target: 'next-step', message: nextStep }
  : { target: 'next-turn', message: nextTurn }
if (located === undefined) {
  throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId })
}
```

对镜像会话而言，那个 Agent 是镜像门面，它的收件箱是一个**本地数组**：

```ts
// packages/local-plugin/src/mirror/service.ts
function createMirrorInbox(session: Session): MirrorInbox {
  const nextTurn: unknown[] = []
  const nextStep: unknown[] = []
  return { remove(id) { ... list.splice(...); append(target, index, [], 1) }, ... }
}
```

而门面在远端运行时会这样处理：

```ts
followup(message) {
  if (this.#runtime.running) {
    this.inbox.splice('next-turn', this.inbox.nextTurn.length, 0, [message])
    return                      // 留在本地，直到 turn/end
  }
  this.#mirror.prompt(this.#runtime, message, 'queue')
}
```

于是存在一个真实的窗口——从用户在运行中的轮次里排入一条后续消息，到 `turn/end` 把它冲出去为止——
在此期间该项**只**存在于本地数组里。由此产生三个后果：

1. `updateQueue` 在本地**成功**（项确实在 `MirrorInbox` 里），改写或删除了本地条目并追加一条本地
   `agent/inbox/spliced`。远端毫不知情。
2. `turn/end` 时门面**只**冲出 `inbox.nextTurn[0]`——所以对远端来说，被编辑的那条并不是它以为
   被编辑的那条；而被删除的项如果与冲出过程竞态，可能已经被发出去了。
3. 最坏情况：用户「删除」了一条排队消息，远端却照跑不误，因为冲出逻辑在删除落地之前就捕获了该条目。

目标：在镜像会话上编辑、删除、转 steer 排队消息的行为，与本地会话一致——
远端最终收到的，是用户留在队列里的那条。

成功信号：

1. 删除一条排队项，意味着远端永远不会收到它。
2. 编辑一条排队项，意味着远端收到的是编辑后的文本。
3. 把一条排队项转为 steer，能进入正在运行的远端轮次。
4. 本地（非镜像）会话不受影响。

## 2. 范围与非目标

范围内：镜像会话的 `updateQueue` 接缝、与冲出之间的顺序规则，以及镜像无法履行时的拒绝。

范围外：

- 编辑**已经发往**远端的消息（那已是提交的历史，不是待发输入）。对此回答
  `session/queue-item-not-found` 是正确的，§7 记录这一点。
- 远端自己的队列界面。远端 Web UI 用户编辑同一项是远端的事；两个客户端都通过日志观察同一批持久化 splice。
- 把 `MirrorInbox` 改造成带实时复制的远端后端队列。§4 否决了它。
- 改动客户端。`QueueDock` 调用的 Remote 形状不变。

## 3. 用户与场景

1. **修正排队后续消息里的错字。** 用户在长轮次中排入第二条消息，在轮次结束前修改它。
   远端必须收到编辑后的文本。
2. **撤回一条排错的消息。** 用户删除一条排队项。远端绝不能运行它。
3. **从排队改为 steer。** 用户把一条排队项提升进正在运行的轮次。

## 4. 决策

**采用：在主机侧插桩 `updateQueue`，把变更应用到镜像收件箱，并让冲出逻辑在发送时重新读取收件箱。**

后半句是承重的部分。只插桩 `updateQueue`，仍然会留下「`turn/end` 冲出早于变更捕获的条目」这个问题；
顺序必须在冲出逻辑里修，而不是在写入方。

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 每次 splice 都向远端复制本地收件箱（逐次转发 `session.updateQueue`） | 远端没有任何待办项可供变更：什么都还没发过去，所以那边的 `updateQueue` 会答 `session/queue-item-not-found`。要让条目能在远端被编辑，它就得先被创建，也就是提前发送——队列存在的意义（「已排队、尚未投递」）就没了。 |
| B. 入队时立即发送，由远端持有 | 远端自己的队列随即与本地输入框分叉：本地那一行需要去镜像远端的 `agent/inbox/spliced` 事件，而镜像目前把这些事件当噪声丢弃（`isMirrorNoise` 过滤 `agent/inbox/spliced`）。两个队列，没有单一所有者。 |
| C. 允许本地变更成立，冲出时丢弃该项 | 静默丢掉一条用户编辑过的消息。 |
| D. 把 `updateQueue` 原样转发给远端 | 与 A 相同的失败：项不在那里。错误会以 `session/queue-item-not-found` 浮现，读起来像「你的消息已经发出去了」，与事实相反。 |

### 为什么不把远端收件箱镜像到本地

`isMirrorNoise` 刻意丢弃远端的 `agent/inbox/spliced` 事件，
`docs/specs/2026-11-26-remote-catalog-bridge.md` 记录了理由：远端收件箱描述的是
*远端的待发输入*，把 splice 在本地回放会让一个只属于远端的变化改写本地输入框显示的内容。
让本地队列保持本地是同一条原则。本 spec 不推翻它；它修的是本地队列最终排出时的行为。

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。

- **R1** 对一条待发的镜像项调用 `updateQueue({action:'remove'})`，意味着远端永远不会收到它。
- **R2** `updateQueue({action:'edit'})` 意味着远端收到编辑后的内容。
- **R3** 在运行中的镜像上 `updateQueue({action:'steer'})`，会把该项作为 steer 投递。
- **R4** 任何地方都不再待发的项，回答 `session/queue-item-not-found`（形状不变）。
- **R5** `turn/end` 的冲出发送**当时**位于收件箱里的那一项，绝不是陈旧副本。
- **R6** 本地会话的 `updateQueue` 不变。
- **R7** 变更与冲出竞态时结果确定：或者冲出已经取走该项（于是变更回答 `not-found`），
  或者变更生效、冲出发送新内容。

## 6. 设计

### 6.1 接缝

`updateQueue` 是 `sessionController` 上的 Remote，不在 Agent 上。客户端调用
`remote.session.updateQueue`，网关按调用针对活的 `sessionController` 实例解析——
所以插桩点就是该实例，沿用 `remote/files.ts` 与 `remote/terminal-controller.ts` 的模式。

```ts
REQUIRED_SESSION_CONTROLLER_METHODS = ['updateQueue'] as const   // patch-contract.ts
```

### 6.2 路由与变更

```ts
sessionController.updateQueue = (request) => {
  const runtime = mirrors.runtimeForLocalSession(request.sessionId)
  if (runtime === undefined) return original.updateQueue(request)
  return applyMirrorQueueMutation(runtime, request)   // 见下
}
```

`applyMirrorQueueMutation` 针对 `MirrorInbox` 复刻原生方法的行为：

| 动作 | 本地效果 | 远端效果 |
|---|---|---|
| `remove` | `inbox.remove(id)` | 无——该项从未成为远端状态 |
| `edit` | `inbox.replace(id, editedMessage)` | 对尚未发送的项无 |
| `steer` | `inbox.remove(id)`，再作为 steer 投递 | `prompt(runtime, edited, 'steer')` |

`edit` 只接受文本，与原生规则一致（`QUEUE_EDIT_NON_TEXT`）；镜像必须在变更**之前**应用同样的校验，
这样一次被拒的编辑不会动到队列。

本地 `agent/inbox/spliced` 的追加由 `MirrorInbox` 自己完成，所以输入框的投影无需第二次写入。
**不发明任何新的本地事件。**

### 6.3 冲出必须重新读取（R5、R7）

今天的实现：

```ts
} else if (runtime.agent.inbox.hasPending) {
  const next = runtime.agent.inbox.nextTurn[0]
  if (next !== undefined) {
    runtime.agent.inbox.remove(messageIdentity(next))
    this.prompt(runtime, next, 'queue')
  }
}
```

`next` 是数组元素，只读一次。这已经等于「在冲出时重新读取」——条目就是轮次结束时数组里的东西——
所以只要 `remove`/`replace` 原地修改同一个数组（`MirrorInbox` 正是如此），R5 就成立。
因此该需求主要是测试义务而非代码改动；§12 把它钉住，是因为那个显而易见的「优化」
（入队时就捕获条目）会破坏它。

真正的风险在交错：`applyMirrorQueueMutation` 是同步的（只动数组），而 `turn/end` 的处理
来自事件流。二者跑在同一条 JS 轮次队列上，且在读取与 splice 之间没有 await，
所以 R7 的确定性由此而来：`hasPending` 与 `remove` 之间不得存在 await。
§12 用一条「在事件处理器内触发变更」的测试守住这一点。

### 6.4 Steer

`action.kind === 'steer'` 只对 `next-turn` 项、且 Agent 处于 `running` 时有效（原生守卫）。
镜像的 `status` 跟随 `runtime.running`，而后者跟随远端 `turn/start`/`turn/end`，所以同一个守卫适用。
成功时镜像调用它既有的 steer 路径，经由 `#sendPrompt(..., 'steer')`——
也就是 `RemoteMirrorAgent.steer` 走的同一个调用，因此只有一条投递路径，不是两条。

### 6.5 远端看到什么

什么也看不到。这正是重点：只有当冲出投递它时，该项才成为远端状态，
带着它当时持有的内容。用户在**那之后**再编辑的情形由 §7 覆盖。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| 该项已不再待发 | `session/queue-item-not-found`（R4）。冲出已经取走它时可触发。 |
| 编辑内容为空或非文本 | 原生代码的行为；镜像在变更前应用同样两个错误。 |
| 未运行时 steer | `session/steer-unavailable`，与原生一致。 |
| 对 `next-step` 项 steer | 拒绝，与原生一致。 |
| 主机断开 | 变更在本地生效，投递在冲出时失败——已通过 `#reportPromptError` 的通知路径浮现（1.1.4）。 |
| 远端取消（`turn/end` 原因 `aborted`） | `inbox.clear()`——不变；排队项随轮次一起丢弃，与原生取消一致。 |
| 另一个客户端编辑同一条远端项 | 从这里观察不到：该项在发出前不是远端状态。记录于 §11。 |
| 用户删除了冲出刚好取走的项 | 回答 `not-found`；消息已在飞行途中。这是诚实的，若未送达，通知路径会上报投递失败。 |

## 8. 质量属性

- **延迟。** 纯本地；队列 UI 不增加往返。
- **一致性。** 每项一个所有者：发送前属本地，发送后属远端。不存在二者同时持有副本的时刻。
- **影响面。** 一个被插桩的方法，加上一条共享投递路径。`MirrorInbox`、冲出逻辑与提示词路径
  保持现有契约。

## 9. 依赖与假设

- 假设 `sessionController.updateQueue` 保持其请求形状（`sessionId`、`itemId`、`action`）。
- 假设 `MirrorInbox` 继续原地修改其数组（冲出逻辑依赖这一点）。
- 假设 `QueueAction` 的变体仍是 `edit | remove | steer`；新增变体必须在此作答或被显式拒绝。
- 假设客户端的 `QueueDock` 继续读取投影，因此刷新它的是本地 `agent/inbox/spliced`。

## 10. 验证

**单元与包级测试**

- `packages/local-plugin/test/remote-queue.test.ts`（新增）：
  - 删除一条排队项 → 冲出什么都不发，且本地投影显示删除；
  - 编辑一条排队项 → 冲出发送**编辑后**的文本（断言转发出去的提示词体）；
  - 运行中 steer → 一次带该项内容的 steer 调用，且收件箱清空；
  - 用非文本内容编辑 → `session/attachment-invalid`，收件箱不变；
  - 在冲出已取走该项后再删除 → `session/queue-item-not-found`；
  - 非镜像会话 → 调用原方法（断言是同一性，而非行为）；
  - 在结束轮次的事件处理器内部触发变更 → 结果符合 R7 的确定性。
- `packages/local-plugin/test/mirror-robustness.test.ts` —— 既有的冲出顺序测试保持转绿。

**验收**

1. *给定*一个轮次进行中的镜像会话；*当*用户排入一条后续消息并在轮次结束前删除它；
   *则*远端日志中没有它的 `user/message`。
2. *给定*同上；*当*用户编辑排队文本且轮次结束；*则*远端收到编辑后的文本，
   本地会话记录显示一个带该文本的气泡。
3. *给定*同上；*当*用户改为 steer；*则*正在运行的远端轮次把它作为 steer 收到，队列中没有残留。
4. *给定*一个本地会话；*则*编辑/删除/steer 的行为与之前完全一致。

## 11. 已接受的取舍

- **队列不做远端复制。** §4 的方案 A、B 记录了本地队列为何保持本地；代价是另一个客户端
  看不到也改不了一条尚未发送的项。这与本地会话一致——那里的队列同样在投递前只属于本进程。
- **`edit` 只接受文本，与原生一致。** 支持附件编辑需要更丰富的 action 和一条重传路径；
  超出范围，且客户端今天也没有这项需求。
- **删除与冲出竞态时回答 `not-found`。** 对一个已经离开队列的项，这是诚实的回答。
- **拒绝是结构化构造的，不是 `RemoteError` 实例。** `@deepseek-ai/dsh-typert-protocol` 不是本插件的依赖，
  而「不新增运行时依赖」的约束把它排除在外；实现设置 `code`、`details` 与 `isDSHRemoteError: true`
  （`remoteErrorOf` 记录的结构契约），让状态码能穿过网关。若某个版本的网关只认真正的实例，
  这些拒绝会退回 `gateway/internal`，与今天 `remote-path.ts` 处的行为一致，没有回归。
- **删除排队项不会顺带收回已暂存的上传。** 原生命令会调 `fileUploads.retirePrompt`；本 spec 的
  §6.2 只列了 `inbox.remove(id)`，而 §2 禁止发明行为，所以暂存附件留到正常清理时才消失。
  这是一处刻意的省略，而不是遗漏。
- **`runtimeForLocalSession` 也返回已停止的运行时。** 停止结束的是远端流，不是本地队列，而一次后续
  提示词会让运行时复活，所以那个 inbox 仍然是该队列项的归属。没有新增 `stopped` 过滤。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | 镜像：`runtimeForLocalSession` 访问器 + `applyMirrorQueueMutation`，复用既有投递路径 | `remote-queue.test.ts` |
| 2 | 本地插件：在 `sessionController` 上插桩 `updateQueue`、`REQUIRED_SESSION_CONTROLLER_METHODS`、`ctx.inject` 块 | `remote-queue.test.ts` |
| 3 | Testkit：暴露 `updateQueue` 的 `sessionController` 替身 | 既有测试套件转绿 |
| 4 | 文档：`docs/remote-workspace-mechanism.md` §5.3（门面表格增加一行）、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 → 2 按依赖排序。每片以 `pnpm typecheck` 收尾；整体完成需要
`pnpm install && pnpm typecheck && pnpm test && pnpm build`。
