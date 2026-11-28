# 设计文档（Specifications）

这里存放「已经定稿」的设计文档，无论是否已经落地。每份文档说明缺陷是什么、决策是什么、否决了哪些方案，以及实现者按顺序推进的切片清单。

已实现的文档不删除：它保留着「代码为什么长成这样」的记录，而这正是后来者真正会问的问题。

## 待实现（Open）

| 文档 | 修复什么 | 涉及包 |
|---|---|---|
| [`@` 文件引用](2026-11-27-remote-file-references.md) | `@` 菜单列出本地目录树，而不是远端工程 | protocol、remote-agent、local-plugin |
| [附件双向一致性](2026-11-27-mirror-attachment-parity.md) | 工具结果里的图片从不同步；纯附件消息会产生重复气泡 | local-plugin |
| [队列消息的编辑与删除](2026-11-27-mirror-queue-mutation.md) | 编辑或删除排队中的消息，永远到不了远端 | protocol、local-plugin |
| [会话重命名](2026-11-27-mirror-session-rename.md) | 重命名镜像会话只改了本地投影 | protocol、remote-agent、local-plugin |
| [镜像会话的命名空间策略](2026-11-27-mirrored-namespace-policy.md) | goal、jobs、teams、subagents、feedback 静默写入本地状态，远端毫不知情 | protocol、remote-agent、local-plugin |

## 已实现（Implemented）

| 文档 | 落地于 |
|---|---|
| [镜像会话的远端命令与技能目录](2026-11-26-remote-catalog-bridge.md) | 1.1.4 —— `/` 菜单、技能列表、命令执行改由持有状态的主机作答 |
| [远端目录类型与工作目录](2026-11-27-remote-directory-type.md) | 未发布 —— `file.stat` 带上类型，镜像会话的 cwd 在自己的主机上解析 |
