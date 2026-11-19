# 安装器、构建脚本与 CI 评审

范围：`packages/installer/src/*`、`local-plugin/src/remote/{provisioner,restart,node-state}.ts`、`scripts/*`、`.github/workflows/*`、`examples/*`、`docs/testing.md`

分支：`review/tooling`（5 个提交）　严重度分布：Major 4 / Minor 15 / Note 4

**分支状态**　`.gitattributes`、`SECURITY.md`、`docs/testing.md`、`examples/local-plugin.patch.yml`、`packages/installer/src/{errors,options}.ts`　+22 −9

---

<a id="tol-01"></a>
## TOL-01　Major　「永久失败不重试」整体失效　未修

**位置**　`packages/local-plugin/src/remote/provisioner.ts:133-141`（配合 `:304-308`、`service.ts:976`）

**现象**　`ensureInstalled` 把每个 bootstrap 失败包装成 `new LocalError('agent/unavailable', …)`，安装器码只落进 `details.installerCode`；而 `isPermanentInstallFailure` 只认 `error instanceof NodeProvisionError` 或 `installerCodeOf(error)`——后者读 `candidate.installerCode`，**`details` 一概不看**。

**证据**　实测：`installerErrorForExit(21)` → `isPermanentInstallFailure` = true；包一层后 → `wrapper permanent? false`、`wrapper.installerCode = undefined`、`wrapper.details = {"installerCode":"install/node-missing"}`。

**影响**　`exit 21/22/23/26` 全被当瞬时故障：`#installBlocked` 永不填充（`service.ts:945-954`、`1356` 形同虚设），每次自动重连都重跑整段 bootstrap（重装 pnpm + dsh），直到 `provisionRetryLimit` 耗尽。`docs/operations.md:88-92` 的承诺（"recorded as blocked… the retry line disappears"）不成立。

单测 `provisioner.test.ts:114-129` 之所以绿，是因为它只测裸 `InstallerError`，从不经过 provisioner 的包装——**测试层次错了，掩盖了缺陷**。

**修复建议**

```ts
export function isPermanentInstallFailure(error: unknown): boolean {
  if (error instanceof NodeProvisionError) return true
  let current: unknown = error
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const code = installerCodeOf(current)
    if (code !== undefined) return PERMANENT_INSTALL_CODES.has(code)
    const nested = (current as { details?: { installerCode?: unknown } }).details?.installerCode
    if (typeof nested === 'string' && PERMANENT_INSTALL_CODES.has(nested as InstallerErrorCode)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
```
并在 `provisioner.test.ts` 补一条「经 `LocalError` 包装后仍判定为永久」的回归用例。

**状态**　未修

---

<a id="tol-02"></a>
## TOL-02　Major　systemd 回退 nohup 时 unit 仍 enabled → 两个 dsh web

**位置**　`packages/installer/src/bootstrap.ts:496-507`

**现象**　`if systemctl --user enable … && systemctl --user restart …; then … else 回退 nohup`。`enable` 成功、`restart` 失败时走 else，unit 仍 enabled（下次登录被拉起），同时 nohup 也起一个实例。

**影响**　正是 `doctor` 在 `:185-192` 警告的情形（`dsh_web_processes` > 1，两进程互相覆盖 `agent.json`），而 `README.md:350`/`operations.md:350` 把这种现象归因于「用户自己跑了两份」。

**修复建议**　回退前先撤销 unit：`systemctl --user disable --now dsh-waypoint-agent.service >/dev/null 2>&1 || true`。

**状态**　未修

---

<a id="tol-03"></a>
## TOL-03　Major　`remoteStart: none` 必然 120 秒后超时

**位置**　`packages/local-plugin/src/remote/provisioner.ts:143-151`；`packages/installer/src/bootstrap.ts:243,470-476`

**现象**　bootstrap 对 `none` 设 `WAIT_FOR_STATE=0`（实测渲染确认），只打印「自己启动」；但 `ensureInstalled` 无条件调用 `#waitForAgent`，后者 120s 后抛 `retryable: true` → `#scheduleReconnect` 再跑一遍全量 bootstrap。脚本尾部对 `none` 还会打印 "state file is not ready" 的 warning，与「你故意没启动」矛盾。

**影响**　`remoteStart: none` 是文档化配置（`README.md:289`、`README.zh.md:220`、`operations.md:217` 都列出），选它的用户每次重连都白跑一遍 pnpm+dsh 安装。

**修复建议**　`ensureInstalled` 里 `if (start !== 'none') await this.#waitForAgent(...)`，否则直接 `onProgress('installed')` 返回；bootstrap 侧 else 分支区分 `WAIT_FOR_STATE`。

**状态**　未修

---

<a id="tol-04"></a>
## TOL-04　Major　发布门禁弱于 CI　未修（本应修但不在批准范围）

**位置**　`.github/workflows/release.yml:31-33`

**现象**　`pnpm -r typecheck` / `pnpm -r test` 跳过根包，`scripts/` 的 `checkJs` 与 `scripts/*.test.mjs` 完全不在发布路径上。

**证据**　根 `package.json:12-16`：`pretypecheck` 与 `test` 都是根形式；`pnpm -r` 不跑根（`AGENTS.md`「Scripts」节明确写了）。`ci.yml:58-66` 用的正是根形式。

**影响**　一个能让 `scripts/` 类型错误或 `dev-version.test.mjs` 失败的提交可以通过 Release 工作流并产出 tag 产物；CI 事后才在 main 上报警。

**修复建议**　改成根命令（安全：第 31 行 `pnpm -r build` 紧邻其前，`check-workspace-libs` 的前提已满足；根命令是 `-r` 的超集）：

```yaml
      - run: pnpm -r build
      - run: pnpm typecheck
      - run: pnpm test
```

**状态**　未修——**这条我建议优先修，成本一行，收益是发布路径与 CI 对齐。**

---

<a id="tol-05"></a>
## TOL-05　Minor　CI 契约写反　✅ 已修

**位置**　`docs/testing.md:63`

**现象**　称 CI 第 5 步是 `pnpm -r typecheck`/`pnpm -r test`，实际 `ci.yml:58-66` 是 `pnpm -r build` + **根** `pnpm typecheck`/`pnpm test`。

**修复**　改为根形式并说明原因（`-r` 跳过根包，`scripts/` 的 `checkJs` 与自测都在根；`pretypecheck` 还跑 `check-workspace-libs.mjs`）。

---

## TOL-06　Minor　示例 `stateDir` 语义错误　✅ 已修

**位置**　`examples/local-plugin.patch.yml:9`

**现象**　`stateDir: ~/.dsh/remote`，且比「改名遗留」更糟：`~` 在本地插件里展开成 **DSH_HOME**，不是 OS home。

**证据**　实测 `resolveLocalPath('~/.dsh/remote','/opt/dshhome')` → `/opt/dshhome/.dsh/remote`，而默认值是 `$DSH_HOME/waypoint`。

**影响**　复制示例的用户会得到一层多余的 `.dsh` 目录，且与默认位置、`test-visibility.json`（读 `<stateDir>/test-visibility.json`）都不一致。

**修复**　改为 `stateDir: ''` 并注释说明空值含义与 `~` 的展开目标。

---

## TOL-07　Minor　`SECURITY.md` 支持版本写 0.8.x　✅ 已修

**位置**　`SECURITY.md:5`　→ 改为 `1.0.x`。顺手核查该文件其余版本串，只留 DSH `0.2.2-rc.3` 与 Node `22.19+`，均正确。

---

## TOL-08　Minor　`.gitattributes` 理由失真　✅ 已修（只改注释）

**位置**　`.gitattributes:1-6`

**现象**　注释解释「`pnpm build` 会重写**被跟踪的** `packages/terminal-controller/lib/`」，但实测 `git ls-files` 里 `lib/` 文件数为 0；`ensure-built.ts:5-7` 也明确说 `lib/` 完全被忽略。

**影响**　理由错误会诱使后来者「既然没 tracked lib 了就删规则」，从而引入真问题：`git check-attr` 显示 `scripts/*.sh` 当前 `eol: lf`，去掉后 `core.autocrlf=true` 的检出会写 CRLF，`#!/usr/bin/env bash\r` 直接 bad interpreter。

**修复**　只换注释为真实理由，8 条规则一行未动（`git diff -U0` 验证 `^[+-]\*` 无输出）。

---

## TOL-09　Minor（代码部分未修）　远端 PTY 硬依赖 `python3`，文档未提　⚠️ 部分已修

**位置**　`packages/remote-agent/src/terminal.ts:155`；README 远端要求段

**现象**　`spawn('python3', …)`；全仓 `grep python` 只命中该文件。

**证据**　`ENOENT` 通过异步 `'error'` 事件触发（非同步抛出），`:198` 的 `child.on('error')` 把状态置 failed，message 形如 `spawn python3 ENOENT`。即：**安装成功、会话可用，唯独「New terminal」永远打不开**。

**影响**　远端 Node.js 达标但无 `python3`（Debian/Ubuntu 最小镜像、部分容器）时，`doctor` 也不报这项，用户无从自查。

**已修部分**　`README.md`、`README.zh.md`、`packages/local-plugin/README.md` 已写明该依赖与失败表现（由 ui-docs 分支完成）。

**未修部分**　`commandDoctor` 里加一行 `python3=$(command -v python3 …)` 探测——属代码，本轮未动。

---

## TOL-10～TOL-19　Minor　未修

| ID | 位置 | 问题 |
|---|---|---|
| TOL-10 | `bootstrap.ts:209-214`、`errors.ts:58-62` | `exit 24` 被两种无关失败复用（`npm prefix -g` 读不到 / dsh 装完不可用），把用户导向错误的排障方向 |
| TOL-11 | `installer/src/ssh.ts:128-135,138-148` | scp 缺 `BatchMode=yes`（可能挂到 120s 超时）；`scpBinary` 从不经 `resolveCommand`（脚本型 scp 在 Windows 必失败） |
| TOL-12 | `commands.ts:189-192` | `pgrep -fc` 在 Linux 无匹配时先输出 `0` 再以 1 退出，`\|\| echo 0` 追加第二个 `0`；macOS 的 `pgrep` 无 `-c`，该字段恒为 0 |
| TOL-13 | `scripts/publish-local.mjs:59-61` | `--dry-run` 仍强制要求 `NPM_TOKEN`（`publishToken()` 在 `dryRun` 分支之前执行），与 RELEASING.md 不符 |
| TOL-14 | `ci.yml:19,42-57`、`pnpm-workspace.yaml`、`select_dsh_version.mjs:40-42` | `DSH_TARGET` 与 `minimumReleaseAgeExclude` 双向失配（各 4/3 项不对称），且无守卫；新版本不在 exclude 内会命中 1440 分钟冷却并**静默退回旧版本** |
| TOL-15 | `scripts/dev-version.test.mjs:14` | 护栏测的是测试文件里的**副本**正则，不是 `release-plugin.mjs:43` 真正在用的那个；改一处，测试仍绿 |
| TOL-16 | `scripts/dev-version.mjs:22-24` | `Math.random().toString(36).slice(2,6)` 可能不足 4 字符，`[a-z0-9]{4}` 断言有约 1/46656 偶发失败率 |
| TOL-17 | `installer/src/npm.ts:33-35` | `npmInvocation` 兜底 `{ command: 'npm' }` 在 Windows 不可 spawn；测试只验证「不回退到 .cmd」，没验证「回退后能跑」 |
| TOL-18 | `local-plugin/src/ssh/command.ts:34,42-46` | `needsNode()` 不含 `.ps1`（同 SEC-06，两处独立发现，**同一缺陷**） |
| TOL-19 | `scripts/install-local.sh:18,22,40-55`、`test-sandbox.sh:17-18`、`README.md:47` | 两脚本硬编码 macOS 路径，Windows 原生不可用、WSL 下报错文案误导；而 README 把一键安装标为 Available 无平台限定 |

---

## TOL-20　Note　Node 下限字面量重复　✅ 已修（唯一 src 改动）

**位置**　`packages/installer/src/{errors,options}.ts`

**现象**　`22.19.0` / `22.19+` 在两处以字面量重复，真源是 `node-runtime.ts` 的 `MINIMUM_NODE_VERSION`。

**修复**　HELP 文本改 `${MINIMUM_NODE_VERSION}+` 插值；exit-22 的 message 去掉版本号只留语义（UI 经 `installerUi` 注入版本）。无逻辑分支改动。

**运行时验证**　
```
HELP line:            The remote host needs Node.js 22.19.0+ and npm, …
exit 22 message:      the remote Node.js is older than the minimum this installer supports
installerUi(exit22):  {"key":"error.agentInstallNodeOutdated","params":{"required":"22.19.0"}}
```
即卡片文案的 `{required}` 由 `installerUi` 注入，版本语义没丢。

**未修**　`node-runtime.ts:36-37`（注释里作为可接受输入格式举例）、`node-remote.ts:36`（`@example` JSDoc）——这三处是示例不是重复事实源，判断为不该修。agent 曾越界尝试改 `node-remote.ts`，主动 `git checkout --` 回滚了。

---

## TOL-21～TOL-23　Note　未修

| ID | 位置 | 问题 |
|---|---|---|
| TOL-21 | `commands.ts:114`、`provision.ts:67` | 每次安装都在远端 `/tmp` 留约 200KB tarball，从不清理 |
| TOL-22 | `scripts/release-plugin.mjs:90-93` | 「stdout 只写 tarball 路径」这条 load-bearing 契约无自动化守卫；`install-local.sh:63` 与 `test-sandbox.sh:30` 用 `TARBALL="$(…)"`，多一行就坏 |
| TOL-23 | `bootstrap.ts:345-357` | 升级路径先停服务、删状态文件，再装新 dsh；中途失败把远端留在「有安装无服务」状态 |

---

## 已复核且未发现问题

1. **退出码闭合**：`BOOTSTRAP_EXIT_CODES` = {21,22,23,24,25,26}，脚本实际 `exit` 集合同为这 6 个；`errors.test.ts` 双向断言，7 用例全绿
2. **`isPermanentInstallFailure` 的集合语义**：24/25 划为瞬时时与注释一致（唯一问题是 TOL-01 的传递路径）
3. **`doctor` 字段与文档一致性**：README/operations 提到的 9 个字段在 `commandDoctor` 中全部存在，无缺漏无多余承诺
4. **`npm prefix -g` 不可写时「响亮失败」**：不存在第二个候选位置；`global-prefix.test.ts` 用真 shell 覆盖四种情形
5. **`npm.ts` 与 `package-manager.mjs` 的 Windows 解析一致性**：两者逐行等价；重复是刻意为之（TS 无法被 `.mjs` 直接 import），两侧各有测试
6. **nvm 的 `PROFILE=/dev/null`**：核实 nvm `install.sh` 的 `nvm_detect_profile()` 首行即 `if [ "${PROFILE-}" = '/dev/null' ]; then return; fi`，确实不触碰启动文件；脚本也不写 `alias default`
7. **`release-plugin.mjs` 的 stdout 契约实现**：唯一 stdout 写入是 tarball 路径，进度走 stderr（护栏缺失见 TOL-22）
8. **`publish-local.mjs` 的发布顺序与 tarball 校验**：terminal → agent → plugin 顺序正确；`--otp` 有校验；下载验证 40×15s 与实测 6 分钟吻合
9. **`select_dsh_version.mjs` 的成员漂移**：脚本在增删时向 stderr 打印明细，没有静默重排（与 exclude 的失配见 TOL-14）
10. **`remoteGlobalPrefix` 与 nvm 切换的交互**：unit 的 `ExecStart` 与 `PATH` 在安装时展开成字面路径，README 的「切版本后需 Reinstall」描述准确
11. **`nodePathPrelude` 的 nvm 新版本优先逻辑**：`sort -V` 数值比较、`|| true` 兜底、`timeout` 缺失时的函数兜底都正确；`doctor` 复用同一 prelude

## 越界但值得记录

1. `remote-agent/src/terminal.ts:161-163` 的 try/catch 是无效防御：`spawn` 的 ENOENT 走异步 `'error'`，同步 catch 只能抓参数错误
2. `provisioner.test.ts` 的测试层次过低（全在纯函数层），正是 TOL-01 漏网的根因
3. `test/playwright/dsh-fixture.ts:246` 只配了 `sshBinary`；`resolveScpBinary('…/fake-ssh.mjs','')` 会推出不存在的 `…/scp`。当前靠伪造 state 文件绕开 provisioning 所以没暴露
4. `.gitattributes` 的 `*.ps1 text eol=crlf` 目前无对应文件，是给未来的规则；与 TOL-18 组合看，将来真提供 `.ps1` ssh 包装时要同时支持它
