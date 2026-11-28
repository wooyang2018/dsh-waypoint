# 远端目录必须报告自己的类型，工作目录必须在远端解析

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

## 1. 背景与目标

两个缺陷叠加成一整类故障。任一单独存在都是错的，合在一起则打掉了好几个互不相关的界面。

**缺陷 1 —— `file.stat` 没有目录类型。** 线上形状是：

```ts
// packages/protocol/src/files.ts
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}
```

没有 `type` 字段，而 agent 的 `fileStat` 对任何非普通文件直接抛错：

```ts
// packages/remote-agent/src/files.ts
if (!value.isFile()) {
  throw new RemoteProtocolError({
    code: 'workspace-file/not-regular-file',
    message: `not a regular file: ${path}`,
    details: { path, kind: value.isDirectory() ? 'directory' : 'other' },
  })
}
```

注意这个不对称：`RemoteFileEntry` **是**带
`readonly type: 'file' | 'directory' | 'other'` 的（`listFile` 分类正确，`files.ts:167-168`），
所以列目录正常、stat 目录不正常。

本地 `fs` 适配器因此即使想说真话也做不到：

```ts
// packages/local-plugin/src/remote/fs.ts  (stat，lstat 完全相同)
return { version: FsVersion(result.version), type: 'file', ... }
```

而 `reading()` 只翻译了一种错误码：

```ts
// packages/local-plugin/src/remote/fs.ts
return code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND'
```

`workspace-file/not-regular-file` 被原样抛出。所以面对远端**目录**时，适配器要么说谎
（`type: 'file'`，前提是 agent 曾经返回过），要么抛出一个没有任何消费方处理过的协议错误。

**缺陷 2 —— `workingDirectory` 拿错了文件系统去校验。**
`dsh-working-directory` 通过 `working-directory/change` 提交生效目录，镜像会像回放其他事件一样回放它，
于是远端只要跑过任何触碰 cwd 的工具，镜像会话的投影就变成**远端绝对路径**
（首次使用时 `ensure()` 会补写该投影，`set()` 则在每次 `/cd` 时写）。

随后 `ensure()` 在本地校验这个值：

```ts
// dsh-working-directory/src/index.ts
const current = this.get(agent.session)
const target = await this.ctx.fs.resolve(current, { signal: control })
const info = await this.ctx.fs.stat(target, control)
if (info?.type === 'directory') { ... return current }
// 否则：恢复原始工程目录，或抛 WORKING_DIRECTORY_UNAVAILABLE
```

对镜像会话来说，`this.ctx.fs` 是**本地**文件系统服务。远端路径
`/data/home/user00/proj` 在 Windows 上根本不存在；即便能解析，描述的也是另一台机器。
再叠加缺陷 1，本地 `stat` 对远端路径压根无法回答「是目录」。

所有调用 `ensure()` 的地方都继承了这次失败：

| 调用方 | 被打掉的界面 |
|---|---|
| `dsh-file-reference-local/src/index.ts:122` | `@` 文件/目录提及菜单 |
| `dsh-api-session-controller/src/skill-catalog.ts:51` | *活跃*会话的 `/` 技能列表 |
| `dsh-tool-bash`、`-pwsh`、`-fs`、`-fs-search`、`-terminal`、`-office`、`-present`、`-skill`、`-working-directory` | 每个需要解析 cwd 的 agent 工具 |
| `dsh-agent-instructions`、`dsh-experimental-auto-review`、`dsh-experimental-worktree`、`dsh-subagent` | 上下文组装与子会话创建 |

在主机侧，`skill-catalog.ts` 把这些失败吞成 `RemoteError('gateway/internal', …)`，
所以可见症状是菜单空白或坏掉，而不是一条点名目录的错误。

目标：`file.stat`/`file.lstat` 对远端路径报告真实类型；镜像会话的工作目录在远端主机上解析，而不是在本地。

成功信号：

1. `workspaceFiles.stat`、打开于应用、文档预览、文件面板都能 stat 一个远端**目录**并得到
   `type: 'directory'`，而不是报错。
2. 远端日志记录过 `/data/home/user00/proj` 的镜像会话，能在不触碰本地磁盘的前提下解析该 cwd。
3. cwd 为远端路径的活跃镜像会话，`@` 菜单与 `/` 技能列表可用。
4. 非镜像会话不受影响。

## 2. 范围与非目标

范围内：`file.stat` 的线上形状与 agent 行为、`fs.stat`/`fs.lstat` 适配器、主机侧新增的
`workingDirectory` 适配器，以及保证本地会话不受影响的委托规则。

范围外：

- 改写 `working-directory/change` 或重新解释该投影。提交的值本身是对的，错的只是它的**校验**。
- 任意写操作的远端 `fs.resolve`。写操作维持现状，理由 `remote/fs.ts` 文件头已写明：
  镜像会话的文件工具跑在远端，把本地写路由过去会给同一份字节造出第二个权威。
- 目录上的 `file.watch`（现有 `changes` 适配器不动）。
- 提升 `PROTOCOL_VERSION`，见 §6.6。

## 3. 用户与场景

1. **浏览远端工作区。** 用户在镜像会话打开右侧文件面板并展开一个目录。今天 stat 该目录会失败；
   改动后目录树可以展开。
2. **提及远端文件。** 用户在镜像会话输入 `@`，期望看到远端工程的文件。今天的菜单反映的是一个
   本地并不存在的目录。
3. **让 agent 在远端工程里干活。** 用户要求 agent 读取远端工程里的文件。今天 cwd 校验不过，
   工具调用失败；改动后可以正常执行。

## 4. 决策

**采用：把类型放到线上，并让工作目录在拥有它的主机上校验。**

分三部分：

1. `RemoteFileStat` 增加 `readonly type: 'file' | 'directory' | 'other'`，agent 对目录返回该类型而不是抛错。
   `readText`/`readBytes` 仍然拒绝非普通文件，因为它们的调用方确实读不了目录。
2. `remote/fs.ts` 在 `stat` 与 `lstat` 两处都透传上报的类型。
3. 主机侧新增 `workingDirectory` 适配器，对镜像会话用远端 agent 回答 `ensure()`/`get()`/`set()`，其余委托原实现。

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 在 `remote/fs.ts` 里把 `workspace-file/not-regular-file` 翻译成 `FS_NOT_FOUND` | 让错误消失并不等于让答案正确。`ensure()` 随后会去「恢复原始工程目录」，把一个健康的远端 cwd 悄悄改写成本地默认目录并记一条恢复通知。 |
| B. 另外 `file.list` 父目录来推断类型 | 为了回答一个问题花两次往返，而且对工作区根目录本身无解（它没有父目录可列）。 |
| C. 让 `workingDirectory.ensure()` 对锚点特判 | 镜像的 cwd 是**远端**路径，不是锚点。锚点按设计就是空的，所以「锚点是不是目录」是错误的问题，还会因为错误的原因答「是」。 |
| D. 让 `fs.stat` 对镜像根下任何路径都合成 `type: 'directory'` | 没有证据的断言：文件路径会被报成目录。对已经不存在的路径同样无解。 |

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。功能需求如下。

- **R1** `file.stat` 对 agent 能 stat 的每条路径都报告 `type`：`file`、`directory` 或 `other`。
- **R2** 目录的 stat 仍然携带 `version`（看护器依赖它），并省略 `bytes`（本协议不为目录定义大小）。
- **R3** 远端目标上的 `fs.stat` 与 `fs.lstat` 返回 agent 给出的类型，而不是常量。
- **R4** `fs.readText`/`readBytes`/`readByteRange` 仍然拒绝目录，且抛出的 `FsError` 代码要落在
  消费方已处理的词汇内，而不是原始协议错误（见 §7）。
- **R5** 镜像会话调用 `workingDirectory.ensure(agent)` 返回远端 cwd，且**不做任何本地文件系统 I/O**。
- **R6** `workingDirectory.get(session)` 原样返回投影（无 I/O，语义不变）。
- **R7** 镜像会话调用 `workingDirectory.set(agent, path)` 以具名原因拒绝，因为该目录属于远端执行世界
  （见 §7 与 §11 的取舍说明）。
- **R8** 非镜像会话的三个方法委托原实现，行为与之前完全一致。
- **R9** 不上报 `type` 的旧 agent 退化为今天的现行为，且不报错。

## 6. 设计

### 6.1 线上形状与兼容性（R1、R2、R9）

```ts
// packages/protocol/src/files.ts
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
  /**
   * 路径是什么。可选，好让来自旧 agent 的 stat 仍然可读：
   * 缺省表示「未上报」，而不是「是文件」。
   */
  readonly type?: 'file' | 'directory' | 'other'
}
```

`type` 在线上做成可选是刻意的。设成必填会让所有旧 agent 的响应无法通过校验，把一个表面缺口升级成协议错误。
本地适配器把 `undefined` 当作**文件**处理，也就是今天的语义，于是旧 agent 精确复现现状（R9）。
这一点记录在 §11 的取舍里。

`PROTOCOL_VERSION` **保持 `1`** —— 新增可选字段不是破坏性变更，§6.6 解释了为什么这里不该用版本号做门禁。

### 6.2 Agent：回答目录而不是抛错（R1、R2）

`packages/remote-agent/src/files.ts` 的 `fileStat`：

```ts
async function fileStat(path: string): Promise<RemoteFileStat> {
  let value
  try {
    value = await stat(path, { bigint: true })
  } catch (error) { /* EACCES / not-found 的处理不变 */ }
  const type = value.isDirectory() ? 'directory' as const : value.isFile() ? 'file' as const : 'other' as const
  return {
    absolutePath: path,
    version: statVersion(value),
    // `bytes` 仅对文件有意义：本协议不为目录定义大小。
    ...type === 'file' ? { bytes: Number(value.size) } : {},
    type,
  }
}
```

`statFile` 保留名字，它另外两个调用方（`file-read`、`file-bytes`）从此拿到的是 stat 结果而不是异常，
所以它们自己的守卫必须接替这件事。今天的 `readText` 先调 `fileStat(path)` 并依赖它为目录抛错，
这必须改成显式检查：

```ts
// readText / readBytes
const info = await fileStat(path)
if (info.type !== 'file') {
  throw new RemoteProtocolError({
    code: 'workspace-file/not-regular-file',
    message: `not a regular file: ${path}`,
    details: { path, kind: info.type },
  })
}
```

**这里有个值得点名的坑。** 只把抛错从 `fileStat` 里搬走、却不在这两个读函数里补回来，
会让 `file-read` 去读一个目录：Linux 上 `createReadStream` 对目录报 `EISDIR`，
但这里的逐行读取器把不可读的流当作空流处理，于是读目录会报「0 行」——与空文件无法区分。
§10 为此专门列了用例。

### 6.3 本地 `fs` 适配器透传类型（R3、R4）

```ts
// remote/fs.ts, stat
const kind = result.type ?? 'file'
return { version: FsVersion(result.version), type: kind, ...result.bytes === undefined ? {} : { size: result.bytes } }
// lstat：形状完全相同
```

`FsInfo.type` 与 `FsPathInfo.type` 是 `'file' | 'directory' | 'other'`，正是线上现在携带的三个值，
不需要映射表。`size` 仍然只对文件有意义，因为 `FsInfo.size` 的文档写的是「普通文件的字节大小，前提是后端能上报」。

**R4 的错误翻译。** `fileStat` 不再为目录抛错之后，能到达调用方的原始协议错误只剩读操作产生的
`workspace-file/not-regular-file`。`reading()` 增加一个分支，让消费方按它们已经在处理的 `FsError` 词汇分支：

```ts
if (code === 'workspace-file/not-regular-file') {
  throw new FsError(`not a regular file on the remote host: ${remotePath}`, 'FS_NOT_REGULAR_FILE', { cause: error })
}
```

选 `FS_NOT_REGULAR_FILE` 而不是 `FS_NOT_FOUND` 或 `FS_IO_ERROR`：路径是存在的，只是不能当文件读；
报成「不存在」会把读者指向一条其实正确的路径——这与 agent 自己 `EACCES` 分支记录的理由相同。
`FS_IO_ERROR` 说的是「发生过一次 I/O 失败」，而这里并没有发生。为什么改掉了本节初稿的写法，见 §11。

另外，走这层翻译的不只是 `stat` 和 `readBytes`：`readText` 与 `readByteRange` 现在也经过它。它们原先
直接调用 agent，于是「远端文件不存在」到达调用方时是 `workspace-file/not-found`，而不是适配器承诺的
`FS_NOT_FOUND`。

### 6.4 `workingDirectory` 适配器（R5、R6、R7、R8）

按 `src/remote/` 里其他适配器的做法安装在活的 `workingDirectory` 实例上（自有属性赋值，
还原器来自 `remote/install.ts`），并在 `remote/patch-contract.ts` 里新增
`REQUIRED_WORKING_DIRECTORY_METHODS = ['ensure', 'get', 'set']`。

路由判定：先用 `mirrors.remoteFileContext(anchorOf(session))`；对 header cwd 已经是远端路径的会话，
再用 `mirrors.remoteContextForRemotePath(cwd, hostId)` —— 复用现有两处查找，而不是引入第三种
「这个会话属于哪台主机」的概念。锚点取自 `session.header.cwd`，对镜像来说按构造就是本地锚点
（`docs/remote-workspace-mechanism.md` §4）。

```ts
// 示意
workingDirectory.get = (session) => original.get(session)          // 纯投影读取，无 I/O
workingDirectory.ensure = (agent, signal) => {
  const target = mirroredTargetOf(agent.session)
  if (target === undefined) return original.ensure(agent, signal)
  return agentFor(hosts, target.hostId, 'file.stat')
    .fileStat(target.remotePath, signal)
    .then(info => {
      if (info.type === 'directory') return target.remotePath
      throw new WorkingDirectoryUnavailable(target.remotePath)   // 见 §7
    })
}
```

两处性质是关键：

- **镜像不做本地 I/O。** R5 的要求是 `ensure()` 不能触碰本地磁盘，而不仅仅是「要成功」。
- **不写投影。** 原生服务的 `ensure()` 在投影为 `null` 时会追加 `working-directory/change`，
  校验失败时还会提交一次「恢复」。适配器两种情况都不写：远端已经拥有那个事件，第二个写入方
  会让本地日志与远端不一致。

对投影仍为 `null` 的会话（镜像建立后还没跑过工具，因而只有 header 锚点可用），适配器需要**远端**路径。
这种情形解析为远端工作区根目录，而这正是远端 DSH 用该 `cwd` 建会话时会用的目录——
agent 的 `snapshotSession` 已经会回报该会话的 `cwd`，所以适配器向远端问一次，并按会话缓存结果，
直到投影变成非 `null`。

### 6.5 安装位置

`packages/local-plugin/src/index.ts`，与其他 `ctx.inject` 块并列：

```ts
ctx.inject(['workingDirectory'], child => {
  child.effect(
    () => installRemoteWorkingDirectory(child, mirrors, hosts),
    'dsh-waypoint: remote working directory',
  )
})
```

该服务在无头组合中是可选的，所以服务缺失时不能抛错——与现有 `ctx.inject(['fs'], …)` 依赖的守卫相同。

### 6.6 为什么不用能力（capability）做门禁

本仓库其他新路由都用 `AgentCapability` 名做门禁，这在「旧 agent 会**做错事**」时是正确答案。
这里不会：旧 agent 只是不上报 `type`，而 §6.1 的可选字段已经让它退化为今天的现行为。
加一个能力名反而意味着适配器拒绝路由到任何尚未重装的 agent，把一个能用的文件面板变成拒绝。
字段的缺席本身就是协商，R9 把它钉住。

### 6.7 契约检查

`remote/patch-contract.ts` 的 `REQUIRED_WORKING_DIRECTORY_METHODS` 沿用既有模式
（字面方法名、与活的实例比对、结果上报到设置页状态），这样 DSH 若重命名 `ensure`，
症状是「路由关闭」，而不是 cwd 悄悄变成本地的。状态里的字段是 `workingDirectoryRouting`，
与既有的 `fileRouting` 并列。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| 远端路径已不存在 | `file.stat` 答 `workspace-file/not-found`；`ensure()` 抛 `WORKING_DIRECTORY_UNAVAILABLE` 并点名路径，代码与原生错误一致，调用方已在处理。 |
| 远端路径是文件而非目录 | 同样是 `WORKING_DIRECTORY_UNAVAILABLE`，消息区分出「不是目录」。 |
| 主机不确定（两台上报同一路径） | 拒绝，绝不猜——复用 `resolveHostForRemotePath` 既有契约（多个归属方时返回 `undefined`）。适配器抛错而不是落到本地服务，与 `remote/fs.ts` 的 `remoteOwnerOf` 一致。 |
| agent 早于本次改动 | `type` 缺席 → 当作文件（R9）。不报错。 |
| 校验途中主机断开 | 适配器的调用 reject；`ensure()` 像遇到任何不可用目录一样上报。**绝不能**回落到 `original.ensure`，那样会拿本地磁盘校验远端路径，并提交一次会改写投影的「恢复」。 |
| 镜像上调用 `workingDirectory.set` | R7：以具名原因拒绝。`/cd` 归远端所有，本地提交会让两份日志分叉。 |
| 锚点已被移除的会话调用 `ensure()` | 委托原实现，由它自己的路径上报不可用。 |

## 8. 质量属性

- **延迟。** 镜像的每次 `ensure()` 一次 stat 往返，与原服务的一次本地 stat 相同。`get()` 没有额外开销
  （纯投影读取）。投影为 `null` 时的远端 cwd 按会话缓存，热路径只有一次调用。
- **重连后的正确性。** 失败路径从不写入；下一次 `ensure()` 重试。
- **影响面。** 四个落点（协议类型、一个 agent 函数、两个适配器方法）加一个主机侧新适配器。
  `remote/files.ts`、终端适配器、改动卡片路由均不受影响。

## 9. 依赖与假设

- 假设 `FsInfo.type` / `FsPathInfo.type` 保持 `'file' | 'directory' | 'other'` 联合
  （`@deepseek-ai/dsh-fs`）。联合一旦变宽，会经 `?? 'file'` 回落保持可用。
- 假设每个镜像都有 `session.header.cwd`；`#ensureUngroupedWorkspace` 保证了这一点。
- 假设远端组合挂载了 `fs`（`dsh-base` 里总是有）。
- 不新增配置项。

## 10. 验证

**单元与包级测试**

- `packages/remote-agent/test/files-terminal.test.ts` —— 目录的 `file.stat` 答 `type: 'directory'`，
  带 `version`、不带 `bytes`；普通文件答 `type: 'file'` 且**带** `bytes`；fifo/socket 答 `other`。
- 同一文件 —— 目录上的 `file-read` 与 `file-bytes` 仍然以 `workspace-file/not-regular-file` 失败，
  且**不是**「0 行的空文本」（§6.2 的坑）。
- `packages/local-plugin/test/remote-fs.test.ts` —— `stat`/`lstat` 透传 `directory`/`other`；
  不带 `type` 的 agent 响应产出 `file`；目录上的 `readText` 抛出带 `FS_NOT_REGULAR_FILE` 的 `FsError`。
- `packages/local-plugin/test/remote-working-directory.test.ts`（新增）—— 镜像会话经 agent 解析，
  且**不产生**任何本地 `fs` 调用（断言本地服务从未被进入）；非镜像委托；路径不存在抛
  `WORKING_DIRECTORY_UNAVAILABLE`；主机不确定时拒绝；镜像上的 `set` 拒绝；主机断开时不回落。
- `packages/testkit/src/fake-host.ts` —— stat 响应实现 `type`，并支持工作目录查询。

**验收**

1. *给定*一台 Linux 主机上的镜像会话与远端目录 `src/`；*当*用户在文件面板展开它；*则*列出子项且不出现错误。
2. *给定*同一会话；*当*远端日志已记录 `working-directory/change → /data/home/user00/proj`；
   *则* `@` 列出该远端目录下的文件，`/` 技能列表有内容。
3. *给定*一个从未跑过工具的镜像会话；*当* agent 读取一个文件；*则* cwd 解析为远端工作区根目录，
   而不是本地锚点。
4. *给定*一个本地（非镜像）会话；*则* `stat`、`ensure`、`get`、`set` 的返回值与改动前完全一致。
5. *给定*一个不上报 `type` 的 agent；*则*目录的 `stat` 复现今天的现行为（报错），且其他功能无回归。
6. *给定*一个已被删除的远端目录；*则* `ensure()` 抛 `WORKING_DIRECTORY_UNAVAILABLE` 并点名路径，
   且事后投影保持不变。

## 11. 已接受的取舍

- **`type` 在线上可选。** 记录于 §6.1；这是让 R9 零成本达成的原因。
- **`ensure()` 不写投影。** 原生服务首次使用时会追加 `working-directory/change`。镜像跳过它，
  以维持该事件只有一个写入方。代价是：远端日志里还没有该事件的镜像，`get()` 会一直答 `null`
  → 锚点，直到远端写出一个；`@` 与技能仍然可用，因为它们走 `ensure()`，而 `ensure()` 解析远端根目录。
- **镜像上的 `set()` 选择拒绝而非转发。** 转发需要一条 `session.cd` 路由，以及一个「先写哪份日志」的决定。
  以具名原因拒绝是诚实的，也正是 `/cd` 入口应当呈现的东西；后续改动再加路由。
- **「不是普通文件」用 `FS_NOT_REGULAR_FILE`。** 本文初稿写的是 `FS_IO_ERROR`，实现时改掉了：
  `@deepseek-ai/dsh-fs` 的 `FS_ERROR_CODES` 里本来就有这个码，翻译不需要发明词汇，也不丢信息。
  另外两个候选按 §6.3 的理由被否——路径明明存在，`FS_NOT_FOUND` 会把读者指向正确的路径去核对；
  而 `FS_IO_ERROR` 描述的是一次并未发生的瞬时失败。
- **`set()` 的拒绝码不是原生的那个。** 适配器抛的是 `RemoteWorkingDirectoryError`，而不是 import
  `WorkingDirectoryError`：`@deepseek-ai/dsh-working-directory` 在无头组合里是可选的，静态值 import
  会在缺包的地方让模块加载直接失败，并把文件与终端适配器一起拖下水。`ensure()` 保留原生的
  `WORKING_DIRECTORY_UNAVAILABLE`，已按该码分支的调用方行为不变；`set()` 用 `WORKING_DIRECTORY_REMOTE`，
  原生分支不会匹配，所以呈现给用户的是消息本身。
- **镜像不触发 `working-directory/access` 瀑布。** 那个事件用于把一次目录访问与**本地**资源操作
  （例如删除一个 checkout）协调起来。远端目录没有对应的本地资源，而它的事件监听方会按本机命名空间
  去读那条路径。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | 协议：`RemoteFileStat.type`（可选），校验接受它 | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | Agent：`fileStat` 上报类型；`readText`/`readBytes` 补上显式非文件守卫 | `packages/remote-agent/test/files-terminal.test.ts` |
| 3 | 本地 `fs`：透传类型；翻译 `not-regular-file` | `remote-fs.test.ts` |
| 4 | 本地插件：`remote/working-directory.ts`、基于 `fs.stat` 的 `ensure`、`set` 的拒绝、`REQUIRED_WORKING_DIRECTORY_METHODS`、`ctx.inject` 块 | `remote-working-directory.test.ts` |
| 5 | Testkit fake-host 支持以上两者 | 既有测试套件转绿 |
| 6 | 文档：`docs/protocol.md` 的 stat 说明、`docs/remote-workspace-mechanism.md` §6.1 与 Known limits、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 → 2 → 3 → 4 按依赖排序；切片 5 可与 2 一起落地。每片以 `pnpm typecheck` 收尾；
整体完成需要 `pnpm install && pnpm typecheck && pnpm test && pnpm build`。
