/**
 * The remote Node.js version rule, in one place.
 *
 * Three different strings used to encode the same requirement: the bootstrap
 * script's inline `node -e` check, `doctor`'s copy of it, and the localized
 * message in the plugin. Two of those could drift without any test noticing,
 * and an operator would then be told one version while the install enforced
 * another.
 *
 * @module @dsh-waypoint/installer/node-runtime
 */

/** Minimum remote Node.js the bootstrap and the plugin both accept. */
export const MINIMUM_NODE_VERSION = '22.19.0'

/** Parsed form of {@link MINIMUM_NODE_VERSION}. */
export interface NodeVersionFloor {
  readonly major: number
  readonly minor: number
}

/** Split {@link MINIMUM_NODE_VERSION} without trusting a hand-copied literal. */
export function minimumNodeFloor(): NodeVersionFloor {
  const [major, minor] = MINIMUM_NODE_VERSION.split('.').map(Number)
  // The constant is a compile-time literal; a malformed one is a programming
  // error, not an operator-facing failure, so fail loudly and early.
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error(`MINIMUM_NODE_VERSION is not a major.minor.patch version: ${MINIMUM_NODE_VERSION}`)
  }
  return { major: major!, minor: minor! }
}

/**
 * Whether a reported Node.js version satisfies the minimum.
 *
 * Accepts the forms a runtime actually prints: `v22.19.0`, `22.19.0`, and a
 * prerelease such as `22.19.0-rc.1` (npm and Node both publish those). Anything
 * unparseable is *not* satisfied: guessing in favour of a version string this
 * code does not understand is how an unusable runtime gets adopted.
 */
export function nodeVersionSatisfied(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false
  const floor = minimumNodeFloor()
  return major > floor.major || (major === floor.major && minor >= floor.minor)
}

/**
 * Shell fragment that exits 0 when the running Node.js satisfies the minimum.
 *
 * Both the bootstrap script and `doctor` embed this, so the check they enforce
 * and the check the plugin describes cannot disagree. It reads
 * `process.versions.node` rather than parsing `node --version` so a version
 * manager's wrapper output cannot confuse it.
 */
export function minimumNodeCheckScript(): string {
  const { major, minor } = minimumNodeFloor()
  return `node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>${major}||(a===${major}&&b>=${minor})?0:1)'`
}
