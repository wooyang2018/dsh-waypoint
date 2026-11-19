# 隐私清理

分支：`review/privacy`（2 个提交）　严重度：Blocker　状态：**已修**

> **本文档刻意不记录原始值。** 清理对象本身是敏感数据，把它们复述进一份要提交的文档，
> 等于换一个文件重犯同一个错误。原始值可从 `git log -S` 与历史提交中取得，
> 只应在本机排查时查看，不要粘进 issue、PR 或聊天。

---

## 问题

仓库即将公开到 GitHub，但**真实账号名与三个真实主机地址**已被提交（引入于 `db3fc8d`）。这违反仓库自己的规则——`AGENTS.md`：

> Keep test hostnames, personal paths, tokens, and screenshots out of committed files.

## 命中范围

| 类别 | 出现位置 |
|---|---|
| 真实账号名（同时出现在主机名与别名中） | `src/ssh/alias-groups.ts`（模块注释）、`src/hosts/types.ts`（注释）、`src/service.ts`（注释）、`test/alias_groups.test.ts`、`test/discovery_panel.test.ts`、`test/ssh-config.test.ts`、`CHANGELOG.md` |
| 真实地址 A | 注释示例 + 测试 fixture |
| 真实地址 B | 测试 fixture |
| 真实地址 C（第二轮追加发现） | `discovery_panel.test.ts:67,227`、`host-discovery.test.ts:75,117`、`ssh-config.test.ts:56,61,176,182` |

地址 C 与地址 A **同网段**，且总与同一账号成对出现——这是 agent 在给定的 token 列表之外主动扫出来的，属于我最初划定范围时的遗漏。

## 处理方式（按你的决定：只清 HEAD）

| 类别 | 处理 |
|---|---|
| 真实账号名 | → `alice` |
| 含账号名的别名（`devcloud_64g_<user>` 等） | → `devcloud_64g_alice` 等，**保留「别名包含用户名」这一被测语义** |
| 真实地址 A / B / C | → RFC 5737 文档保留地址 `203.0.113.10` / `192.0.2.10` / `198.51.100.10`，**保持三个值互不相同**（分组测试靠此区分主机） |

未动：`user00`、`docker_*`、`10.1.1.1`、`1.1.1.1`、`2.2.2.2` 等通用占位值。

## 提交

```
a58bf2e docs: replace a real account name and two real IPs with neutral examples
a13407a test: replace a third real host address with a documentation IP
```

## 验证

```
git grep -n -E '<原账号名>|<原地址A>|<原地址B>|<原地址C>'   → CLEAN（工作树与 HEAD 树均为空）
tsc -p packages/local-plugin/tsconfig.json                  → exit 0
tsc -p packages/local-plugin/tsconfig.client.json           → exit 0
alias_groups.test.ts        pass=10 fail=0
ssh-config.test.ts          pass=20 fail=0
host-discovery.test.ts      pass=7  fail=0
remote-path.test.ts         pass=9  fail=0
```

（上表把原始值写成占位符，避免本文档再次引入它们；复核时按 `git show a58bf2e --stat` 与被改文件自行还原。）

## 遗留：历史中仍保留

按「只清 HEAD」的决定，**原始字符串完整保留在 git 历史中**（`1499dd1` 及之前共 7 个文件命中）。

要彻底清除需 `git filter-repo`（或 BFG）重写全部历史再强制推送，代价是：**265 个已公开提交的 SHA 全部改变**，所有克隆、PR、issue 引用与签名需同步处理，且需暂停 CI、通知协作者重新克隆。这与 `AGENTS.md`「不要改写历史/作者」冲突，因此按你的决定不做。

> 若日后判断这些地址敏感度较高，可只针对它们做一次定向重写；但那已不是一次普通提交，需要单独计划。
