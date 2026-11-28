# `@` 文件引用菜单必须列出远端工程

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

依赖：`docs/specs/2026-11-27-remote-directory-type.md`（该文档的切片 4 提供本设计所依赖的
`workingDirectory` 适配器）。

## 1. 背景与目标

在镜像会话里输入 `@`，列出的是**本地**机器的文件，永远不是远端工程。有两个互相独立的原因，
必须都处理。

**原因 1 —— provider 在本地取得的目录里检索。** 组合进来的 provider 是 `dsh-file-reference-local`：

```ts
// dsh-file-reference-local/src/index.ts
override async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
  const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
  let cached = this.searches.get(agent)
  if (cached?.cwd !== cwd) {
    cached?.search.dispose()
    cached = { cwd, search: new WorkspaceFileSearch(cwd, this.config) }
    this.searches.set(agent, cached)
  }
  return cached.search.list(query, signal)
}
```

`WorkspaceFileSearch` 直接用 `node:fs` 遍历目录树。本仓库没有任何地方拦截
`fileReferences`——在 `packages/local-plugin/src` 上 grep `fileReferences` 一无所获——
所以即便 cwd 已经正确（spec A），检索仍然会去读**本地**那块磁盘，
而那个路径只在远端主机上才有意义。

**原因 2 —— 菜单是由浏览器所连的那台主机作答的。** 客户端经本地主机拥有的 Remote 命名空间访问 provider：

```ts
// dsh-api-session-controller/src/file-references.ts
export class SessionFileReferences extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' }) }
  @Remote
  list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}
```

`agent` 由线上 `sessionId` 经注册表查找解析（`@deepseek-ai/dsh-agent` 的
`typert.lookups.register('agent', …)`），拿到的是**镜像门面** `RemoteMirrorAgent`。
该对象的 `session.header.cwd` 是空的本地锚点。

目标：镜像会话里的 `@` 列出远端工程的文件，`file`/`directory` 分类与原生检索一致，
并且选中候选项后产出的提示词远端能用。

成功信号：

1. 在镜像会话输入 `@`，列出远端 cwd 下的目录树。
2. 选中候选项插入的引用，在提示词路径上能解析到远端文件。
3. 目录候选项保持菜单展开（客户端的 `kind: 'directory'` 规则）。
4. 非镜像会话不受影响。

## 2. 范围与非目标

范围内：主机侧的 `fileReferences` 适配器、一条远端检索路由（或复用既有路由）、候选项映射，
以及主机被禁用时的拒绝。

范围外：

- 流式/实时刷新的菜单。客户端按查询轮询，适配器按查询作答。
- 模糊匹配语义。远端用它自己的目录树跑同一个 `dsh-file-reference-local` provider，
  所以排序、忽略规则、结果上限都保持远端的——这里不重新实现任何一项。
- 改动 `dsh-client-ui-reference`。它的请求/响应形状不变。
- `sessionReferenceResolver.candidates`（另一个命名空间，由同一个客户端插件另行列出）。见 §7。

## 3. 用户与场景

1. **写提示词时引用一个远端文件。** 用户在镜像会话输入 `@src/`，期望看到远端工程的 `src/` 子项。
2. **引用远端目录来限定 agent 的工作范围。** 用户选一个目录候选项，期望 agent 在远端路径内工作。

## 4. 决策

**采用：把引用查询转发给拥有该会话的主机，由那台主机跑它自己的 provider。**

适配器替换活的 `sessionFileReferences` 实例上的 `list`——与 `src/remote/` 里其他适配器相同的
自有属性插桩方式，理由也一样（已有文档记录）：Typert 网关按调用解析 Remote 方法，
所以主机侧替换才是浏览器观察到的。

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 用新的 `ctx.fs` 适配器让本地 provider 去检索远端路径 | `WorkspaceFileSearch` 直接用 `node:fs`，不走 `ctx.fs`，没有可拦截的点。要改它就得 fork 一个 profile 未必挂载的包。 |
| B. 同步时把远端目录树拷到本地 | 与仓库体量成正比、立刻过期，并且给远端拥有的字节造出第二个权威——正是 `docs/remote-workspace-mechanism.md` §4 关于锚点所持的论断。 |
| C. 从远端日志里的文件引用作答 | 日志列出的是**曾经**被碰过的东西，不是存在的东西。菜单存在的意义恰恰是命名那些从未被提到过的路径。 |
| D. 对镜像会话禁用 `@` | 把一个可用的入口从用户最期待对等的地方拿掉，而远端完全能回答它。 |

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。

- **R1** 镜像会话里的 `@` 返回来自远端 cwd 的候选项。
- **R2** 每个候选项保持远端 provider 的 `kind`（`file`/`directory`）与路径拼写。
- **R3** 查询文本原样透传；不增加任何本地排序、过滤或截断。
- **R4** 结果上限由远端自己的 `maxResults` 决定，不引入新的本地上限。
- **R5** 非镜像会话委托原实现，字节级不变。
- **R6** 不支持该能力的 agent 复现今天的现行为（本地菜单），且不报错。
- **R7** 远端调用失败的主机会记录失败并委托原实现，而不是显示一个空菜单、让人以为工程里没有文件。

## 6. 设计

### 6.1 数据流

```
浏览器 `@` 源  (dsh-client-ui-reference inputTriggers.registerSource)
  └─ ctx.remote.fileReferences.list(sessionId, query)      线上参数名 `agent`
     └─ 主机: Reflect.get(ctx.get('sessionFileReferences'), 'list') → 适配器
        ├─ 非镜像 / 无能力 → 原实现
        └─ 镜像 + 能力 → 新 agent 路由 `POST /file-references`
             body: { sessionId, query }
             └─ 远端: ctx.fileReferences.list(remoteAgent, query, signal)
                └─ dsh-file-reference-local → WorkspaceFileSearch(远端 cwd)
```

远端**不**重新实现检索。它用自己活的 Agent 调用组合进来的 provider，这与远端 Web UI 的做法一致——
于是排序、`.gitignore` 处理、条目预算与超时上限都保持远端的（§9 记录该假设）。

### 6.2 为什么新增路由而不用 `files/search`

`searchFiles`（`@dsh-waypoint/protocol`）回答的是**文件面板**的检索：有界遍历，带
`respectGitignore`/`includeHidden` 开关，以工作区根为锚点。引用 provider 有自己的语义——
前缀查询、自己的候选项上限、逐条的 `kind` 分类——而这些应该由**远端** provider 决定。
把前者映射到后者意味着在本仓库里翻译查询语义，正是 §4 决策要规避的维护面。

因此这条路由很薄：携带一个查询，返回 provider 的候选项。

### 6.3 能力与降级（R6、R7）

新增 `AgentCapability` `'file.references'`，与其他文件类能力一起上报。
旧 agent 没有它 → 适配器委托（R6），也就是今天的现行为。

能力存在但调用抛错，**不**算委托。§7 解释了为什么空菜单会是错误答案。

### 6.4 候选项映射

```ts
// dsh-file-reference/src/types.ts
export interface FileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}
```

该形状本就与主机无关且 JSON 安全，线上可以原样携带；适配器不做映射。路径是远端拼写，
这对提示词路径来说正是对的：镜像已经通过 `#promptContent` 的 `file` 部分转发远端绝对路径，
而文本里的 `@<远端路径>` 在远端主机上依然有效——与 `#resolveTextReferences` 存在的
那个本地路径场景不同。

**值得明确写出来，是因为二者在输入框里看起来一模一样。** 用户从远端菜单选出的路径，
**绝不能**被 `#resolveTextReferences` 改写（后者解析的是 `@` 前缀的**本地**绝对路径，读的是本地磁盘）。
§7 钉住了区分二者的规则。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| 远端 provider 抛错 | 记警告并**委托原实现**。理由见下文。 |
| agent 没有 `file.references` | 委托（R6）。 |
| `mirrorRemoteCatalog` 之类的开关 | 不新增：这是一个文档导航入口，不是那种「缺席就会静默误导」的目录。记录于 §11。 |
| 远端 cwd 已不存在 | 远端 provider 返回空列表或抛错；两者都是远端自己的行为，而「对等」就是这个意思。 |
| 远端候选项路径进入 `#resolveTextReferences` | 不得被当作本地文件请求。见下文规则。 |
| 主机不确定 | 拒绝（委托），绝不猜。 |

**为什么失败要委托而不是显示空菜单。** §4 被否决方案 C 从反方向讲了同一件事：菜单是对「存在什么」的断言。
空列表意味着「这个工程没有文件」，这是关于远端工作区的错误陈述，而用户很可能据此行动。
委托意味着用户看到本地列表——错的，但错得可见：那些路径随后在会话记录里并不存在。
这与 `remote/catalog.ts` 对同类失败已记录的理由一致，而警告是让问题可诊断的关键。

**两种 `@` 拼写。** `#resolveTextReferences` 改写的是 `@` 前缀的**本地绝对**路径
（`C:\…`、`\\server\…`、`/…`）。远端候选项也是绝对路径，而且是 *POSIX* 的，
所以在 Linux / macOS 客户端上，二者仅凭形状**完全无法区分**——`/…` 既是远端路径，也是本地路径。

> **归属先于拼写。** 落在本会话**远端工作区之内**的引用属于远端：菜单就是在远端工作区里搜的，
> 远端能解析它，因此原样作为文本转发，本地**不**读取。只有工作区不认领的路径才交给「本机能否持有
> 这种拼写」的判定。

具体做法：`#resolveTextReferences` 先用 `remoteFileContext(anchor)` 取到本会话的远端根，
把落在其下的候选**先**过滤掉（不读本地、不查能力）；剩下的才走原有逻辑——`C:\`、`\\` 恒为本地，
`/…` 仅当 `process.platform !== 'win32'` 时视为本地拼写。

这一条是 review 之后改的，初稿只写了后一半（按平台判定）。按拼写判定在原则上是错的：Windows 上
`/…` 恰好只能是远端，于是初稿在 Windows 上「碰巧」正确，而在 POSIX 客户端上把**功能本身**弄坏了
——菜单终于列出了远端文件，选中发送时却以 `local path is not readable` 失败（远端路径在这台机器上
当然不存在）。§11 记录保留下来的代价。

## 8. 质量属性

- **延迟。** 每次查询一次往返，加上远端自己的遍历。客户端已经在防抖和取消；
  适配器把 `signal` 透传下去，被取代的查询会在远端取消。
- **隐私。** **成功**的引用查询永远不会列出本地文件系统，所以远端的回答不会把本地路径泄漏进远端
  会话记录（这正是方案 A 会造成的坑）。一次**失败**的远端查询回落到本地列表（§7），那是刻意的：
  错的列表要看得见，而不是伪装成「这个工程没有文件」的空列表。
- **影响面。** 一条新路由、一个适配器方法、一个能力名。

## 9. 依赖与假设

- 假设远端组合挂载了 `dsh-file-reference` 与某个 provider。`dsh-web-app` 的 bundle 挂载
  `dsh-file-reference-local`；没有 provider 的主机会由该服务返回 `undefined`/空，
  而能力门禁检测不到这种情况——见 §11。
- 假设 `FileReferenceCandidate` 保持 `{ path, kind }`。
- 假设远端 Agent 活跃。冷会话没有 Agent 可传，所以 §6.1 的路由接受会话 id，由远端自行解析
  （`ctx.agents.get`）——冷远端会像远端 UI 一样作答，也就是「没有候选项」。
- 对 spec A 的依赖仅限于**本地**委托路径的 cwd 正确性；远端路径不需要它提供任何东西。

## 10. 验证

**单元与包级测试**

- `packages/protocol/test/file-references.test.ts` —— 路由匹配、请求/响应守卫；
  含 `/`、`..`、盘符的查询原样透传。
- `packages/remote-agent/test/file-references.test.ts` —— 用远端 Agent 转发到组合 provider；
  `directory` 候选项的 `kind` 往返保持；取消信号能取消遍历。
- `packages/local-plugin/test/remote-file-references.test.ts` —— 镜像转发、非镜像委托、
  缺能力委托、远端抛错时记日志并委托（断言调用的是**原实现**，而不是返回空数组）、主机不确定时拒绝。
- `packages/local-plugin/test/mirror-prompt-*` —— 远端菜单产出的 POSIX 引用在 Windows 客户端上
  不被 `#resolveTextReferences` 改写；`C:\` 引用仍会被改写。
- `packages/testkit/src/fake-host.ts` —— 实现新路由。

**验收**

1. *给定*一台 Linux 主机上的镜像会话，远端 cwd 为 `/data/home/u/proj`；*当*用户输入 `@src/`；
   *则*候选项是远端 `src/` 的子项。
2. *给定*同一会话；*当*用户选中一个目录候选项；*则*菜单继续提示其子项。
3. *给定*同一会话；*当*用户选中 `proj/README.md` 并发送；*则*远端收到该引用且能打开文件。
4. *给定*一个非镜像会话；*则*菜单不变，含排序。
5. *给定*一个没有 `file.references` 的远端 agent；*则*出现本地列表，日志无错误。
6. *给定*一次远端 provider 失败；*则*一条警告点名主机，并出现本地列表。

## 11. 已接受的取舍

- **不设开关。** 本仓库每个「目录状」特性都有开关，因为陈旧的目录会静默误导。
  但一个回落到本地列表的文件菜单，「本地」是显而易见的（这些路径并不在远端工程里），
  为此再加第四个设置项并不划算。
- **失败即委托。** 记录于 §7。
- **归属规则带来的两处代价，都是刻意的。** 其一：远端 `cd` 到了所有镜像工作区之外时，那个路径不被
  任何工作区认领，在 POSIX 客户端上仍会被当作本地路径处理（读不到就报错）——这与文件面板的
  Known limits 同一条边界。其二：本机恰好存在一条**落在远端工作区内**的本地文件路径时，它被当作远端
  路径转发（用户此刻看的是远端菜单）。两处都比「按拼写猜」可预测，也都写在机制文档的 Known limits 里。
- **主机没有引用 provider 与工程为空无法区分**，因为能力是编译期的、不是运行期的。
  要缩小这个差距需要在每次菜单查询时多一次往返探测，不值得。
- **草稿态镜像（远端会话还不存在）仍然列出本地文件。** §6.1 的路由以远端会话 id 寻址，而草稿没有；
  打一个菜单不应该顺手把远端会话创建出来（`remote/catalog.ts` 对 `/` 菜单已记录同一条规则）。
  这里**不能**照搬 `/` 菜单那套「用 `agentPreset` + `cwd` 问远端、但不创建会话」的做法：命令目录只用
  Agent 作为 scope key（`ScopedLayers.merge(agent, …)`），而 `fileReferences.list` 真正解引用
  `agent.session`（provider 会调 `workingDirectory.ensure(agent)`），草稿没有 Session，也没有一个
  可以冒充它的对象。因此 R1 只对**已落地**的镜像成立，首次提示词之后 `@` 就会转向远端。
- **响应体是 `{ candidates: [...] }`，不是裸数组。** 候选项本身按 §6.4 原样携带、不做映射；
  外层的对象只是为了和本仓库其他列表路由（`{ workspaces }`、`{ sessions }`、`{ commands }`）一致。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | 协议：`file.references` 能力、`POST /file-references` 路由、守卫、客户端方法 | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | 远端 agent：路由接入 `ctx.fileReferences.list` | `packages/remote-agent/test/file-references.test.ts` |
| 3 | 本地插件：`remote/file-references.ts` 适配器、`REQUIRED_FILE_REFERENCE_METHODS`、`ctx.inject` 块 | `remote-file-references.test.ts` |
| 4 | 镜像：`#resolveTextReferences` 的平台门禁 | `mirror-prompt-*` 补充用例 |
| 5 | Testkit + 文档：`docs/protocol.md` 路由表、`docs/remote-workspace-mechanism.md` §6.1、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 → 2 → 3 按依赖排序。切片 4 与 1–3 无关；若 §7 的坑已经在咬人，它可以先落地。
每片以 `pnpm typecheck` 收尾；整体完成需要
`pnpm install && pnpm typecheck && pnpm test && pnpm build`。
