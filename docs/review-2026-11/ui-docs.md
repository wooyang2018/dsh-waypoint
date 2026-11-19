# 客户端 UI、宿主 API 与文档评审

范围：`local-plugin/src/client/*`、`local-plugin/src/host-api/*`、`local-plugin/src/{tools,messages,config,hosts/types}.ts`、README×2、`AGENTS.md`、`docs/*`

分支：`review/ui-docs`（5 个提交）　严重度分布：Major 6 / Minor 14 / Note 7

**分支状态**　`AGENTS.md`、`README.md`、`README.zh.md`、`docs/operations.md`、`docs/remote-workspace-mechanism{,.zh}.md`、`packages/local-plugin/README.md`　+976 −15

---

<a id="uix-01"></a>
## UIX-01　Major　源码里的乱码注释　未修

**位置**　`packages/local-plugin/src/client/index.tsx:28`

**现象**　`/** Register the 杩滅▼寮€鍙?page. */`——GBK/UTF-8 混淆后写回源码的残留。

**证据**　逐码点转储为 `U+6769 U+6EC5 U+25BC U+5BEE U+20AC U+9359 U+003F`；按 GBK 编回字节再用 UTF-8 解码得 `远程开�?`，反推原文为「远程开发」。`git blame` → `ba062a4`。全仓 `src/` 45 个文件逐行扫 `U+FFFD` 与常见乱码串后**只此一处**（`locale.ts` 中文正常）。

**影响**　公开仓库里把损坏文本当「产品名」发布；该文件其余注释全英文，只有这一行是中英混杂残骸。

**修复建议**　改成英文，与其余注释一致：`/** Register the Remote development settings page. */`

**状态**　未修（**这是最小、最该先修的一条**）

---

## UIX-02　Minor　`phase.*` 无测试护栏　未修

**位置**　`packages/local-plugin/test/i18n.test.ts:13-16`、`client/locale.ts:108-114,281-287`、`hosts/types.ts:24-31`

**现象**　`i18n.test.ts:13` 的循环只遍历 `HOST_DETAILS`，`phase.*` 零断言。当前键集与 `HostPhase` 联合恰好相等（7=7），是潜伏而非已爆发。

**证据**　实测 `t(\`phase.${phase}\`)` 不加 `as CopyKey` 也能通过编译（模板字面量类型天然收窄到联合），所以类型系统管不到 locale 字典。

**影响**　任何一次给 `HostPhase` 改名/加成员，会渲染出 key 本身而不是文案，且 tsc 不报错。

**修复建议**　让联合由常量派生，复用现有循环：

```ts
// src/hosts/types.ts
export const HOST_PHASES = ['idle','discovering','installing','connecting','connected','disconnected','error'] as const
export type HostPhase = (typeof HOST_PHASES)[number]

// test/i18n.test.ts
for (const phase of HOST_PHASES) {
  assert.ok(`phase.${phase}` in zh, `missing zh phase.${phase}`)
  assert.ok(`phase.${phase}` in en, `missing en phase.${phase}`)
}
```

**状态**　未修

---

<a id="uix-03"></a>
## UIX-03　Major　500ms 心跳无退避、不感知页面可见性　未修

**位置**　`packages/local-plugin/src/client/index.tsx:34-68`（关键 58、61）

**现象**　①无退避：`catch {}` 后紧接 `if (active) timer = schedule(…, 500)`，失败与成功同一路径，断连即 2 req/s 永久重试；②无可见性判断：`document.hidden`/`visibilitychange` 在 `src/client/**` 零命中；③零主机时也在跑（effect 无条件安装）；④claim 是**破坏性单消费者**：`takeOpenSession()` → `mirror/service.ts:781-786` 的 `shift()` 取出即销毁。

**影响**　断连形成重试风暴；N 个标签页 → N×2 req/s，且后台标签页赢得 claim 时前台永远看不到会话被打开（「新建后没反应」）；移动端耗电。

**修复建议**　成功/失败分开退避（失败 index 退到 8s）+ 可见性门（隐藏时 5s）+ 稳态 2s 仍安全（服务端 TTL 5s）。**不要**把 claim 改成服务端持久化，那是协议改动。

**状态**　未修

---

<a id="uix-04"></a>
## UIX-04　Major　`host/files/*` 的 cast 绕过参数校验　未修

**位置**　`packages/local-plugin/src/host-api/handler.ts:303-334`（314-319 的 `as unknown as`，326、331-333）

**现象**　cast 把 `range` 声明成 `unknown`，于是 offset/limit/length 完全绕过本模块自称负责的参数校验。

**证据**　用 TS Compiler API 在真实 program 里问：`ctx.get('workspaceFiles') :: WorkspaceFiles | undefined`、`ctx.get('sessions') :: SessionStore | undefined`——**真实类型本来就在**，不需要 `as unknown as`。cast 后的结构体写 `read(scope: unknown, path: string, range: unknown, …)`，所以塞 `unknown` 也合法。真实原因是 `scope.sessionId` 是 `string` 而 `WorkspaceFileScope` 要 `SessionId`。

**影响**　①形状错误以 `internal`（"插件内部错误"）而非 `request/invalid` 回报；②接口一变就静默失效（`readBytes` 的 options 若改名，编译通过、运行时 `undefined`，而 `MirrorFileResult.value?: unknown` 不做形状检查）。

**修复建议**　换成真实类型，只加一个品牌断言：

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'

const files = ctx.get('workspaceFiles')
if (files === undefined) return { mirrored: false }
const scope: WorkspaceFileScope = { sessionId: sessionId as SessionId, workspaceRoot: root }
```
已实测该写法在真实类型下编译通过。

**状态**　未修

---

## UIX-05 / UIX-06　Minor　可删的 cast 与应换品牌断言的 `as never`

| ID | 位置 | 问题 |
|---|---|---|
| UIX-05 | `client/routing.ts:38` | `ctx.uiWorkspace as unknown as WorkspaceService \| undefined` 是纯损失：编译器查询显示 `ctx.uiWorkspace :: UiWorkspace` 且 `assignable to WorkspaceService: true`；cast 声明成 `\| undefined` 让 39 行的判空永远为假 |
| UIX-06 | `client/workspace-add.ts:56`、`client/api.ts:166`、`workspace-add.ts:283`、`host-api/handler.ts:311` | 一处可删的 cast（`pickDirectory` 已在 `UiWorkspace` 上）；三处 `as never` 应换 `as SessionId` / `as WorkspaceId`——已用独立探针证明品牌断言合法 |

**影响**　`as never` 是最强的「关掉检查」：让实参对任何参数类型都成立，方法签名变化完全不报错。

**状态**　未修

---

## UIX-07　Minor　浏览器侧文件代理与 DSH 类型零链接　未修

**位置**　`client/remote-files.ts:25`（配套 `index.tsx:72`）

**现象**　整张 Remote face 手抄一遍；挂载所用服务名 `'remote.workspaceFiles'` 在可见类型里不存在（`ctx.remote :: ClientRemote`，成员只有 `$stream,$host,$mount,$on`）。

**证据**　`@deepseek-ai/dsh-api-gateway` 未安装；实测 `ctx.inject(['notAThing'], …)` 与 `ctx.inject(['remote.workspaceFiles'], …)` 一样编译通过（`Inject = (keyof M)[]` 退化成 `string[]`）。

**影响**　形状变化编译通过、运行时静默传错；服务名将来不存在时静默退回 Host 侧适配器，两种实现并存无人察觉。

**修复建议**　保留 cast，但补写时检查（`AssertAssignable` 类型断言），让 drift 有编译期报错。

**状态**　未修

---

## UIX-08　Note　必要的基本桥接

`client/index.tsx:31`（`ctx.locale` 不存在，locale 服务增补包未装）与 `model-catalog-merge.ts:274`（`modelDirectories` 在全部 `.d.ts` 里零命中）是**不可避免**的桥接，不报缺陷。建议把接口形状写成 `Pick<>` 并加出处注释，不引入新依赖。

---

## UIX-09　Minor　远端模型下线后留幽灵条目　未修

**位置**　`client/model-catalog-merge.ts:295,319-339`

**现象**　`const intended = remembered ?? pickStillOffered(...)`：`remembered` 一旦存在，可用性检查与默认回退都不再执行。

**影响**　模型菜单显示远端已不提供的模型；发送时靠 `session/model-unavailable` 回退重发，界面在说谎。

**修复建议**　让记录也接受可用性检查，只在目录不可用时才信任记忆；补一条「先选 v4-pro → 第二次目录不含它」的测试（改前应失败）。

**状态**　未修

---

<a id="uix-10"></a>
## UIX-10　Major　`host/files/bytes` 把二进制破坏成数字键对象　未修

**位置**　`host-api/handler.ts:324-329` + `client/remote-files.ts:48-51`

**现象**　`files.readBytes` 返回 `data: Uint8Array`，而响应统一走 `Response.json`。

**证据**　实测 `Response.json({data:new Uint8Array([137,80,78,71])})` 的 body 是 `"data":{"0":137,"1":80,"2":78,"3":71}`；roundtrip 后 `is Uint8Array: false`。对照 Host 侧适配器 `remote/files.ts` 是**正确**的（`Buffer.from(result.data,'base64')`）。

**可达性**　未验证。`installRemoteFiles` 只在 `ctx.remote.workspaceFiles` 存在时安装（见 UIX-07，该名字在可见类型中不可解析），若注入不成立则整条路径是死代码、真实流量走 Host 侧。**无论是否可达，编码都该修，成本极低。**

**修复建议**　线上传 base64、浏览器侧解码；顺手把 `MirrorFileResult.value` 从 `unknown` 收紧。

**状态**　未修

---

## UIX-11 / UIX-12　Minor / Note　终端 SSE 路由的两处问题

| ID | 位置 | 问题 |
|---|---|---|
| UIX-11 | `host-api/terminal.ts:84-106`（对照 71-76） | `attach` 分支在 abort 后仍可能 `enqueue`/`close` 已取消的流，抛未处理的 rejection；`retain` 分支反而做了保护。客户端断开 → controller `enqueue` 抛 `TypeError: Invalid state`，finally 里 `close()` 再抛一次 |
| UIX-12 | `host-api/terminal.ts:88-90` | SSE 无背压：`for await (…) controller.enqueue(…)` 不读 `controller.desiredSize`；浏览器慢时 PTY 输出在宿主内存无界累积（`cat` 大文件即可） |

**状态**　未修

---

<a id="uix-13"></a>
## UIX-13　Major　工作区路径跨主机串台　未修

**位置**　`client/RemoteDevelopmentPanel.tsx:264,516-533,923`

**现象**　`const [workspaceDraft, setWorkspaceDraft] = useState('')` 无 hostId 维度；`addWorkspace(host)` 直接用 `workspaceDraft.trim()`；`toggleHost` 从不重置它；同一时刻只有一台主机展开。

**影响**　多台远端主机的 home 布局通常相同（`/home/<user>/project`），「为 A 输入路径 → 切到 B → 回车」会在 **B 上创建一个真实存在的错误工作区**并镜像进侧边栏，用户会以为是同步错乱。

**修复建议**　按主机分桶：

```ts
const [workspaceDraft, setWorkspaceDraft] = useState<Record<string, string>>({})
const draft = workspaceDraft[host.id] ?? ''
const setDraft = (value: string) => setWorkspaceDraft(prev => ({ ...prev, [host.id]: value }))
```

**状态**　未修

---

## UIX-14 / UIX-15　Minor　一次失败被固化成「没有工作区」

| ID | 位置 | 问题 |
|---|---|---|
| UIX-14 | `RemoteDevelopmentPanel.tsx:490-506`（495）、`305-309` | `catch { setWorkspaces({...current, [hostId]: []}) }` 把 `undefined`（读取中）改成 `[]`（确实为空），而 306 行的自动加载条件是 `=== undefined`，**此后不会再自动重试**；渲染出「远端还没有注册工作区」，是事实错误，且不会自愈 |
| UIX-15 | `RemoteDevelopmentPanel.tsx:463-481,490-506` | `loadCatalog`/`loadWorkspaces` 无 `cancelled`/`mounted` 守卫（对照组 `api.state()` 的轮询在 280-302 明确用了）；`while (pending !== undefined) await pending` 在永不 settle 的请求上永久挂起，`busy` 一直不清 |

**状态**　未修

---

## UIX-16 / UIX-17　Minor　宿主 API 的两处结构问题

| ID | 位置 | 问题 |
|---|---|---|
| UIX-16 | `host-api/handler.ts:86-338` + `contract.ts:27-61` | 34 个 endpoint 与联合目前一一对应，但**无机器检查**：类型层做不到（`HostApiPayloads`/`HostApiValues` 是纯类型），`dispatch` 靠 `as HostApiEndpoint` + `default` 兜底。新增 endpoint 只改一边不会被拦住 |
| UIX-17 | `host-api/handler.ts:354-371`、246 | `requireStringField` 返回 `trim()` 后的值，`optionalStringField` 返回**未 trim** 原值。于是 prompt 的 `text` 被 trim（用户以缩进表达的代码片段被改写），而 `label: "   "`、`title: "  "` 被当作合法值接受并落盘 |

**状态**　未修

---

## UIX-18　Minor　`AGENTS.md` 关于 react 的陈述不实　✅ 已修

**位置**　`AGENTS.md:106`

**现象**　称 `react` entries 在 devDependencies 与 peerDependencies **两边都有**，实测 `react in devDeps? False`、`in peerDeps? True`。

**影响**　这条是给未来维护者的「不要当冗余删掉」的说明书；react 那一半说错会让人以为删 peer 无所谓（实际删了就是装机 bug）。

**修复**　拆成两条事实陈述：`@deepseek-ai/dsh-*` 两边都有；`react`/`react-dom` **仅 peer**，由根 `devDependencies` 供本地 typecheck/构建。

---

<a id="uix-19"></a>
## UIX-19　Major　三份 README 与代码相反　✅ 已修

**位置**　`README.md:329`、`README.zh.md:252`、`packages/local-plugin/README.md:94`

**现象**　三处都说「超过 `mirrorMaxEvents` 的远处 Session **不会**镜像」。

**证据**　代码 `mirror/service.ts:2004-2019` 明确「seed from the first complete turn in that tail」，并有注释 + `truncated` 分支；`CHANGELOG.md` 0.8.10 也这么记载；新增文档亦然。

**影响**　用户会按 README 去调大 `mirrorMaxEvents` 或「去远端打开」，而实际尾部已经镜像好了。**这条是合入新文档前必须先修的**，否则同一仓库自相矛盾。

**修复**　三处统一为准确表述。agent 额外发现 `docs/operations.md:189` 也写着旧行为（超出点名的三处），一并修了。

**验证**　`grep mirrorMaxEvents` 在 README.md / README.zh.md / packages/local-plugin/README.md / docs/operations.md / 两份新文档共 6 处，语义一致。

---

## UIX-20　Minor　运维文档指向不存在的 UI　✅ 已修

**位置**　`docs/operations.md:98,106,341`

**现象**　`98`/`341` 的「**Workspaces +** → **远程新建工作区…**」已不存在（现为统一对话框，标签 `Add workspace`/`添加工作区`）；`106` 的「Click **+ 新会话** in Settings」与仓库自己的测试 `discovery_panel.test.ts:661` 直接冲突（设置页故意没有该按钮）。

**影响**　用户按文档找不到入口；文档与测试断言互相矛盾。

**修复**　按实际 UI 改写；agent 明确说明只用了 `locale.ts` 里真实存在的标签，**没有臆造**。

**验证**　`grep 远程新建工作区 docs/` 为空。

---

## UIX-21　Minor　`SECURITY.md` 版本　✅ 已修（由 tooling 分支执行）

与 TOL-07 是同一条，为免冲突指派给 tooling，本分支未重复修改。

---

<a id="uix-22"></a>
## UIX-22　Major　中文文档的语言策略　✅ 已按决定处理

**位置**　`docs/remote-workspace-mechanism.md`（新增 408 行）+ `README.md:391`、`README.zh.md:313`

**现象**　`docs/` 下**没有任何一篇全中文的现行技术文档**：`protocol.md`/`testing.md`/`development.md`/`adapting-to-dsh-releases.md` 的 CJK 计数都是 0，`operations.md` 只有 166（全是引用的中文按钮名），`remote-development-design.md` 有 3041 但开头是显式的 historical note。README.zh.md 的模式是「中文 README + 链接到英文 docs」。而本次改动让**英文** `README.md` 指向一篇纯中文文档。

**影响**　公开仓库的文档语言门槛被这一次改动单方面改掉；英文读者点进 Documentation 读不到内容。

**处理（按你的决定）**　主文件 `docs/remote-workspace-mechanism.md` 改为**英文正文**，中文原文移到新文件 `docs/remote-workspace-mechanism.zh.md` 并在头部加语言声明，**只从 `README.zh.md` 链入**。

**未验证**　翻译是单次产出，**没有第二人校对**；术语（mirror / anchor / façade / projection / seam）与 `protocol.md`/`operations.md` 既有用词是否一致，建议维护者复核。

---

## UIX-23　Minor　81 处写死行号　✅ 已修

**位置**　`docs/remote-workspace-mechanism.md:8` 及全文

**现象**　81 处 `file:line` 引用（57 个区间 + 24 个单行），全部钉在 `1499dd1`。

**证据**　agent 逐条核验了 20 余处（`mirror/service.ts:2716-2742` 的 `appendRemoteEvent` 起止行完全吻合、`2313-2344` 的代码引文逐字一致等），**今天全部准确**。同时 `grep` 显示**只有这一篇**钉了 commit hash。

**影响**　一次 `mirror/service.ts` 的正常重构就会让 81 处引用全部错位，而读者无法分辨「行号错了」与「行为变了」；`1499dd1` 这个 pin 反而给了虚假的精确性。

**修复**　改成 `path → symbol` 引用；第 8 行的 commit hash 改成版本表述。

**验证**　`grep -c ':\d'` 从 81 降到 **3**（剩下 3 个是 `127.0.0.1:p` 端口串，非行号）；75 个 `file → symbol` 引用逐个做存在性检查，25/25 命中（首轮报 25 个 NOT FOUND 是 agent 自己脚本把 `#` 双转义所致，改用 `-SimpleMatch` 重跑后全中）。

---

## UIX-24　Note　文档的自我披露　✅ 已改

第 11 节原为一句「没有运行 pnpm test/typecheck」，改为「已验证 / 未验证」两张清单：静态核对过的符号引用与代码引文 vs 未运行的测试、未渲染的时序图、未连真实主机。

---

## UIX-25 / UIX-26 / UIX-27　Note　未修

| ID | 位置 | 问题 |
|---|---|---|
| UIX-25 | `client/locale.ts:27,89,90,107`（zh）与 `200,262,263,280`（en） | 4 个 locale key 已无产品代码调用方（`settings.discovered.skipped`、`settings.collapseWorkspaces`、`expandWorkspaces`、`settings.newSession`），只被测试当作「不存在」的反向断言引用 |
| UIX-26 | `tools.ts` 12 处 | 12 个工具与 README 表格一一对应（已逐条比对），但 `additionalProperties: false` 只保护 3 个标量返回；对象型返回一律 `true`。`false` 的三个会**直接失败**（模型看到工具报错），`true` 的那些**静默全量透出**——`HostView` 将来多一个字段，schema 拦不住 |
| UIX-27 | `tools.ts:28,255,284` | 审批守卫只覆盖 4 个 host 写工具；`remote_session_create`/`remote_session_prompt` 的 description 自称 "write operation" 却不需审批，措辞与守卫集合冲突（设计意图清晰，措辞需要收窄） |

---

## 已复核且未发现问题

1. **新增文档的事实准确性**：20+ 处 `file:line`、4 段代码引文（`#followStream` 的 gap 检测、`tunnelArgs` 的 `-L/-R`、`discoverAgent` 的两个 throw、锚点创建块）与源码逐字一致；`mirrorMaxEvents` 默认 2000、`VISIBLE_SESSION_TTL_MS = 5_000`、`--port 0`、`exit 21/22`、`chmod 600`、`409 version-mismatch`、`agent/not-live`、指纹不回传密钥全部核对无误
2. **`AGENTS.md` 文档地图**：三行插入位置正确，措辞与相邻条目同构
3. **`env.d.ts` 确属「看似死代码但不是」**：用等价最小工程实测——无 `declare module '*.css'` 时报 `TS2307: Cannot find module './panel.css'`，加上后 exit 0
4. **`panel.css` 动态类名**：5 个 `.dshwp-dot-*` 规则确实存在，组合点在 `RemoteDevelopmentPanel.tsx:667`；`idle`/`disconnected` 走基础灰点规则，与 union 一致
5. **`routing.js` 的「exports nothing」**：全文无 `export`；`build.mjs:28,31` 校验 3 个标记；`client-bundle.test.ts` 对拼接产物断言，`ensure-built.ts` 存在
6. **`host-api` 34 个 endpoint 与联合当前一一对应**（脚本比对：缺失 0、多余 0）；`handleHostApi` 对非 JSON/非对象/未知 endpoint 都回 `request/invalid`，全部走 HTTP 200 + `ok:false`
7. **`remote-files.ts` 未注册 `readBytes`** 在客户端代理里是**有意**的，Host 侧适配器五个方法全接管——两侧刻意不同，不是遗漏
8. **`tools.ts` 的 12 个工具与 README 表格一一对应**；`remote_host_remove` 全仓 0 命中
9. **`messages.ts` 与 `locale.ts` 对齐**：`HOST_DETAILS`(32)/`UI_TEXT_KEYS`(34) 与 `detail.*`(32)/`error.*`+`toast.*`(34) 一致，`i18n.test.ts` 已覆盖
10. **`host/files` 的镜像门**：非镜像会话正确交还客户端回退路径，没有越权读取本地任意文件
11. **`terminal.ts` 的 `retain`**：首帧 + 挂起直到 abort，与声明的 `scrollback`/`maxBufferedBytes` 一致

## 越界但值得记录

1. `remote/files.ts:37` 与 `handler.ts:314` 是**同一类** cast，但前者已 import 真实类型，两处一起改才能统一口径
2. `mirror/service.ts:533-557` 的 5 处 `ctx.on('agent/created' as never, …)` 是比 `host/files` 更严重的类型逃逸（21 处 `as never`、23 处 `as unknown as`）
3. `remote-agent/src/service.ts` 11 处 `as never`，同样集中在 `ctx.on` 事件名
4. `AGENTS.md:138-158` 的「看似死代码」三条建议补一句「本轮已验证」的日期，防止清单本身腐烂
5. `docs/operations.md` 与 README 排查表是**两份**高度重叠的表格（19 vs 17 行），已出现分叉
6. `client/workspace-add.ts:20-22` 的模块级单例 `closeDialog/closeBrowser/closeMenu`：多实例或热重载时后挂载者会接管先挂载者的弹窗
