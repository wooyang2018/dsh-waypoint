# 镜像与流评审

范围：`local-plugin/src/mirror/{service,recovery,inflight,test-visibility}.ts`、`remote-agent/src/{stream,projection,queue,service}.ts`、`local-plugin/src/remote/{files,terminal,terminal-controller}.ts`

分支：`review/mirror`（本轮零改动，全部为报告）　严重度分布：Major 7 / Minor 7 / Note 5

> 所有证据来自注入式探针：用真实 Cordis 上下文 + `workspace_removal_fixture.ts` 在内存里构造镜像，人为投毒快照/事件后观察 `lastSeq`、本地 transcript 与 warn 次数。

---

<a id="mir-01"></a>
## MIR-01　Major　`cancel()` 不清理 `pendingUsers`，静默吞消息

**位置**　`mirror/service.ts:1040`、`:1183-1195`

**现象**　`pendingUsers` 只在「远端 user/message 到达」或「prompt 抛错」时出队；`cancel()` 完全不碰它。被取消/被远端丢弃的 prompt 会留下永久残项，而 `:2724-2729` 的 `shift()` 按 FIFO 配对、不看内容。

**证据**　`followup(m1)` → `cancel()` → 远端只记录另一客户端的 `FROM-OTHER-CLIENT`，本地 transcript 输出 `["CANCELLED-BUT-ACCEPTED"]`；再让远端记录 `THIRD`，本地仍是 `["FIRST","SECOND"]`。

**影响**　静默吞掉远端真实用户消息；`remoteToLocalSeq` 指向错误本地节点，assistant frame 的 `startedAfterSeq`/`outcome.seq` 落到错位目标；每次取消泄一条残项。

**建议**　`cancel()` 清空 `runtime.pendingUsers` 并回滚本地 seq 记录；配对规则从 FIFO 改为按 `message.id`/内容匹配，匹配不上则走 append。

**状态**　未修

---

<a id="mir-02"></a>
## MIR-02　Major　单个 gap 让镜像永久重试，活锁

**位置**　`mirror/service.ts:2268-2275`、`:2215-2255`

**现象**　`#replaySnapshot` 遇 `event.seq !== lastSeq` 直接 `throw`；`#poll` 捕获后仍然 `#schedule(runtime)`，于是每个 poll 间隔重放同一份快照、报同一个 gap，永不推进。

**证据**　把快照污染为 `[0,2,3]`（缺 1）：2.4s 内 `snapshotsIn3s: 10`、`persistedLastSeq: 1`、重复告警 `remote event gap at 2, mirror 1`。

**影响**　该 Session 永久停摆且每 500ms 打一条 warn；后面的 `2,3` 与之后所有事件永不落地。不是死锁，是无限重试活锁。

**建议**　`#replaySnapshot` 改为返回 `'gap'` 而非抛出；`#poll` 在 gap 时优先拉更大窗口（`limit` 翻倍至 `maxSnapshotEvents`），仍失败则标 `stopped` 并只报一次，交给 `#ensureMirrorOnce` 重建。

**状态**　未修

---

<a id="mir-03"></a>
## MIR-03　Major　单个拒收事件让镜像永久卡住

**位置**　`mirror/service.ts:2351-2353`、`:2270-2274`

**现象**　`#appendEvent` 抛错后 `lastSeq` 不前进，其后的**健康事件永不生效**。

**证据**　让 `turn/end` 抛错（模拟本地 DSH 拒收）：远端日志 `[turn/start, user/message, turn/end, user/message(BEHIND)]` → `poisonAttempts: 4`、`persistedLastSeq: 2`、`appliedTexts: ["A"]`、`status: "idle"`。seq3 的消息既没应用也没报错。

**影响**　一次拒收 = 该会话后续全部历史丢失，且 UI 显示 idle 掩盖故障。

**建议**　单事件失败 → 记录 `skippedRemoteSeqs` 并**继续推进 lastSeq**；只对真正无法映射的类型做降级 append。

**状态**　未修

---

## MIR-04　Major　替换语义被无条件改写成 append

**位置**　`mirror/service.ts:2678-2698`、`:2755-2775`

**现象**　远端 `surfaceOp:{op:'replace'}` 被无条件改写为 `'append'`，并丢弃 `sourceEventSeqs`。这改变了 surface 折叠结果，不只是「避免越界」。

**证据**　用真实 `dsh-session` 折叠同一事件序列：远端 `surface: ["NEW"]` / 镜像 `surface: ["OLD","NEW"]`。

**影响**　被替换的旧消息永久留在本地 transcript（重复内容、重复工具卡片）；`sourceEventSeqs` 全丢时还会使 `dsh-session` 的 tool-result 修复逻辑把「替换式结算」当成新追加。

**建议**　仅当映射结果完整自洽时保留原 `replace`；否则退化为 append 并标注不可折叠，让上层投影忽略旧节点。

**状态**　未修

---

<a id="mir-05"></a>
## MIR-05　Major　「prompt 已接受但无 turn/start」无收尾

**位置**　`mirror/service.ts:2233-2240`、`:2283-2302`、`mirror/recovery.ts:19`

**现象**　`#closeAbandonedTurn` 因 `openTurnStartSeq` 非数字直接返回，`runtime.running` 保持 true，于是 `if (!runtime.running)` 的停机分支永远不执行。

**证据**　真实投影形状 `openTurnStartSeq: null`：2.4s 内 `status: "running"`、`snapshotsIn2400ms: 5`；再补一条 followup → `{"status":"running","promptsForwarded":1,"inboxNextTurn":1}`，新 prompt 被塞进 inbox 再也不会发出。

**影响**　冷会话追平后仍按 poll 频率空转；UI 永久「运行中」，用户新消息永久排队。

**建议**　`abandonedTurnEnd` 增加「未开 turn」的第二种结局；`#poll` 在 `!snapshot.live && lastSeq >= cursor && running` 时无条件 `#setRunning(false)` 并停机，同时把 inbox 里的 nextTurn 重新投递。

**状态**　未修

---

<a id="mir-06"></a>
## MIR-06　Major　`modelOptions` 读错事件字段，永远回落默认模型

**位置**　`mirror/service.ts:2777-2791`

**现象**　读 `event.data.config.{provider,model}`，但真实 `request/header` 事件把调用配置放在 `data.header.config`（`dsh-session` 的 `EpochHeader`）。

**证据**　用 `dsh-session` 校验通过的真实形状 `{header:{config:{provider:'remote-provider',model:'remote-model',reasoningEffort:'high'}}}` 灌入 → `agent.model.current()` 输出 `{"provider":"deepseek-official","model":"deepseek-flash"}`；而同形状的 `{config:...}` 反被 `adoptSessionEvent` 拒绝（`header must be an object`），进一步印证真实形状是 `header.config`。

**影响**　镜像首次 prompt 把**本地**默认模型当远端选择转发，远端拒绝后靠 `session/model-unavailable` 回退重发（多一次往返、日志留下错误选择）；远端真实模型永不出现在选择器。

**建议**　改读 `data.header.config`（兼容旧形状时两者都试），并优先于 `#defaultSelection()`。

**状态**　未修

---

## MIR-07　Major　reuse 分支按位置重建映射，整体错位

**位置**　`mirror/service.ts:2042-2054`

**现象**　用「本地事件 index ≡ 远端事件 index」重建 `remoteToLocalSeq`，只要本地日志多出事件（`model/selection`、`agent/inbox/spliced`、乐观 user 消息）就整体错位。

**证据**　本地 `[[0,"turn/start"],[1,"model/selection"]]`、远端 `[[0,turn/start],[1,assistant/message]]` → 重建后远端 seq1 指向 `model/selection`。把 `mirrors.json` 的 `lastSeq` 回退到 0 再重启，本地日志直接变成 6 条（`turn/start, user/message, turn/end` 各出现两次）。

**影响**　重新挂载（workspace 移除后重加、冷→活切换、host 重连）后 assistant 流与 `outcome.seq` 全错位，严重时整段历史重复。

**建议**　reuse 时只复用已有映射，缺失区间一律按「无映射」处理；`#replaySnapshot` 从 `lastSeq` 严格续写。

**状态**　未修

---

## MIR-08　Minor　审批重放会再派发一次

**位置**　`mirror/service.ts:1872-1883`

**现象**　去重只在**派发期间**生效（`#approvingApprovals` finally 即删），已答复的审批 id 没有记忆。

**证据**　同一 id 第一次 `entered=1`、`answers=[…]`；重放后 `entered=2`，answers 追加第二条相同 `{requestId, outcome}`。

**影响**　用户被重复弹同一个审批；第二次 `answerApproval` 远端必然 `approval ... is not pending`。

**建议**　增加有界 `answeredApprovals`（LRU），派发成功后写入，重放时跳过。

**状态**　未修

---

## MIR-09　Minor　`remoteFileContext` 硬编码 POSIX 分隔符

**位置**　`mirror/service.ts:750-760`、`:1300-1310`

**现象**　用 `root.startsWith(\`${anchor}/\`)` 做前缀判定；Windows anchor 是 `C:\...`，子目录永远不匹配。

**证据**　`remoteFileContext(anchor)` 命中；`remoteFileContext(join(anchor,'sub'))` → `undefined`。

**影响**　目前镜像 Session 的 `cwd` 恰为 anchor，属潜伏缺陷；一旦 cwd 是子目录，文件树与终端会静默回落到本地空 anchor。

**建议**　两处改为 `join` 后按路径段比较，与 `resolveRemoteFileTarget` 共用 `contains()`。

**状态**　未修

---

## MIR-10　Minor　`dispose` 期间在途 sync 仍写入

**位置**　`mirror/service.ts:1754-1790`、`:641-658`

**现象**　`#ensureWorkspace` 在 `mkdir`/`workspaceRegistry.create` 前不检查 `#disposed`；`sync()` 只挡重入不挡 dispose 期间的在途 sync。

**证据**　`start()` 卡在 snapshot → `dispose()` → 放行后本地 `rows` 仍有 `workspace-1`/`workspace-2`，`mirrors.json` 持久化了两个 workspace 记录。

**影响**　dispose 之后仍向本地注册表写入 workspace 行并落盘，用户会看到空镜像工作区；再次启动时被「收养」。

**建议**　`dispose()` 先 `await` 在途 sync；`#ensureWorkspace` 在 `create` 前加 `if (this.#disposed) return undefined`。

**状态**　未修

---

## MIR-11　Minor　`workspaceFiles.search` 未注入

**位置**　`local-plugin/src/remote/files.ts:46-88`

**现象**　注入了 5 个方法（read/readBytes/stat/list/changes），接口第 6 个 `search` 未注入。

**证据**　`WorkspaceFiles` 声明里有 `search(...)`；`remote/files.ts` 内 `search` 无命中；shipped bundler 只调用 `changes(` 与 `stat(`。

**影响**　今天无调用方，属潜伏缺口；一旦启用文件搜索，镜像 Session 会走本地 stock 实现读空 anchor。

**建议**　补 `service.search` 转发到 agent，或显式 `throw` 以免静默读本地。

**状态**　未修

---

## MIR-12　Minor　PTY 退出后记录常驻

**位置**　`remote-agent/src/terminal.ts:193`、`:310-337`

**现象**　`#finish` 只置 `closed`/`state`，不 `delete`（只有 `close()` 才删）；`history`（≤512KB）+ `stderr`（≤8KB）+ 子进程引用随每个退出终端常驻。

**证据**　`#finish` 代码；`#output` 裁剪只看 `MAX_BUFFERED_BYTES`。

**影响**　长时间使用的远端 agent 内存随终端数量线性增长（每个 ≤ ~520KB，无上限）。

**建议**　`#finish` 后保留短 TTL tombstone 再 `delete`，或把 history 归零只留 `state` 帧。

**状态**　未修

---

## MIR-13　Minor　空白会话单飞 key 不含 preset

**位置**　`mirror/service.ts:1223-1227`

**现象**　单飞 key 是 `${hostId}:${localWorkspaceId}`，不含 `agentPreset`；两个并发 `startBlankSession` 用不同 preset 会共享第一个调用者的结果。

**证据**　key 组装在 `singleFlight(...)` 参数里，preset 只进了 `#createBlankSession(requestedPreset)`。

**影响**　用户从两个入口选不同 preset 时，远端 Session 以错误 preset 创建；`created.agentPreset !== requestedPreset` 的校验只覆盖第一个调用者。

**建议**　key 追加 preset。

**状态**　未修

---

## MIR-14　Note　`lastSeq` 与本地事件持久化不同步

**位置**　`mirror/service.ts:2664-2675`、`:2268-2275`

**现象**　`lastSeq` 只在 `#save()` 落盘，本地 Session 事件由 DSH 自己持久化；强杀/断电时二者可不同步。

**证据**　正常镜像 3 条 → dispose → 手工把 `lastSeq` 改回 0 → restart，本地日志变 6 条（三事件 ×2）。

**影响**　非正常关停后用户看到重复历史段，且重复段进入本地 surface。

**建议**　重启加载时用 `localEventCount` 校正；首轮重放对已有 `remoteToLocalSeq` 条目跳过 append。

**状态**　未修

---

## MIR-15　Note　截断窗口静默丢弃中间历史

**位置**　`mirror/service.ts:2258-2267`

**现象**　`truncated` 且窗口首 seq 已越过 `lastSeq` 时，直接把 `lastSeq` 跳到窗口首，**静默丢弃**整段中间历史（只 warn）。

**证据**　窗口从 seq10 开始 → warn `remote log for %s skipped ahead to seq %s`，本地日志 `turn 1` 后直接 `turn 5`，无占位。

**影响**　transcript 出现无提示断层；引用被丢弃 seq 的 `sourceEventSeqs` 全部失效。

**建议**　追加显式「历史被截断」占位事件，并清理落在被丢弃区间的映射条目。

**状态**　未修

---

## MIR-16　Note　未处理「远端 seq 回退」

**位置**　`mirror/service.ts:2269`、`:2325`

**现象**　只处理 `==`（gap）与 `>`（duplicate）；远端重启后 seq 从低值开始时，全部 `event.seq < lastSeq` 被当作 duplicate 跳过，镜像永久停更且无任何日志。

**证据**　两处都是 `if (event.seq < lastSeq) continue`，无回退检测。

**影响**　远端异常重载后本地静默冻结，用户以为只是没新消息。

**建议**　检测 `snapshot.cursor < lastSeq`，命中即视为远端会话被重置 → 归档旧镜像并重建。

**状态**　未修

---

## MIR-17　Note　合成 `turn/end` 后真实 `turn/end` 仍重放

**位置**　`mirror/service.ts:2293`

**现象**　放弃 turn 时追加合成 `turn/end`，之后远端真实 `turn/end` 仍会重放，本地出现连续两个。

**证据**　恢复后本地 `["turn/start","user/message","agent/inbox/spliced","turn/end","turn/end","turn/start"]`。

**影响**　`turnBoundary` 投影在第二个上再次置空（无害），但 transcript/状态计数出现「同一 turn 结束两次」。

**建议**　记录已合成关闭的 turn 号，遇同号远端 `turn/end` 时跳过。

**状态**　未修

---

## MIR-18　Note　`awaitingStarted` 是死状态

**位置**　`mirror/service.ts:113`、`:2505`

**现象**　6 处赋值、0 处读取。

**证据**　`Select-String -Pattern 'awaitingStarted\s*(!==|===|\?|&&)'` → 无命中。

**影响**　无功能影响，但会误导维护者以为存在「已开始但未结束」判定。

**建议**　删除，或真正用于 `#closeAbandonedTurn`（与 MIR-05 一起修）。

**状态**　未修

---

## MIR-19　Note　`hiddenPaths: ['/']` 静默失效

**位置**　`mirror/test-visibility.ts:52-56`

**现象**　`const root = prefix.trim().replace(/\/+$/u,'') || '/'`，随后 `path.startsWith(\`${root}/\`)` → `'//'`，根路径不隐藏任何路径。

**证据**　代码原文。

**影响**　测试清单写根路径 `"/"` 时静默失效（写具体前缀则正常）。

**建议**　`root === '/'` 时单独返回 `true`。

**状态**　未修

---

## 已复核且未发现问题

1. **seq 单调性与 `EventCursor` 契约**：`stream.ts:91-105` 先订阅再读 `liveEnd`；重放段 `>` → `end('error')`、`<` → skip；drain 段与 `cursor.ts:42-53` 语义一致
2. **gap 必然终止该流**：两处 gap 都 `return`，不存在「流内续跟」；修复职责落在 `#poll` 快照重放（契约本身匹配，问题只在重放侧）
3. **`#followStream`/`#poll` 不并发写同一 runtime**：`runtime.stream !== undefined` 去重并在 `finally` 复位
4. **冷会话追平后停止跟随**：`snapshot.live === false && lastSeq >= cursor` → 停 poll 与两条流；再来 prompt 时 `#schedule` 重启路径完整
5. **冷→活恢复**：`#ensureMirrorOnce` 因 `!runtime.stopped || !remote.live` 为假而重建 runtime，探针拿到新事件
6. **`SURFACE_TYPES` 与 DSH 语义一致**：对比 63 个已知类型 `missing: []`、`extra: []`
7. **`toSeedEvent` 的 seq 重编号**：seed 用 `index` 作本地 seq，与 `remoteToLocalSeq.set(event.seq, index)` 自洽
8. **`#save()` 串行写**：失败被吸收不产生 unhandled rejection；临时文件 + rename 原子替换 + `mode 0600`
9. **`inflight.ts` 单飞语义**：`Promise.resolve().then(task)` 保证表先填充；`settle` 有身份守卫
10. **worktree 幂等性**：`#retireWorkspace`/`#restoreWorkspace` 互斥；`#deleteLocalWorkspace` 用 `#internalWorkspaceDeletes` 抑制自触发；`workspace_removal` 17 项全绿
11. **审批不丢**：未挂载/不可见都入队；两处调用 `#flushPendingApprovals`；按 `id` 去重
12. **可见性心跳与 TTL**：500ms 轮询 + 5s TTL 留 10× 余量
13. **远端缓冲区**：`AsyncQueue` 容量 2048，溢出 `fail()` 而非无界增长
14. **PTY attach 多订阅者无泄漏**：listener 在 `finally` 删除；`watchAgent` abort 后退出重连循环
15. **`remote-path.ts` 双命名空间**：`contains()` 用 `relative()` 判定，分隔符无关（与 MIR-09 形成对比）
16. **`projection.ts` 的 `developer/message` 清洗**：清洗后空 content 形状经 `adoptSessionEvent` 复核通过

## 越界但值得记录

1. `agent/service.ts:454-540` 冷路径无元数据时全量扫描（`COLD_SCAN_LIMIT=100_000`），镜像每 poll 触发一次
2. `agent/service.ts:415-445` 审批 10 分钟超时返回 `unavailable`，与本地 5s 可见性窗口叠加后可能错过
3. `agent/http.ts:272-313` SSE 无背压，`res.write` 返回值不检查
4. `agent/http.ts:598-623` `streamFileWatch` 2s 轮询，文件树多开时线性放大隧道流量
5. `local-plugin/src/service.ts:624-662` 跟随流不区分 `session/not-live`，错误分类信息被丢掉
