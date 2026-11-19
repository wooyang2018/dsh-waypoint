import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NVM_VERSION, parseNodeProbe, renderNodeInstallScript, renderNodeProbeScript } from '../src/node.ts'
import { MINIMUM_NODE_VERSION, minimumNodeCheckScript, nodeVersionSatisfied } from '../src/node-runtime.ts'

describe('node version rule', () => {
  it('accepts the versions a runtime actually prints', () => {
    assert.equal(nodeVersionSatisfied('v22.19.0'), true)
    assert.equal(nodeVersionSatisfied('22.19.0'), true)
    assert.equal(nodeVersionSatisfied('22.19.0-rc.1'), true)
    assert.equal(nodeVersionSatisfied('22.20.1'), true)
    assert.equal(nodeVersionSatisfied('v23.0.0'), true)
  })

  it('rejects anything below the floor', () => {
    assert.equal(nodeVersionSatisfied('22.18.9'), false)
    assert.equal(nodeVersionSatisfied('v20.11.1'), false)
    assert.equal(nodeVersionSatisfied('18.20.0'), false)
  })

  it('refuses to guess at an unparseable version', () => {
    // Guessing in favour would adopt a runtime this code cannot reason about.
    assert.equal(nodeVersionSatisfied(''), false)
    assert.equal(nodeVersionSatisfied('latest'), false)
    assert.equal(nodeVersionSatisfied('nonsense'), false)
  })

  it('derives the shell check from the one constant', () => {
    const script = minimumNodeCheckScript()
    const [major, minor] = MINIMUM_NODE_VERSION.split('.')
    assert.match(script, new RegExp(`a>${major}`, 'u'))
    assert.match(script, new RegExp(`a===${major}&&b>=${minor}`, 'u'))
  })
})

describe('remote node probe', () => {
  const script = renderNodeProbeScript()

  it('reports every field the panel needs', () => {
    for (const key of [
      'node=',
      'node_version=',
      'node_satisfied=',
      'node_minimum=',
      'npm=',
      'login_shell=',
      'nvm_dir=',
      'nvm_installed=',
      'downloader=',
      'git=',
      'platform_supported=',
    ]) {
      assert.ok(script.includes(`echo "${key}`), `probe does not report ${key}`)
    }
  })

  it('never changes the remote', () => {
    // A probe runs on every panel open; a write here would be a side effect the
    // user never asked for.
    assert.doesNotMatch(script, /\bgit clone\b/u)
    assert.doesNotMatch(script, /nvm install/u)
    assert.doesNotMatch(script, /\bmkdir\b/u)
    assert.doesNotMatch(script, /\brm -/u)
  })

  it('resolves NVM_DIR the way nvm does, not by guessing a path', () => {
    // nvm writes $XDG_CONFIG_HOME/nvm when that is set and $HOME/.nvm otherwise.
    // Guessing $HOME/.config/nvm whenever XDG is unset would inspect a directory
    // nvm never uses, and then reinstall nvm on a host that already had it.
    assert.match(script, /XDG_CONFIG_HOME/u)
    assert.match(script, /NVM_DIR="\$HOME\/\.nvm"/u)
    assert.doesNotMatch(script, /\.config\/nvm/u)
  })

  it('does not abort on the first missing command', () => {
    // `set -e` here would stop at "no node" and report nothing else.
    assert.match(script, /^set -u$/mu)
    assert.doesNotMatch(script, /set -e/u)
  })
})

describe('remote node install', () => {
  const script = renderNodeInstallScript()

  it('installs nvm and the latest LTS', () => {
    assert.ok(script.includes(`DSH_WAYPOINT_NVM_VERSION='${NVM_VERSION}'`))
    assert.match(script, /nvm install --lts/u)
    assert.match(script, /nvm which 'lts\/\*'/u)
  })

  it('leaves the account default Node.js alone', () => {
    // Rewriting the default alias would change the runtime every future shell of
    // that account uses — a decision about the operator's environment, not about
    // DSH. Found by running this on a real host whose default was v26.
    // The check reads commands, not comments: the script explains this in one.
    const commands = script
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => !line.startsWith('#'))
    assert.equal(
      commands.some(line => /nvm alias default/u.test(line)),
      false,
      `the install still rewrites the default alias: ${commands.filter(line => line.includes('alias')).join(' | ')}`,
    )
    // Resolving "lts/*" directly is what lets DSH use the new runtime without
    // touching that alias.
    assert.match(script, /nvm which 'lts\/\*'/u)
  })

  it('never edits a shell startup file', () => {
    // Same contract the bootstrap keeps: nvm's own installer is told to skip
    // profile editing via PROFILE=/dev/null, and nothing else touches them.
    // The check targets a *path* to a startup file, not the substring: the
    // script legitimately reads `$HOME/.nvm/nvm.sh`, and `.nvm` is not `.profile`.
    assert.match(script, /PROFILE=\/dev\/null/u)
    assert.doesNotMatch(script, /(?:^|[\s"'(])(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|config\.fish)\b/mu)
    assert.doesNotMatch(script, />>\s*"?\$HOME\/\./u)
  })

  it('never deletes a directory that may hold installed Node versions', () => {
    // `rm -rf "$NVM_DIR"` would take versions/ with it, which is the difference
    // between repairing a host and wiping the runtime it was using. The check
    // reads command lines, not comments: the script explains the hazard in one.
    const commands = script
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => !line.startsWith('#'))
    assert.equal(
      commands.some(line => /^rm -rf "\$NVM_DIR"(\s|$)/u.test(line)),
      false,
      `a bare rm -rf "$NVM_DIR" survives: ${commands.filter(line => line.includes('NVM_DIR"')).join(' | ')}`,
    )
    assert.ok(commands.some(line => /rm -rf "\$NVM_DIR\.dsh-waypoint-tmp"/u.test(line)))
  })

  it('avoids set -e, which nvm documents as a known incompatibility', () => {
    assert.match(script, /^set -u$/mu)
    assert.doesNotMatch(script, /set -e/u)
  })

  it('checks failures explicitly instead of relying on errexit', () => {
    assert.match(script, /if ! git clone/u)
    assert.match(script, /nvm install --lts \|\|/u)
    assert.match(script, /exit 3/u)
    assert.match(script, /exit 4/u)
    assert.match(script, /exit 5/u)
    assert.match(script, /exit 6/u)
    assert.match(script, /exit 7/u)
  })

  it('refuses an unsupported platform before downloading anything', () => {
    // The PATH check comes first: `uname` lives on PATH, so a broken PATH would
    // otherwise look like an unsupported OS and point the operator at the wrong
    // problem. Verified against a real host with PATH=/nonexistent.
    const unameAt = script.indexOf('uname -s')
    const hasCommandAt = script.indexOf('has_command uname')
    assert.ok(hasCommandAt >= 0 && hasCommandAt < unameAt, 'the PATH check must precede the platform check')
    const platformCase = script.slice(0, script.indexOf('has_command git'))
    assert.match(platformCase, /uname -s/u)
    assert.match(platformCase, /exit 3/u)
    assert.doesNotMatch(platformCase, /git clone|install\.sh/u)
  })

  it('pins the nvm release instead of tracking a branch', () => {
    assert.doesNotMatch(script, /--branch\s+(master|HEAD)/u)
    assert.match(script, new RegExp(`--branch "v\\$DSH_WAYPOINT_NVM_VERSION"`, 'u'))
  })

  it('verifies the installed runtime against the shared minimum', () => {
    const [major, minor] = MINIMUM_NODE_VERSION.split('.')
    assert.ok(script.includes(`a>${major}||(a===${major}&&b>=${minor})`))
    assert.match(script, /dsh-waypoint: node ready/u)
  })
})

describe('probe parsing', () => {
  it('reads the reported values', () => {
    const status = parseNodeProbe([
      'node=/home/a/.nvm/versions/node/v22.19.0/bin/node',
      'node_version=v22.19.0',
      'node_satisfied=yes',
      'node_minimum=v22.19.0',
      'npm=yes',
      'login_shell=/bin/bash',
      'nvm_dir=/home/a/.nvm',
      'nvm_installed=yes',
      'nvm_node_version=v22.19.0',
      'downloader=curl',
      'git=yes',
      'platform_supported=yes',
      '',
    ].join('\n'))
    assert.equal(status.supported, true)
    assert.equal(status.version, 'v22.19.0')
    assert.equal(status.satisfied, true)
    assert.equal(status.hasNpm, true)
    assert.equal(status.nvmInstalled, true)
    assert.equal(status.downloader, 'curl')
    assert.equal(status.hasGit, true)
  })

  it('falls back safely when the host answered nothing', () => {
    const status = parseNodeProbe('')
    assert.equal(status.supported, false)
    assert.equal(status.satisfied, false)
    assert.equal(status.version, '')
    assert.equal(status.downloader, 'none')
  })
})
