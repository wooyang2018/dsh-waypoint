/**
 * Stamp a development build with a unique prerelease version.
 *
 * A package manager keys an install on the dependency version together with the
 * tarball integrity. With a constant local version, a rebuilt tarball at the same
 * path leaves the profile's already-unpacked files untouched, so the plugin — or
 * the remote agent inside a remote profile — reports as installed while still
 * running the previous code. A distinct version per build makes the replacement
 * unconditional; `--release` keeps the manifest version for publishing.
 *
 * Both packers use this helper so their artifacts sort alike, and so
 * `release-plugin.mjs` can prune previous development builds with one pattern.
 * Keep `-dev-<stamp>-<random>` as the shape: the pruning regex and the
 * Playwright fixture both depend on it.
 */

/**
 * @param {string} base Committed version, such as `0.8.21`.
 * @returns {string} `base-dev-<YYYYMMDD-HHMMSS>-<4 chars>`, a valid semver prerelease.
 */
export function developmentVersion(base) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  const unique = Math.random().toString(36).slice(2, 6)
  return `${base}-dev-${stamp}-${unique}`
}
