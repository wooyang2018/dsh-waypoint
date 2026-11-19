# 代码评审记录（2026-11）

分支：`review/*`　基线：`1499dd1`　评审方式：6 个 worktree、6 个子 agent 并行只读评审，发现合并后经人工复核。

## 索引

| 文档 | 范围 | 发现数 | 已修 | 未修 |
|---|---|---|---|---|
| [security.md](security.md) | 凭据、SSH、终端、审批、持久化 | 14 | 0 | 14 |
| [mirror.md](mirror.md) | 镜像状态机、事件流、文件与终端路由 | 19 | 0 | 19 |
| [protocol.md](protocol.md) | 线协议、错误码、路由、导出契约 | 16 | 14 | 2 |
| [tooling.md](tooling.md) | 安装器、构建脚本、CI、跨平台 | 23 | 6 | 17 |
| [ui-docs.md](ui-docs.md) | 客户端 UI、宿主 API、文档 | 27 | 12 | 15 |
| [privacy.md](privacy.md) | 已提交的真实账号与地址 | 1 | 1 | 0 |
| **合计** | | **100** | **33** | **67** |

> 「已修」= 已在你批准的分支上提交并验证；「未修」= 你本轮跳过了代码修复，原样保留。

## 优先级总览（未修部分）

### Blocker / 高危（建议优先处理）

| ID | 位置 | 问题 |
|---|---|---|
| [SEC-02](security.md#sec-02) | `installer/src/commands.ts:241` + `ssh.ts:204` | `--verbose` 会把远端 `agent.json`（含 bearer token）打到 stderr。该 token 等于远端 shell + 文件读取全权限 |
| [TOL-01](tooling.md#tol-01) | `local-plugin/src/remote/provisioner.ts:133` | `isPermanentInstallFailure` 被 `LocalError` 包裹后失效，「永久失败不重试」整体没生效 |
| [MIR-02](mirror.md#mir-02) | `mirror/service.ts:2268` | 单个 gap 让镜像**永久重试同一份快照**，每 500ms 打一条 warn |
| [MIR-03](mirror.md#mir-03) | `mirror/service.ts:2351` | 单个拒收事件让 `lastSeq` 停住，其后所有健康事件永不生效 |
| [MIR-05](mirror.md#mir-05) | `mirror/service.ts:2233` | 「prompt 已接受但远端未写 turn/start」无收尾，UI 永久 running、新消息永久排队 |
| [MIR-06](mirror.md#mir-06) | `mirror/service.ts:2777` | `modelOptions` 读 `data.config`，真实形状是 `data.header.config`，永远回落到默认模型 |
| [MIR-01](mirror.md#mir-01) | `mirror/service.ts:1040` | `cancel()` 不清理 `pendingUsers`，会静默吞掉远端真实用户消息 |
| [SEC-01](security.md#sec-01) | `installer/src/bootstrap.ts:7,227` | 注释称 "no secrets embedded"，direct 模式下真实 key 被内嵌进脚本 |

### 中危
- [SEC-04](security.md#sec-04) systemd unit 换行注入（配置项含换行可注入 `ExecStartPre`）
- [TOL-02](tooling.md#tol-02) systemd 失败回退 nohup 时 unit 仍 enabled → 两个 `dsh web` 抢同一 `$DSH_HOME`
- [TOL-03](tooling.md#tol-03) `remoteStart: none` 必然在 120 秒后报超时
- [TOL-04](tooling.md#tol-04) 发布门禁用 `pnpm -r` 跳过 `scripts/`
- [PRT-08](protocol.md#prt-08) GET 命中 9 类仅 POST 路由时**不返回任何响应**（文档已改为如实描述现状）
- [PRT-09](protocol.md#prt-09) SSE 消费者提前 break 时不 cancel 响应体 → socket 泄漏
- [UIX-13](ui-docs.md#uix-13) 工作区路径是跨主机共享 state，切主机后会建到错误主机的路径
- [UIX-10](ui-docs.md#uix-10) `host/files/bytes` 把二进制破坏成 `{0:..,1:..}` 数字键对象
- [UIX-04](ui-docs.md#uix-04) `host/files/*` 的 `as unknown as` 让 offset/limit 完全绕过参数校验

## 本轮验证情况

修复完成后已在本机实际跑通官方验证链（不再是之前受限环境下的替代方案）：

```
pnpm install --frozen-lockfile   exit 0   Already up to date
pnpm -r build                    exit 0   全部 6 包构建成功
pnpm typecheck                   exit 0   stale-lib 守卫 + scripts checkJs + 各包
pnpm test                        exit 0   257 + 67 + 17 + 10 + 19 + 10 + 5 + 10，fail 0
```

未覆盖：Playwright（`pnpm test:e2e`，需要真实 DSH Desktop + Chromium，本机未跑）。

## 附：环境问题的真实成因（此前被误判为「环境限制」）

评审初期把三件事当成不可绕过的环境限制，实际都是**会话的 Windows 文件沙箱**造成的，切到完全权限后全部消失：

| 现象 | 真实成因 | 修复 |
|---|---|---|
| `pnpm` 所有命令报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` | pnpm 必须在 `%LOCALAPPDATA%\pnpm-store-operation-locks\` 建锁文件，而沙箱给该目录的权限只有 `(RX)` 读执行 | 会话切到完全权限后，`pnpm --version` → `11.21.0`（正是项目固定版本） |
| `esbuild` 报 `spawn EPERM` | 沙箱禁止子进程通过 `stdio: 'pipe'`（命名管道）通信；esbuild 的 JS API 固定用 pipe。直接跑 `esbuild.exe` CLI 一直是通的 | 同上，JS API 现可用 |
| `node --test` 报 `spawn EPERM` | 默认模式为每个测试文件 fork 一个子进程（pipe stdio） | 同上；另可用 `--test-isolation=none` 完全避免子进程 |
