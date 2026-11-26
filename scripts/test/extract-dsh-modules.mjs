/**
 * Materialise the DSH runtime packages an out-of-tree acceptance test imports.
 *
 * `packages/local-plugin/test-e2e/command-attachments.e2e.ts` composes the
 * *shipped* `CommandRuntime`, `FileUploads` and `LocalAttachmentStore` instead of
 * stand-ins, so it has to import them from an installed DSH release rather than
 * from this workspace — they are runtime peers of the plugin, not dev
 * dependencies, and the workspace does not carry them.
 *
 * That is easy everywhere except Windows, where those packages live inside the
 * desktop app's `app.asar`: `existsSync` and `node`'s own resolver treat them as
 * absent, so a plain `import` fails with `ERR_MODULE_NOT_FOUND` even though the
 * files are there. Electron reads asar transparently, so this script re-executes
 * itself under the app binary with `ELECTRON_RUN_AS_NODE=1` and copies the
 * closure out to a real directory.
 *
 * Three details were each a real failure while this was done by hand:
 *
 * - The closure must follow `dependencies`, `peerDependencies` **and**
 *   `optionalDependencies`. `dsh-error` is a *peer* of `dsh-attachment`; following
 *   only `dependencies` produced a tree that resolved until the first service
 *   constructed and then died with `ERR_MODULE_NOT_FOUND`.
 * - A package is expanded once, tracked in its own set. Deduplicating on "is it
 *   already on disk" instead made the walk advance exactly one level per run, so
 *   the closure only closed after being invoked four times.
 * - The result must be a real `node_modules` layout. Node resolves
 *   `<dir>/node_modules/@scope/pkg`, so copying to `<dir>/@scope/pkg` leaves every
 *   import unresolved.
 *
 * Usage:
 *   node scripts/test/extract-dsh-modules.mjs [--out <dir>]
 *
 * `DSH_MODULES_ROOT` may name a `node_modules` directory directly, which is how a
 * non-packaged install is pointed at; otherwise the desktop app's `app.asar` is
 * assumed under `DSH_APP_ROOT` (default `D:\deepseek-harness`).
 */
import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { repoRoot } from '../lib/paths.mjs'

/**
 * Packages the acceptance test imports directly.
 *
 * `cordis` is here because the test builds a real `Context`: the shipped
 * services register themselves through `Service`, so a hand-rolled object is not
 * a substitute.
 */
const ROOTS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-commands',
]

/**
 * Packages that exist per platform, so their absence outside their platform is
 * expected rather than an error.
 *
 * `sharp` ships one `@img/sharp-<platform>` per target and only installs the
 * matching one; the `node-addon-require-builtin-*` family is the same shape.
 * Failing on those would make the extraction succeed only on the machine that
 * built the release.
 */
const PLATFORM_OPTIONAL = /^(@img\/|node-addon-require-builtin-)/u

/** Directory name under `test-results/`; `test-results/` itself is git-ignored. */
const DEFAULT_OUT = join(repoRoot, 'test-results', 'e2e', 'node_modules')

/**
 * Write one progress line to stderr, so stdout stays a machine-readable result.
 *
 * @param {string} message Line to report.
 */
function progress(message) {
  process.stderr.write(`extract-dsh-modules: ${message}\n`)
}

/**
 * Whether a directory can actually be listed by this runtime.
 *
 * This is the asar detector: the path exists on disk as a packed file, so
 * `existsSync` is the wrong question and `readdirSync` is the right one.
 *
 * @param {string} dir Candidate directory.
 * @returns true when this process can read it.
 */
function readable(dir) {
  try {
    readdirSync(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Candidate `node_modules` directories holding the DSH packages, best first.
 *
 * @returns {string[]} Candidates to probe.
 */
function candidateRoots() {
  const candidates = []
  const configured = process.env.DSH_MODULES_ROOT
  if (configured !== undefined && configured !== '') candidates.push(resolve(configured))
  if (process.platform === 'win32') {
    const appRoot = process.env.DSH_APP_ROOT ?? 'D:\\deepseek-harness'
    candidates.push(join(appRoot, 'resources', 'app.asar', 'dsh', 'node_modules'))
    candidates.push(join(appRoot, 'resources', 'app', 'dsh', 'node_modules'))
  }
  return candidates
}

/**
 * Resolve how to re-execute this script where asar is readable.
 *
 * Mirrors `test-sandbox.mjs`: the packaged Windows CLI is an Electron binary that
 * behaves as Node when `ELECTRON_RUN_AS_NODE` is set. Spawning it through a shell
 * would split `DeepSeek Harness.exe` at its space, so the pair is spawned
 * directly.
 *
 * @returns {{ command: string, prefixArgs: string[], extraEnv: Record<string, string> } | undefined}
 *   The invocation, or nothing when no Electron binary is available.
 */
function electronRuntime() {
  const configured = process.env.DSH_BIN
  if (configured !== undefined && configured !== '' && existsSync(configured)) {
    return { command: configured, prefixArgs: [], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (process.platform === 'win32') {
    const appRoot = process.env.DSH_APP_ROOT ?? 'D:\\deepseek-harness'
    const exe = join(appRoot, 'DeepSeek Harness.exe')
    if (existsSync(exe)) {
      return { command: exe, prefixArgs: [], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }
  return undefined
}

/**
 * Read one package manifest from inside the modules root.
 *
 * @param {string} root Modules root.
 * @param {string} name Package name.
 * @returns {Record<string, any> | undefined} Parsed manifest, or nothing when the package is absent.
 */
function manifestOf(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Copy one package directory, never descending into nested `node_modules`.
 *
 * A nested `node_modules` is how the publisher's own dependency tree leaked in;
 * copying it would bloat the output and resurrect the duplicate-instance problem
 * this layout exists to avoid.
 *
 * @param {string} from Source directory.
 * @param {string} to Destination directory.
 * @returns {number} Files copied.
 */
function copyTree(from, to) {
  let copied = 0
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      copied += copyTree(source, target)
      continue
    }
    // A symlink into a pnpm store would not survive the copy on Windows, and the
    // release is packed flat, so only regular files are expected here.
    if (!entry.isFile()) continue
    try {
      copyFileSync(source, target)
      copied += 1
    } catch {
      // A file the runtime refuses to read is not fatal on its own; the imported
      // package will fail loudly if it actually needed it.
    }
  }
  return copied
}

/**
 * Copy the transitive package closure into a real `node_modules` layout.
 *
 * @param {string} root Modules root the packages are read from.
 * @param {string} out Destination `node_modules` directory.
 * @returns {{ packages: number, files: number, skipped: string[] }} Counts and the platform-optional names skipped.
 */
function extract(root, out) {
  /** @type {string[]} */
  const queue = [...ROOTS]
  const expanded = new Set()
  /** @type {string[]} */
  const skipped = []
  let files = 0
  let guard = 0
  while (queue.length > 0) {
    // The closure is finite, but a malformed manifest could name itself; a hard
    // bound turns that into a clear failure instead of a hang.
    if ((guard += 1) > 5000) throw new Error('the dependency closure did not converge')
    const name = queue.pop()
    if (name === undefined || expanded.has(name)) continue
    expanded.add(name)
    const manifest = manifestOf(root, name)
    if (manifest === undefined) {
      if (PLATFORM_OPTIONAL.test(name)) {
        skipped.push(name)
        continue
      }
      throw new Error(`package ${name} is named by the closure but absent from ${root}`)
    }
    files += copyTree(join(root, name), join(out, name))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const declared = manifest[field]
      if (typeof declared !== 'object' || declared === null) continue
      for (const dependency of Object.keys(declared)) {
        if (!expanded.has(dependency)) queue.push(dependency)
      }
    }
  }
  return { packages: expanded.size - skipped.length, files, skipped }
}

/** Destination `node_modules`, from `--out` or the default. */
const outIndex = process.argv.indexOf('--out')
const requestedOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
const out = typeof requestedOut === 'string' && requestedOut !== ''
  ? resolve(requestedOut)
  : DEFAULT_OUT

const roots = candidateRoots()
/** @type {string | undefined} */
let root
for (const candidate of roots) {
  if (readable(candidate)) { root = candidate; break }
}

if (root === undefined) {
  const available = electronRuntime()
  if (available === undefined) {
    throw new Error(
      'cannot read the DSH packages: none of these directories is readable by node '
      + `(${roots.join(', ')}). Set DSH_MODULES_ROOT to a node_modules directory that holds `
      + '@deepseek-ai/dsh-commands.',
    )
  }
  // Re-run under Electron, which reads asar transparently. Only the child writes
  // output, so the parent prints nothing but the final summary.
  progress('the DSH packages are packed in app.asar; re-running under the desktop binary')
  const child = spawnSync(
    available.command,
    [...available.prefixArgs, ...process.execArgv, process.argv[1] ?? '', '--out', out],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...available.extraEnv, DSH_EXTRACT_CHILD: '1' },
    },
  )
  if (child.status !== 0) {
    throw new Error(`the asar extraction failed (exit ${String(child.status)})`)
  }
  if (!existsSync(join(out, '@deepseek-ai', 'dsh-commands', 'package.json'))) {
    throw new Error(`the extraction reported success but ${join(out, '@deepseek-ai', 'dsh-commands')} is empty`)
  }
  process.exit(0)
}

progress(`reading ${root}`)
mkdirSync(out, { recursive: true })
const result = extract(root, out)
progress(`copied ${String(result.files)} files from ${String(result.packages)} packages into ${dirname(out)}`)
if (result.skipped.length > 0) {
  progress(`skipped ${String(result.skipped.length)} package(s) that belong to another platform`)
}
// The acceptance test reads stdout's last line, so nothing but the path goes here.
process.stdout.write(`${out}\n`)
