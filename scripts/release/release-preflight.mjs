/**
 * Everything that must be true before `pnpm release:publish` runs.
 *
 * Every check here exists because the corresponding mistake happened, and each
 * was caught late — in CI, or after npm had already accepted the publish, where
 * a version cannot be taken back:
 *
 * - `AGENT_VERSION` in `remote-agent/src/version.ts` disagreed with its manifest.
 *   `package-agent.mjs` refuses to stamp the bundle, so `pnpm build` failed after
 *   the version bump rather than shipping an agent that lies about itself.
 * - The CHANGELOG heading carried a date (`## 1.1.0 — 2026-11-21`).
 *   `scripts/release/release-notes.mjs` matches `^## <version>$`, so the Release workflow
 *   stopped at "Extract release notes" with build, typecheck and test green — a
 *   failure that cost a full tag round trip and one wasteful tag deletion.
 * - `publish-local.mjs` retried only the tarball download, not the metadata
 *   lookup, so a healthy publish was reported as broken within seconds.
 *
 * All three are cheap to check locally and expensive to discover remotely.
 *
 * @module scripts/release/release-preflight
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { npmInvocation } from '../lib/package-manager.mjs'
import { readManifest, repoRoot } from '../lib/paths.mjs'

/**
 * One check: a label, and a thunk that returns an error string or null.
 * @type {{ label: string, run: () => string | null }[]}
 */
const CHECKS = []

/**
 * Register a check.
 * @param {string} label - what is being verified.
 * @param {() => string | null} run - returns a message when the check fails.
 */
function check(label, run) {
  CHECKS.push({ label, run })
}

/** Read a text file, or '' when it is absent. */
function read(/** @type {string} */ path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const pluginDir = join(repoRoot, 'packages', 'local-plugin')
const agentDir = join(repoRoot, 'packages', 'remote-agent')

// `npm` on Windows is a `.cmd` shim that `execFileSync` cannot start directly, so
// this goes through the same resolver the publish script uses. Getting this wrong
// makes the registry check silently pass by never running.
const npm = npmInvocation()

const plugin = readManifest(pluginDir)
const agent = readManifest(agentDir)
const version = plugin.version

check('the plugin version is a plain release version', () => {
  if (/^\d+\.\d+\.\d+$/u.test(version)) return null
  return `version "${version}" is not X.Y.Z; a prerelease would publish under a non-latest tag`
})

check('the agent version matches the plugin version', () => {
  if (agent.version === version) return null
  return `agent is ${agent.version}, plugin is ${version}; a release moves them together`
})

check('AGENT_VERSION matches the agent manifest', () => {
  const source = read(join(agentDir, 'src', 'version.ts'))
  const found = /AGENT_VERSION = '([^']+)'/u.exec(source)
  if (found === null) return 'could not find `AGENT_VERSION` in remote-agent/src/version.ts'
  if (found[1] === agent.version) return null
  return `AGENT_VERSION is ${found[1]} but the manifest is ${agent.version}; \`pnpm build\` will refuse to pack the agent`
})

check('the CHANGELOG has a section for this version', () => {
  const lines = read(join(repoRoot, 'CHANGELOG.md')).split(/\r?\n/u)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // The same pattern `release-notes.mjs` uses; the two must agree or a green
  // preflight still fails the Release workflow.
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?\\s*$`, 'u')
  if (lines.some(line => heading.test(line))) return null
  return `no "^## ${version}$" heading; a dated heading like "## ${version} — 2026-01-01" does not match, and the Release workflow will fail`
})

check('the CHANGELOG section is not empty', () => {
  const lines = read(join(repoRoot, 'CHANGELOG.md')).split(/\r?\n/u)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?\\s*$`, 'u')
  const start = lines.findIndex(line => heading.test(line))
  if (start < 0) return 'no section to inspect' // reported by the previous check
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line?.startsWith('## ')) break
    if (line !== undefined && line.trim() !== '') return null
  }
  return `"## ${version}" is empty; the release body would be blank`
})

check('the release notes render', () => {
  try {
    const out = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'release', 'release-notes.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.trim() === '') return 'release-notes.mjs produced no output'
    return null
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr).trim()
      : String(error)
    return `release-notes.mjs failed: ${stderr || 'unknown error'}`
  }
})

check('the READMEs quote this version', () => {
  const files = ['README.md', 'README.zh.md', join('packages', 'local-plugin', 'README.md')]
  const missing = []
  for (const file of files) {
    const text = read(join(repoRoot, file))
    if (!text.includes(version)) missing.push(file)
  }
  if (missing.length === 0) return null
  return `these do not mention ${version}: ${missing.join(', ')}`
})

check('the build output exists', () => {
  const missing = [
    join(pluginDir, 'lib', 'index.js'),
    join(pluginDir, 'assets'),
  ].filter(path => !existsSync(path))
  if (missing.length === 0) return null
  return `missing ${missing.join(', ')}; run \`pnpm build\` first`
})

check('the working tree is clean', () => {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (status.trim() === '') return null
  return `uncommitted changes; a publish from a dirty tree cannot be reproduced from the tag:\n${status.trim()}`
})

check('the tag is not already used', () => {
  const tag = `v${version}`
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return `tag ${tag} already exists; either it is a re-run of a failed release, or the version was not bumped`
  } catch {
    return null
  }
})

check('the registry does not already have this version', () => {
  const specs = [`${plugin.name}@${version}`, `${agent.name}@${agent.version}`]
  const taken = []
  for (const spec of specs) {
    try {
      execFileSync(npm.command, [...npm.prefixArgs, 'view', spec, 'version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      taken.push(spec)
    } catch {
      // Not found. That is what we want.
    }
  }
  if (taken.length === 0) return null
  return `already published: ${taken.join(', ')}. A version cannot be republished — bump it.`
})

if (process.argv[1]?.endsWith('release-preflight.mjs') === true) {
  let failures = 0
  for (const { label, run } of CHECKS) {
    const problem = run()
    if (problem === null) {
      process.stdout.write(`ok    ${label}\n`)
    } else {
      failures += 1
      process.stdout.write(`FAIL  ${label}\n        ${problem.replaceAll('\n', '\n        ')}\n`)
    }
  }
  process.stdout.write(
    failures === 0
      ? `\npreflight passed for ${version}; safe to run \`pnpm release:publish\`\n`
      : `\n${failures} check(s) failed; fix them before publishing\n`,
  )
  if (failures > 0) process.exitCode = 1
}

export { CHECKS }
