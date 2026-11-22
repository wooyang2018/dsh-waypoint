/**
 * `npm pack` one prepared directory into a tarball, and prove it appeared.
 *
 * Both packers (`release-plugin.mjs`, `package-agent.mjs`) build a staging copy,
 * rewrite its manifest, and then ask npm for a tarball. They differ only in what
 * they do with the result, so the invocation, the `--ignore-scripts` rationale,
 * and the "did npm actually write it" checks live here once.
 *
 * `--ignore-scripts` is deliberate: the staging manifest runs nothing of its own,
 * and a lifecycle hook would only add a way for a pack to fail on the operator's
 * machine. `--silent` keeps stdout to the produced file name, which is what
 * callers need; npm notices still go to stderr.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { npmInvocation } from './package-manager.mjs'

/**
 * @param {object} options
 * @param {string} options.cwd Directory to pack, used as npm's working directory.
 * @param {string} options.destination Directory to write the tarball into.
 * @returns {string} Absolute path of the produced tarball.
 */
export function packTarball({ cwd, destination }) {
  const npm = npmInvocation()
  const output = execFileSync(
    npm.command,
    [...npm.prefixArgs, 'pack', '--silent', '--ignore-scripts', '--pack-destination', destination],
    { cwd, encoding: 'utf8' },
  )
  const filename = output.trim().split('\n').filter(line => line !== '').at(-1)
  if (filename === undefined) throw new Error('npm pack produced no filename')
  const tarball = resolve(join(destination, filename))
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`)
  return tarball
}
