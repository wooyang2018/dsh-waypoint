# 协议与文档评审

范围：`packages/protocol/src/*`、`docs/protocol.md`、`packages/remote-agent/README.md`、`packages/testkit/src`

分支：`review/protocol`（9 个提交）　严重度分布：Major 6 / Minor 6 / Note 4

**分支状态**　`docs/protocol.md`、`packages/remote-agent/README.md`　+160 −75　代码零改动

---

<a id="prt-01"></a>
## PRT-01　Major　错误码表缺 7 条　✅ 已修

**位置**　`docs/protocol.md:96-112`

**现象**　表里 12 行，实现 `PROTOCOL_ERROR_CODES` 有 19 条。

**证据**　`errors.ts:14-34` 共 19；缺 `session/model-unavailable`、`workspace-file/not-found`、`workspace-file/not-regular-file`、`workspace-file/not-text`、`directory/unreadable`、`terminal/unavailable`、`terminal/error`。

**影响**　本表是客户端/UI 分支依据；缺行会让 `local-plugin/src/messages.ts:106`、`client/errors.ts:27` 已适配的码在文档里查不到。

**修复**　整表替换为 19 条，逐条标注 HTTP 状态与含义；`retryable` 说明段改为如实描述「本地插件不据此分支」。

**验证**　脚本自证：`error table rows: 19`、`all 19 codes appear exactly once: true`。人工复核：19/19 均为表格行。

---

<a id="prt-02"></a>
## PRT-02　Major　路由表缺 5 条已实现路由　✅ 已修

**位置**　`docs/protocol.md:116-149`

**现象**　GET 表缺 `/llm/catalog`、`/sessions/:id/assistant-events`；POST 表缺 `/sessions/:id/model`、`/sandbox`、`/archive`。

**证据**　`routes.ts:14-30,204-230` 与 `http.ts:114-253` 实测。反方向（文档有/实现无）为 0。

**影响**　`remote-agent/README.md:36-40` 是正确全集 → 两份文档互相矛盾。

**修复**　两张表替换：GET 15 行（含把 `/approvals/events` 从正文提进表）、POST 13 行；补 `content` 内容类型与体积上限；修正 prompt「text 必须非空」为「text 非空**或** content 含 image」。

**验证**　`GET rows: 15`（=实现全部 GET 落点）、`POST rows: 13`（=实现全部 POST 分支）。

---

<a id="prt-03"></a>
## PRT-03　Major　范围声明与实现矛盾　✅ 已修

**位置**　`docs/protocol.md:6`、`151-155`、`307-309`

**现象**　第 6 行写 `No arbitrary shell or file-content access`，但 `/files/read`/`/files/bytes` 返回文件内容、`POST /terminals` 直接 `spawn('python3', …shell)`；307-309 又说文件/终端不属本协议，而 `remote/files.ts:49` 用的正是 `RemoteAgentClient.fileRead`。

**影响**　安全边界描述失真：token 实际等价于远端 shell + 任意文件读。

**修复**　改为明确「文件内容读取与终端 shell 都在本协议内；token 即远端 shell 权限，信任边界是 token + loopback，不是命令白名单」。

---

## PRT-04　Major　导出符号计数与集合　✅ 已修

**位置**　`docs/protocol.md:319`、`337`、`322-358`

**现象**　文档称 `60 + 65 = 125`，实际 TS 导出 127；且 `sessionCancelPath` 重复、`RemoteTerminalListResult`/`RemoteTerminalShell` 同时出现在两节。

**证据**　TS Compiler API：`index.ts` 导出 **127**；跨包 named import 去重 **60**；非契约 **67**（44 仅内部引用 + 23 无人引用）。62+67−2=127，而文档自报 125，缺的正是被两节重复计入的 2 个类型。

**修复**　`Import contract (60)` + `Internal (67)`，Internal 再拆「仅内部引用 44」「无处引用 23」；删除重复项；两组名单用脚本对比实际计算值（`extra: []`、`missing: []`）。

**验证**　`contract 60 + internal 67 = 127 vs exports 127 -> OK`。

> 注：我在派发时误以为 `isApiSuccess` 同时出现在两节——实际它只在 Internal 出现一次，360-362 的第二次是正文说明。agent 按实际内容修正，没有照抄我的错误。

---

## PRT-05　Minor　agent README 的幽灵版本　✅ 已修

**位置**　`packages/remote-agent/README.md:28`

**现象**　示例写 `dsh-waypoint-agent@0.2.12`，实际包版本 `1.0.0`。

**修复**　改为不写死数字的占位形式，避免下次漂移。

---

## PRT-06　Minor　响应头示例钉死旧版本　✅ 已修

**位置**　`docs/protocol.md:54`

**现象**　示例 `x-dsh-waypoint-agent-version: 0.2.10`，实际 `AGENT_VERSION='1.0.0'`。

**修复**　改成占位符，不写死数字。

---

## PRT-07　Minor　声称回显 host-id 头，实际没有　✅ 已修

**位置**　`docs/protocol.md:55`

**现象**　文档称每个响应回显 `x-dsh-waypoint-host-id`，但 `http.ts:61-65` 只设 4 个头，`testkit/src/fake-host.ts:179-182` 同样没有。

**影响**　多宿主客户端若依赖回显做缓存隔离，会拿到 `undefined`。

**修复**　删除该行，改为说明 `hostId` 只在 JSON body 中返回。

**未验证**　没有起真实 agent 去 `curl -i`；依据是已被人工复核过的静态事实。

---

<a id="prt-08"></a>
## PRT-08　Major　GET 命中仅 POST 路由时不返回响应　未修（代码）

**位置**　`packages/remote-agent/src/http.ts:204-253`；`packages/testkit/src/fake-host.ts:369-457`

**现象**　GET `switch`（248-252）只列了 4 个 POST-only 分支，**无 `default`**，函数直接返回 → 连接挂起。

**证据**　真实 handler + stub service，600ms 超时判定：`GET /files/stat|list|read|bytes`、`/sessions/:id/model|sandbox`、`/terminals/:id/input|rename|close` 全部无响应；对照 `GET /sessions/:id/prompt` 正常 405。

**影响**　误用方法时客户端只能等到 `DEFAULT_REQUEST_TIMEOUT_MS` 超时，拿到裸 `AbortError`；agent 侧泄漏一个挂起请求。

**修复建议**　GET `switch` 末尾加 `default:` 抛 405；fake-host 同步补齐并补 `llm/catalog`、`assistant-events`、`files/*`。

**状态**　**代码未修**（用户本轮跳过代码修复）。但文档已改为如实描述现状——见下方说明。

---

## PRT-08 附　文档如何描述这个缺陷　✅ 已修

你批准的是「文档与代码一致」，而 PRT-02 的初稿写下了「方法错误返回 405」——一个今天**不成立**的行为。我追加了一轮修正，把这句拆成三档实测事实：

```markdown
A wrong method on a known path returns `405` with code `request/invalid` where the route declares a
single method — `GET` on `session.prompt`, `session.cancel`, `session.archive`, and `approval.answer`;
`POST` on any read route; and any method other than `GET` or `POST` anywhere. The remaining POST-only
routes (…) currently answer a `GET` with no response at all, so a client that sends the wrong method
sees its request time out rather than a `405`. Treat these routes as POST-only and do not rely on the
method check.
```

agent 在落地时**纠正了我给的分组**：我漏了「PUT/DELETE/PATCH/OPTIONS 在任何路径都返回 405」这一档（`http.ts:179-185` 的 `if (method !== 'GET')`），并实测验证了全部 15 个 GET 落点 + 11 个 POST 落点 + 5 种其他方法。

---

## PRT-09　Major　SSE 消费者提前 break 时不 cancel　未修

**位置**　`packages/protocol/src/sse.ts:106-108`

**现象**　`finally` 只 `releaseLock()`，从不 `cancel()` 响应体，HTTP 连接与 agent 侧 follower 一直存活。

**证据**　`for await (…) { break }` 后 1.8s，服务端 `res.on('close')` 从未触发、socket 仍打开；收到 `event: end` 后 break 同样如此。

**影响**　`mirror/service.ts:2322`、`remote/files.ts:128-160`、`attachTerminal` 的消费方都可能中途停读 → 每个遗留实例泄漏一个 socket + 一个服务端生成器；`/files/watch` 是长连接，影响最明显。

**修复建议**　`finally` 内改 `try { await reader.cancel() } catch {}` + `releaseLock()`（`done===true` 时 `cancel()` 是空操作）。

**状态**　未修

---

## PRT-10　Minor　未知错误码被折叠成 `internal`　未修

**位置**　`packages/protocol/src/client.ts:512`、`550`

**现象**　两处 `isProtocolErrorCode(x) ? x : 'internal'`，原始码丢失。

**证据**　`mirror/service.ts:2888` 恰恰靠 `details.remoteCode === 'session/model-unavailable'` 分支，说明这套约定已在用，却没在 client 统一入口落地。

**影响**　不会掩盖可重试性，但会**错误归类**：新 agent 新增的码在旧客户端上表现为 `internal`（500），可操作性信息丢失。

**修复建议**　折叠时保留原码到 `details.remoteCode`。

**状态**　未修

---

## PRT-11 / PRT-12 / PRT-13 / PRT-14 / PRT-16　Note～Minor　未修

| ID | 位置 | 问题 |
|---|---|---|
| PRT-11 | `errors.ts:84-88`、`docs/protocol.md:111-112` | `isRetryableCode` 只认 `agent/not-ready`/`internal`，与文档「不在认证错误上重连」不成立——`service.ts:1334-1346` 健康检查任何异常都重连；`agent/not-ready` 实际不可能以 503 出现（在挂载期抛出） |
| PRT-12 | `routes.ts:139-147` | `segment()` 不拒绝 `..`/`/`/NUL`。实测 `%00` → `sessionId:'a\u0000b'`、`%2F` → `'a/b'` 均放行；但 id 只作 Map key 不拼路径，**无目录穿越**，风险限于日志注入 |
| PRT-13 | `stream.ts:47-55`、`docs/protocol.md:244-258` | 突发下多帧携带同一 `cursor`（`onEvent` 取 `cursor.next`，真正推进在消费端）；现有消费方都用 `event.seq` 故未爆雷 |
| PRT-14 | `version.ts:13-19,67-79` | `PROTOCOL_VERSION=MIN=MAX=1`，无灰度能力。加字段/加路由恰好兼容；**加错误码不兼容**（旧客户端折叠成 `internal`，见 PRT-10） |
| PRT-16 | `remote-agent/src/files.ts:45-50,92-94` | 任何 `stat` 失败（含 `EACCES`）都映射为 `workspace-file/not-found`；`not-text` 只检测 NUL 却报 "not UTF-8 text" |

---

## PRT-15　Minor　接口块缺字段　✅ 已修

**位置**　`docs/protocol.md:166-180`、`203-212`、`147`

**现象**　`HostInfo` 缺 `loginShell`/`modelBaseUrl`/`modelKeyConfigured`/`modelKeyFingerprint`（其中 `loginShell` 被 `remote/terminal.ts:65` 实际使用，`modelKeyFingerprint` 被 `service.ts:1132` 用于漂移检测）；`RemoteSessionSummary` 缺 `origin`/`parentSession`；`RemoteSessionEvent` 的 `surfaceOp`/`sourceEventSeqs` 只有正文没有接口。

**修复**　补齐上述字段与事件接口；第 147 行改为「text 非空，或 content 至少含一个 image 部分」。

---

## 已复核且未发现问题

1. **版本协商**：单版本等值判断、`parseProtocolHeader` 对空/空白/非整数返回 `undefined`、三分支与 409 映射一致、`details` 带全
2. **SSE 解析器分块边界**：逐字节喂入 + CRLF + 多字节 UTF-8 跨块（`日本語`）解析正确；多行 `data:` 以 `\n` 合并；`:` 注释心跳被忽略；EOF 残帧会被 dispatch
3. **游标语义**：`applied/duplicate/gap` 与文档「cursor 是下一个期望 seq」逐条吻合
4. **路由解析正向行为**：空段/尾斜杠/大小写敏感/二次编码均正确；`..` 在真实 HTTP 路径上已被 WHATWG `new URL` 归一化，**无目录穿越**
5. **错误码 → HTTP 状态是全函数**：19 条 `switch` 无遗漏（`strict` + 返回类型强制穷尽）
6. **客户端信封处理**：非 2xx 先解 JSON 再判；`retryable` 线上透传；`redirect: 'error'` 防重定向泄漏 bearer；`AbortSignal.any` 合并信号
7. **运行时守卫**：`isRemoteTerminalInfo`/`isRemoteFileText`/`isModelCatalogResult` 均拒绝半成品对象
8. **文档与实现一致的部分**：SSE 首帧 `ready`、缺口 `reason:"error"` 收尾、`cursor > session.seq` 拒绝、`limit` 默认 500、`workspaceId`/`cwd` 互斥、状态文件 0600 原子写、loopback 校验、`remote-agent/README.md` 端点表完整正确

## 越界但值得记录

1. `docs/development.md:125,130` 仍以 `0.2.12` 描述重装行为
2. `local-plugin/src/errors.ts:24` 的 `LocalErrorCode` 复用 `directory/unreadable`，本地与远端无法区分
3. `agent/service.ts:767-772`：`agent/not-ready` 使插件挂载失败，不如「注册路由但返回 503」对运维友好
4. `http.ts:350-360`：`POST /workspaces`、`/sessions` 返回 200 而非 201；`sendFailure` 未设 `allow` 头
5. `http.ts:203`：`parseHostId` 位于 SSE 分支之后，5 个流式路由不校验 host-id
6. `testkit` 的 fake host 缺 `/llm/catalog`、`/files/*`、`/assistant-events`，配合 PRT-08 目前无法作文件/模型 API 的契约替身
