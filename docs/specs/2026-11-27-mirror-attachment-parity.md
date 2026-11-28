# 附件必须在镜像边界的每个方向上流通，纯附件提示词必须能配对

状态：已实现（§12 记录了切片；发布说明见 CHANGELOG 的 `Unreleased` 一节）。

## 1. 背景与目标

三个缺陷共享同一个根因：镜像把「附件」当成了只会出现在本地输入框产出的 `user/message` 里的东西。

**缺陷 1 —— 工具结果里的图片从不同步。** 反向附件同步只按一种事件类型设门禁：

```ts
// packages/local-plugin/src/mirror/service.ts
async #syncEventAttachments(hostId: string, event: RemoteSessionEvent): Promise<void> {
  if (event.type !== 'user/message') return
  ...
}
```

`read_image` 工具调用产出的图片在**工具结果**里，不在用户消息里。远端 agent 提交的是：

```ts
// dsh-tool-fs/src/read-image.ts
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}
```

于是远端的 `tool/result` 事件携带一个 `ImageAttachmentRef`，其 `attachmentId` 是
**只存在于远端主机**的那些字节的 `sha256:<64 hex>` 摘要。本地会话记录回放该事件，
工具卡片从 `block.content` 里取出引用（`dsh-client-ui-tool` 的 `imageCardModel` → `imageReferences`），
然后图片加载器去**本地**附件库要这些字节。那里没有。

可见结果就是：每张远端 `read_image` 卡片上都是一个永久空白的图片——
这与镜像已经为「用户消息里的图片」修过的失败是同一个（`remote/attachments.ts` 的存在
正是因为「图片**就是**它的字节」），只是进入同一个库的第二条路径被漏下了。

**缺陷 2 —— 纯附件提示词永远配不上对。** 乐观消息配对要求文本非空：

```ts
// packages/local-plugin/src/mirror/service.ts
const index = runtime.pendingUsers.findIndex(pending => pending.text !== '' && pending.text === text)
```

只带图片或只带文件的提示词 `text === ''`，所以该条目永远匹配不上回放的 `user/message`。
镜像于是把这个回显当作**第二条**节点追加，一张图片变成两个气泡。

这个问题在 `promptParts` 还是直接丢弃 `file` 部分时被掩盖了；1.1.4 之后文件能正确转发，
于是纯图片或纯文件提示词可以稳定复现它。

**缺陷 3 —— 反向同步只覆盖了「助手可见」的引用，而不是每个可能携带引用的事件。**
与缺陷 1 同属一类遗漏：今天的门禁是单一事件类型，将来任何携带附件引用的事件都会静默跳过填充。

目标：本地会话记录能渲染的每个附件引用都解析到本地字节；纯附件提示词复用自己的乐观气泡。

成功信号：

1. 远端 `read_image` 的结果在本地渲染出图片。
2. 只发一张图片（或只发一个文件）只产生一个气泡。
3. 文本 + 图片仍然正确配对（无回归）。
4. 不支持 `attachment.read` 的旧 agent 退化为现有占位符，而不是报错。

## 2. 范围与非目标

范围内：反向同步的事件门禁、配对键，以及把二者钉住的测试。

范围外：

- 把工具结果的字节**送到**远端。工具跑在远端，其输入是远端自己的事。
- 流式同步。`syncRemoteAttachment` 按引用处理且已幂等（对象存在时在任何流量之前就短路），
  批处理是另一个议题。
- 重新编码或重新归一化任何图片。`publishVerbatim` 刻意把精确字节写进精确摘要下；
  改掉它会破坏所有既有引用。
- 改动 `attachment.read` 的线上形状。

## 3. 用户与场景

1. **让 agent 看一张截图。** 用户让远端 agent 读一个 PNG；卡片必须显示图片，而不是空框。
2. **不发文字只发图片。** 用户把一张图片拖进输入框直接发送；会话记录里必须只有一条消息。
3. **不发文字只发文件。** 同上，对象是文档。

## 4. 决策

**采用：把反向同步的门禁改为「该事件是否携带附件引用」，并用一个在空文本下仍然成立的
提示词身份来配对。**

| 被否决的方案 | 为什么不行 |
|---|---|
| A. 在现有 `if` 里加上 `tool/result` | 修好缺陷 1，仍留下缺陷 3：下一个携带引用的事件类型又会静默失同步。它还把「今天存在的两种类型」硬编码进一道本该问别的问题的门禁里。 |
| B. 按位置配对（`pendingUsers[0]`） | 本仓库已经试过并回退：被取消的提示词会留下残条目，队列会错位，于是该条目会认领另一个客户端发出的消息。现有代码上方的注释记录了这段历史。 |
| C. 按远端 request id 配对 | 远端 `user/message` 不回显本地 request id；镜像从未发送过可供匹配的 id。 |
| D. 比较内容数组去重 | 对回放内容做深相等很脆弱（附件引用被重写、base64 不携带），还会静默地把两次真正相同的发送并成一次。 |
| E. 纯附件提示词干脆不做乐观追加 | 用去掉即时反馈来消除重复：一张不带文字的图片在往返完成前什么都不显示。 |

## 5. 需求与验收

验收以 Given/When/Then 形式列在 §10。

- **R1** 任何回放事件中、内容可在本地渲染的附件引用都被同步。
- **R2** 同步保持幂等：同一事件再次处理不产生第二次传输。
- **R3** 只带附件的 `user/message` 与其乐观条目配对。
- **R4** 带文本的 `user/message` 与今天完全一样地配对。
- **R5** 连续两次完全相同的提示词仍然按顺序各自配对（不合并）。
- **R6** 不支持 `attachment.read` 的 agent 保持现有「unsupported」行为；会话记录里不出现错误。
- **R7** 同步绝不阻塞事件投影：一次失败的传输只让该引用降级，事件仍留在日志里。

## 6. 设计

### 6.1 泛化反向同步门禁（R1、R2、R7）

把事件类型门禁换成对「可能携带引用的事件」做内容扫描：

```ts
/** `data.content` / `data.message.content` 可能携带附件引用的事件类型。 */
const ATTACHMENT_BEARING_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result'])
```

并从各类型实际使用的字段里取出这些部分。**本文初稿把字段写错了**，实现时按本仓库锁定的 DSH 版本
（`@deepseek-ai/dsh-session` 0.2.2-rc.5 的 `SessionEventMap`）改正为：

| 事件类型 | 内容位置 |
|---|---|
| `user/message` | `data.content`（载荷本身就是 `UserMessage`） |
| `assistant/message` | `data.message.content`（载荷是 `{ message }`） |
| `tool/result` | `data.message.content`（同样包在 `{ message }` 里） |

现有辅助函数已经在遍历内容数组并判断 `type === 'image' | 'file'`；实现补的是按类型取正确的入口
（一张以类型为键的取值表），而不是写第二套实现。照初稿的字段写会静默弄坏**已经能用**的
用户图片同步，所以这张表也是「按类型取入口」这一层的实测依据。整体上仍满足 §6.1 的意图：
`Set` 与取值表是同一个联合的两个投影，新增事件类型时两处必须同时改。

这个 `Set` 是 R1 那个问题（「这个事件能不能携带引用？」）的诚实表达，也是将来新增事件类型的落点——
§12 有一条测试会在该列表与载荷形状不一致时失败。

**顺序（R7）。** 调用点在投影路径上，所以一次传输不能让事件延迟超出既有 await 已经付出的代价。今天是：

```ts
await this.#syncEventAttachments(runtime.record.hostId, event)   // 在投影之前
```

这个 await 对图片是刻意的——会话记录不能渲染一个字节还在路上的引用——并且它被
「每个未解析引用一次往返」所界定，已存在的对象会短路。保留它，也保留把失败降级为警告的
`try/catch`：一个谁也显示不了的附件不能把整轮停下来。

**体积。** `read_image` 的结果是一张归一化过的提示词图片；现有按引用的传输除了 agent 自身的
响应上限外没有额外上限。§9 记录该假设，而不是在这里发明一个新限制。

### 6.2 配对身份（R3、R4、R5）

配对键是「远端会回显的文本」**加上**一个附件签名，外加一层只比种类的退让。签名与种类都从
`#promptContent` 实际转发出去的内容导出，无需二次读取字节：

- **签名**：非文本部分按序的 `type:mediaType:name`，用于精确识别。
- **种类**：非文本部分按序的 `type`（`image`/`file`），不含 mediaType 与名字。

```ts
interface PendingUser {
  readonly message: unknown
  /** 远端回显回来的文本；纯附件提示词为空。 */
  text: string
  /** 已发送部分的稳定签名（type:mediaType:name 按序）。 */
  signature: string
  /** 已发送部分的种类（image/file 按序），用于签名被重编码打散后的退让。 */
  shape: string
  localSeq: number
}
```

示例：

| 提示词 | `text` | `signature` | `shape` |
|---|---|---|---|
| `"hi"` | `hi` | ``（空） | `` |
| 一张 PNG | `` | `image:image/png:` | `image` |
| 一张名为 `a.png` 的 PNG | `` | `image:image/png:a.png` | `image` |
| `[a.pdf]`（被改写的 `@`） | `[a.pdf]` | `file::a.pdf` | `file` |

匹配按三层退让：

1. **文本 + 签名**精确匹配。
2. 未命中且**文本非空**时，只按文本匹配。
3. 文本为空时，只按**种类**匹配，且种类必须完全相同（`shape` 为空则不与任何条目匹配）。

```ts
const text = promptTextFromRemote(event.data)
const signature = promptSignatureFromRemote(event.data)
const shape = promptShapeFromRemote(event.data)
const index = pendingUserIndex(runtime.pendingUsers, text, signature, shape)
```

第三层存在的理由是远端在接收时会重新归一化图片，落盘引用里的 mediaType（按 alpha 通道选
JPEG/WebP）或显示名可能与转发时不同；严格签名会把每个「文本 + 图片」变成重复气泡（违反 R4），
而纯附件提示词没有文本可退，两层在这里仍会把一张图变成两个气泡。只比种类、且要求种类完全相同，
所以下面那条「空文本守卫不能简单删掉」的坑依旧被关住（图片不会认领文件）。

远端无需改动：签名与种类都是按**回显**的 `user/message` 内容算出的，用的是与转发侧同一组函数，
所以二者按构造一致。若远端剥离或重命名了某个部分，三层都没中时自然落到今天的追加路径——
这是安全的方向（多一个气泡胜过吞掉一条消息）。

**一个要记录下来的坑。** 现在的 `pending.text !== ''` 守卫不只是形状检查；
它正是防止「空的待处理队列」去匹配一条文本同样为空的远端消息的东西。
在不引入签名与种类退让的前提下删掉它，会让每个纯附件消息都匹配到第一个空条目，
不管它携带的是什么——比它要修的重复更糟。§11 记录这一点。

### 6.3 签名与种类在哪里计算

两个函数（签名与种类），各自用两次：

```ts
function attachmentSignature(content: readonly unknown[]): string
function attachmentShape(content: readonly unknown[]): string
```

- 转发侧：作用于 `#promptContent` 返回的 `content`（改写之后，因而与回显一致）。
- 回显侧：作用于远端 `user/message` 的 `(event.data as { content?: unknown }).content`。

由于 `#resolveTextReferences` 会把 `@<path>` 改写成 `[<name>]`，而 `pending.text` 在发送前
被重新赋值为**转发出去的**文本（`service.ts`），两侧在文本上已经一致；签名与种类把同样的纪律
延伸到各个部分上。

### 6.4 与「取消」或「被拒」提示词的交互

`cancel()` 会清空 `pendingUsers` 并关闭该轮；被拒的提示词会把自身条目摘除。二者都不变：
签名只影响一个存活条目**如何被找到**，从不影响条目何时被丢弃。因此发送失败的提示词
仍然不可能认领后来的消息。

## 7. 边界与失败

| 情况 | 行为 |
|---|---|
| 缺少 `attachment.read` | `syncRemoteAttachment` 返回 `{ kind: 'unsupported' }`；卡片保留占位符。不变。 |
| 远端对象被裁剪（内容寻址库） | `{ kind: 'missing' }`，debug 级别；不抛错。 |
| 字节长度不符 | 抛 `LocalError`，被 `#syncEventAttachments` 的逐引用 catch 降级为一条警告；事件照常投影，该附件在本地不可用（§11）。 |
| 连续发送两张相同的图片 | 两次都配对，按顺序，因为每个条目匹配后被消耗。 |
| 远端消息没有对应的本地已转发条目 | 落到追加路径（不变）。 |
| 同一引用出现在两个事件里 | 第二次调用以 `present` 短路（R2）。 |
| 事件携带的 `attachmentId` 不是 `sha256:` | 在 debug 级别忽略（既有守卫）。 |

## 8. 质量属性

- **延迟。** 新增的同步被「每个新引用一次往返」界定，且只对产出图片/文件的轮次发生。
  已存在的对象零成本。
- **存储。** 内容寻址且幂等，重复回放收敛到同一个对象。
- **影响面。** 一道门禁、一个身份函数、一个结构体字段。`publishVerbatim`、`attachment.read`
  与转发路径均不变。

## 9. 依赖与假设

- 假设远端库保留其自身近期日志所引用的对象。被裁剪的对象降级为占位符而非错误（现有行为）。
- 假设 `attachment.read` 返回的 base64 在 agent 响应上限之内。
- 假设 `ImageAttachmentRef`/`FileAttachmentRef` 的 `attachmentId` 保持 `sha256:<64 hex>` 形状。
- 假设 `tool/result.data.message.content` 是块数组。形状不同则退化为「找不到部分」，
  这对该事件而言就是今天的现行为。

## 10. 验证

**单元与包级测试**

- `packages/local-plugin/test/mirror-attachments.test.ts` —— 携带图片引用的 `tool/result`
  恰好触发一次 `attachment.read`；第二次处理一次也不触发；带文件引用的 `user/message`
  行为与今天一致（无回归）；某个被加入 Set 但载荷形状未知的事件类型降级而不抛错。
- 同一文件 —— `attachment.read` 缺席 → 不调用、不报错；`attachment/not-found` → 不抛错。
- `packages/local-plugin/test/mirror-pairing.test.ts`（新增）—— 纯图片提示词只产出**一条**节点
  （断言本地会话的 `user/message` 条数，而不只是「没报错」）；纯文件提示词同理；
  文本 + 图片与今天一致地配对；连续两张图片按顺序配对；未匹配的远端消息仍然追加。
- `packages/testkit/src/fake-host.ts` —— 为图片与文件引用提供 `attachment.read`。

**验收**

1. *给定*一个镜像会话；*当*远端对一个 PNG 运行 `read_image`；*则*工具卡片显示图片，
   且本地库在远端 `attachmentId` 下持有相应对象。
2. *给定*同一会话；*当*同一轮在重启后被回放；*则*不发生第二次传输，图片仍然渲染。
3. *给定*一个镜像会话；*当*用户不带文字发送一张图片；*则*恰好存在一条消息节点，
   且远端日志中只有一条 `user/message`。
4. *给定*同上；*当*用户发送 `文本 + 图片`；*则*行为与今天一致。
5. *给定*一个不支持 `attachment.read` 的远端 agent；*当*某个 `read_image` 结果被回放；
   *则*卡片显示占位符，日志里只有一条 debug 记录。

## 11. 已接受的取舍

- **签名由内容推导，而不是由 id 推导。** 远端回显不保留本地 id，所以身份只能从可见内容重建。
  记录于 §6.2，含「为什么空文本守卫不能简单删掉」。
- **字节长度不符只让那一个附件失效，不会中断事件的投影。** 校验本身会抛 `LocalError`，而
  `#syncEventAttachments` 既有的逐引用 catch 把它降级为一条点名附件与主机的警告，事件照常
  投影。§7 初稿写的「中断投影 + `#noteSkipped` 记录缺口」与实现不符：`#noteSkipped` 记的是被
  跳过的**事件**，与附件无关；而且为一幅图丢掉整条消息本来就是更差的方向。也不回放与摘要
  不符的字节，对象从未落盘。
- **此处不引入传输体积上限。** `docs/specs/` 在这一层没有先例，而转发侧的 9 MiB 约束
  针对的是 12 MiB 的**请求体**，不适用于响应。病态对象是远端库的问题。
- **`assistant/message` 也被纳入承载集合**，尽管今天没有任何东西产出助手图片引用。
  代价是每个事件一次 `Array.isArray` 检查；替代方案是第三次静默遗漏。
- **配对键是三层退让，初稿只写了一层。** §6.2 记录三层：先按「文本 + 签名」精确匹配；未命中且
  文本非空时，退回只按文本匹配；文本为空时退回只按**部件的有序种类**（`image`/`file`，不含
  mediaType 与名字）匹配。原因：远端在接收时会重新归一化转发的图片，落盘引用里的 `mediaType`
  （按 alpha 通道选 JPEG/WebP）或显示名可能与转发时不同，严格签名会把每一个「文本 + 图片」
  提示词都变成重复气泡（违反 R4）——而纯附件提示词受同一个重编码影响，却没有文本可退。
  第三层只比种类、且要求种类完全相同，所以 §6.2 担心的「空队列认领第一条空消息」依旧被关住
  （图片不会认领文件），两类情形都有用例钉着。
- **只有图片做「已在本地」短路。** 文件对象按内容寻址，但它的可解析引用还多一层按名字的硬链接，
  名字是存储侧净化后的结果，只有存储自己知道——「对象在」不能证明「引用能解析」。所以重放一个
  文件引用仍要一次往返，`saveFile` 本身幂等，不会产生重复状态。R2 列出的每个场景都基于图片，均通过。
- **`#followStream` 也必须预取，这一处 §12 没有点名。** 实时流自己推进 `lastSeq`，被它跳过的事件
  不会被后续快照重放补上：远端 UI 里的一次 `read_image` 会永久留白。删掉这处预取，实时用例从
  1 次读取掉到 0 次，正是它证明 R1 不能不修这里。
- **顺带修掉一个 §12 之外的定时器泄漏。** `#schedule` 覆盖 `runtime.timer` 前没有清理旧定时器，
  一次「提示词 + 轮询」会留下 `dispose` 也清不掉的 60 秒尾巴；新的配对用例把它暴露成了进程存活问题。

## 12. 实现切片

| # | 内容 | 验证 |
|---|---|---|
| 0 | 本文档 | 文档自检 |
| 1 | 镜像：把 `#syncEventAttachments` 泛化到承载集合 + 按类型取内容 | `mirror-attachments.test.ts` |
| 2 | 镜像：`attachmentSignature`、`PendingUser` 新字段、匹配器、转发侧赋值 | `mirror-pairing.test.ts` |
| 3 | Testkit：图片与文件的 `attachment.read` | 既有测试套件转绿 |
| 4 | 文档：`docs/remote-workspace-mechanism.md` §5.2/§5.4 附件说明、CHANGELOG 的 Unreleased 条目 | 文档自检 |

切片 1 与 2 互相独立，可按任意顺序落地；两者都自包含在 `packages/local-plugin` 内。
每片以 `pnpm typecheck` 收尾；整体完成需要
`pnpm install && pnpm typecheck && pnpm test && pnpm build`。
