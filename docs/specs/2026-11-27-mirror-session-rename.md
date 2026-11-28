# 重命名镜像会话，必须重命名它的远端会话

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

## 1. 背景与目标

侧边栏的重命名动作抵达主机的 `sessionController.rename`，它把标题写进自己持有的那个会话：

```ts
// dsh-api-session-controller/src/commands.ts
const accepted = titles.rename(agent.session, request.title)
return { title: accepted.title, seq: accepted.eventSeq }
```

对镜像会话而言，控制器持有的会话是**本地投影**。于是重命名把 `session/title` 写进本地日志，
侧边栏立刻显示新名字，而远端会话保留原封不动的旧标题。两个后果：

1. 远端 Web UI——以及任何连接到远端的其他客户端——显示的是旧标题。
2. **重命名在真正重要的方向上不持久。** `session/title` 事件只有在本地日志被重建时才会从远端日志回放，
   所以重新添加工作区、镜像被裁剪、或换一台机器，都会恢复成**远端**的标题，本地的重命名消失了。

`session/title` 不在 `isMirrorNoise` 里，所以远端的标题事件能正确回放；缺口只在一个方向上。

目标：重命名镜像会话时，把标题设到远端会话上，本地投影从随后产生的事件收敛，
而不是成为这次变更的唯一记录。

成功信号：

1. 重命名镜像会话改变远端 Web UI 中的标题。
2. 新标题在镜像重建后仍然存在。
3. 本地（非镜像）会话不受影响。
4. 旧 agent 退化为今天的现行为（本地重命名），且不报错。

## 2. 范围与非目标

范围内：把 `rename` 转发到远端、两次写入之间的顺序，以及远端拒绝时的失败上报。

范围外：

- 自动标题。`dsh-session-title` 已经在远端运行并写出自己的 `session/title`；
  这些事件正常回放，这正是未被触碰的镜像本来就能显示远端标题的原因。
- 重命名**工作区**。`workspaceController.rename` 改的是本地镜像行，其标题是
  `<主机标签> · <远端标题>`；远端工作区标题是另一个对象，也不是侧边栏行显示的东西。
- 批量重命名，或从设置页重命名。
- 新增事件类型。`session/title` 两侧都已存在。

## 3. 用户与场景

1. **给会话一个有意义的名字。** 用户重命名镜像会话；名字必须留住，而且必须是
   打开远端 Web UI 时看到的那个名字。
2. **重命名后重连。** 用户重命名、断开、重连，期望名字还在。

## 4. 决策

**采用：先把重命名转发给远端，让本地投影跟随回放的事件；仅当远端无法接受时才写本地。**

顺序与归档**相反**，这个差别是刻意的——`docs/remote-workspace-mechanism.md` §5.7 已经确立
「这两个方向应当按动作不同而以不同方式失败」。

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 先写本地，再转发（归档的顺序） | 本地写入正是让侧边栏变化的东西；远端一旦拒绝，两份日志永久不一致，而本地标题会在下次重建时丢失。重命名重试代价很低，也不存在「行被隐藏」这类后果，因此没有理由把本地一致性置于诚实的失败之上。 |
| B. 只转发，不写本地，依赖回放的事件 | 原则上正确，但侧边栏要等事件往返（一个轮询间隔）才更新。可以接受，本设计也确实如此——但只在远端接受**之后**，这样一次拒绝留下的是旧标题，而不是一个即将变错的标题。 |
| C. 插桩 `sessionTitle.rename` 而不是 `sessionController.rename` | 该服务以 `Session` 寻址，镜像将不得不区分「用户重命名」与「远端自身的回放」。控制器是面向用户的接缝，也是侧边栏抵达的那个。 |
| D. 事后追加一条本地 `session/title` 来改写标题 | 一个事实两个写入方；下一条回放的远端事件会覆盖它，重命名静默回退。 |

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。

- **R1** 重命名镜像会话会在远端会话上设置标题。
- **R2** 本地投影最终持有同一个标题，且来自回放的事件。
- **R3** 远端拒绝时本地标题不变，并上报原因。
- **R4** 本地会话不受影响（走原方法）。
- **R5** 不支持该能力的 agent 保持今天的仅本地重命名。
- **R6** 草稿镜像（尚无远端会话）可重命名：先在本地生效，待物化后的会话继承它——见 §6.4。
- **R7** 标题校验（`session/title-invalid`）在任何远端调用之前完成。

## 6. 设计

### 6.1 接缝

`rename` 是 `sessionController` 上的 Remote，由网关按调用解析，所以插桩点就是该实例：

```ts
REQUIRED_SESSION_CONTROLLER_METHODS = ['rename'] as const   // 与队列 spec 共用该列表
```

（若 `docs/specs/2026-11-27-mirror-queue-mutation.md` 先落地，本 spec 扩展那个列表，
而不是另起一个平行的。）

### 6.2 顺序与失败（R1、R2、R3）

```ts
sessionController.rename = async (request) => {
  const runtime = mirrors.runtimeForLocalSession(request.sessionId)
  if (runtime === undefined) return original.rename(request)
  // R7：先用本地服务校验，非法标题永不进入隧道。
  // `sessionTitle.rename` 会抛 SessionTitleInvalidError。
  validated = original.validateTitle(request.title)     // 见 §6.3
  await hosts.renameSession(runtime.record.hostId, runtime.record.remoteSessionId, validated)
  // 远端此时写入 `session/title`，镜像会回放它。返回被接受的标题，
  // 让客户端无需等待轮询即可更新。
  return { title: validated, seq: runtime.session.seq }
}
```

返回的 `seq` 取本地日志当前头部，因为事件尚未落地；客户端只把它用于乐观标签。
回放的事件到达后会取代该值，这与本地重命名已有的形状相同。

### 6.3 调用前校验（R7）

原生方法通过 `sessionTitle.rename` 校验，对空标题或超长标题抛 `SessionTitleInvalidError`。
只为了校验而调用它，会**顺带写入**本地事件，正是本设计要避免的。

两种可接受的实现，按优先级：

1. 如果 `sessionTitle` 暴露了仅校验的路径，就用它（`dsh-session-title` 有 `normalize.ts`，
   规范化后比对很可能已经可用）。
2. 否则，把本仓库已记录的两条约束（`maxTitleBytes`、非空白）复制进一个小辅助函数，
   配一条 `TODO` 点明将来取代它的服务方法，以及一条钉住 `session/title-invalid` 错误码的测试。

复制一条规则是坏味道，§11 把它记为已接受的风险，并指明缓解措施。

### 6.4 草稿镜像（R6）

空白镜像在首次提示词之前没有远端会话。重命名它会写一条本地 `session/title`，
这正是今天的现行为，而且是对的：远端会话还不存在，无从重命名。当
`#materializeBlankOnce` 创建它时，§6.4 增加一步：在创建之后、转发首条提示词之前，
把草稿的标题应用到远端。这样用户输入的名字得以保留。

### 6.5 能力与降级（R5）

新增 `AgentCapability` `'session.rename'`，与 `session.archive`/`session.unarchive` 并列上报。
旧 agent → 仅本地重命名（今天的现行为），并记一条 debug。注意这里**不是**拒绝：
重命名留在本地是比让重命名直接失败更小的伤害，而归档那条更严格的规则之所以存在，
是因为单向归档会把会话困死。

### 6.6 不发明事件

远端自己写 `session/title`。镜像像回放其他事件一样回放它（它不在 `isMirrorNoise` 里），
于是本地投影无需第二个写入方即可收敛。本地追加只发生在 R5 的降级路径上。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| 空标题或全空白 | 在任何网络调用之前 `session/title-invalid`（R7）。 |
| 标题超过字节上限 | 同上。 |
| 远端拒绝（它自己的校验或存储失败） | 错误向外传播；本地标题不变（R3）。 |
| 主机断开 | 转发 reject；重命名上报失败。刻意不做静默的本地回落，因为那正是被修的 bug。 |
| 草稿镜像 | 本地写入；在物化时应用到远端（§6.4）。 |
| 轮次运行中重命名 | 允许；远端在轮次中途写入该事件，镜像按序回放。 |
| 连续两次重命名 | 两次都转发；远端后写者胜，回放顺序保留它。 |
| 远端 agent 早于本次改动 | 仅本地，并记一条 debug（R5）。 |

## 8. 质量属性

- **延迟。** 侧边栏标签变化前有一次往返。可以接受：客户端用返回值显示乐观标签，
  所以感知延迟是一次调用，而不是一个轮询。
- **持久性。** 标题现在存放在会话所在之处，所以镜像重建能恢复它。
- **影响面。** 一个被插桩的方法、一条协议路由、一个能力名。

## 9. 依赖与假设

- 假设远端 `sessionTitle.rename` 写 `session/title`（确实如此；它是该事件的唯一写入方）。
- 假设镜像继续回放 `session/title`（今天如此；将来若有人把它加进 `isMirrorNoise` 会破坏 R2，
  所以 §12 加了一条测试）。
- 假设客户端容忍返回的 `seq` 早于事件（乐观标签路径）。
- 不依赖本 spec 集合中的其他文档。

## 10. 验证

**单元与包级测试**

- `packages/protocol/test/sessions.test.ts` —— 重命名路由、能力、守卫（空白标题在线上被拒）。
- `packages/remote-agent/test/agent.test.ts` —— 转发抵达 `sessionTitle.rename` 且带正确会话 id；
  校验错误映射为 `session/title-invalid`。
- `packages/local-plugin/test/remote-rename.test.ts`（新增）：
  - 镜像转发，且**不**追加本地 `session/title`（断言本地日志）；
  - 回放的远端 `session/title` 更新投影；
  - 远端拒绝时本地标题不变并暴露错误；
  - 空白标题 → `session/title-invalid`，无网络调用；
  - 非镜像 → 调用原方法；
  - 缺能力 → 本地写入、debug、无请求；
  - 草稿镜像 → 本地写入，物化后远端持有该标题。
- `packages/local-plugin/test/mirror-lifecycle.test.ts` —— `session/title` 仍被回放
  （防止将来有人加进 `isMirrorNoise`）。

**验收**

1. *给定*一个镜像会话；*当*用户重命名它；*则*远端 Web UI 显示新标题。
2. *给定*同上；*当*工作区被移除再重新添加；*则*标题仍是重命名后的那个。
3. *给定*一个拒绝该标题的远端；*则*侧边栏保留旧名字并上报错误。
4. *给定*一个本地会话；*则*重命名行为与之前完全一致。
5. *给定*一个草稿镜像；*当*首条提示词发出；*则*创建出的远端会话携带用户发送前输入的标题。

## 11. 已接受的取舍

- **远端优先的顺序。** §4 记录了它为何与归档的本地优先不同。
- **标题校验可能被复制。** 优先实现是询问 `sessionTitle`；若没有仅校验路径，则接受复制一条规则，
  配 `TODO` 指明替代方案，并用测试钉住错误码。备选方案——为了校验而写本地——会重新引入该 bug。
- **旧 agent 上回落本地，而不是拒绝。** §6.5。
- **§7 的「过长标题 → `session/title-invalid`」与本仓库锁定的 DSH 不符。** `normalizeSessionTitle`
  在 `maxTitleBytes` 处**截断**，只有当截断后不剩任何可见字符时才拒绝。实现对齐 DSH：空标题在本地
  就拦下（不必占用隧道），过长标题原样送达、在存储处被截断。因此 §6.3 的「复制两条约束」只落实了
  一条——`maxTitleBytes` **没有**复制，它是插件无法从服务读到的配置，本地复制一份只会得到一个与所在
  主机不一致的猜测。
- **§6.2 的 `original.validateTitle(...)` 并不存在。** 校验落到一个本地辅助函数
  （`assertForwardableTitle`），它构造的是结构化的远端失败（`isDSHRemoteError` + `code`，与
  `questionError` 同一写法），所以浏览器两种情况下看到的是同一个 code 和同一句话。
- **agent 转发给 `sessionController.rename`，而不是直接调 `ctx.sessionTitle.rename`。**
  后者要求那个确切的、活的 `Session`；镜像在远端可能是冷会话，直接调用会对一个确实存在的会话
  报「not live in this store」。控制器会先恢复再调 `sessionTitle.rename`，测试断言的正是
  「文本到达了 `sessionTitle.rename` 且针对正确的会话」。
- **响应体是远端接受后的标题**（`{ title }`），而不是 `{accepted:true}` 或本地校验后的字符串，
  这样标签上的乐观文本确实是远端存下的那一份。远端的 `seq` 不携带（两份日志序号不同），
  按 §6.2 报的是本地日志的头。
- **草稿标题的交接是尽力而为**（失败记警告后继续）。规格没有规定失败策略；为了一个被拒绝的
  重命名而丢掉创建会话的第一条提示词，代价更大。
- **文档位置**：规格写的是 §5.7，但那份文档的归档顺序讨论在 §5.8（且已经有两个 `### 5.8` 标题），
  所以新小节加为 **§5.9**，而不去重排无关章节。
- **`scripts/check/protocol-surface.mjs` 增加了一个名字。** 检查器不剥离内联 `type` 修饰符，
  `RenameSessionResult` 真正出现在 `RemoteAgentClient.renameSession` 的签名里、也被
  `RemoteHostsService` 依赖，若不登记会被误计为 internal。那张分类表存在的目的正是这类判断。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | 协议：`session.rename` 能力、`POST /sessions/:id/rename`、守卫 | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | 远端 agent：路由 → `ctx.sessionTitle.rename`，错误映射 | `packages/remote-agent/test/agent.test.ts` |
| 3 | 本地插件：插桩 `rename`，扩展 `REQUIRED_SESSION_CONTROLLER_METHODS` | `remote-rename.test.ts` |
| 4 | 镜像：`#materializeBlankOnce` 中应用草稿标题 | `remote-rename.test.ts` 的草稿用例 |
| 5 | 文档：`docs/protocol.md` 路由/能力表、`docs/remote-workspace-mechanism.md` §5.7、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 → 2 → 3 按依赖排序；4 依赖 3。每片以 `pnpm typecheck` 收尾；整体完成需要
`pnpm install && pnpm typecheck && pnpm test && pnpm build`。
