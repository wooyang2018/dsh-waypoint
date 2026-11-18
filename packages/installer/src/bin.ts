/**
 * Executable entry for dsh-waypoint-install.
 *
 * @module @dsh-waypoint/installer/bin
 */

import { main } from './cli.ts'

process.exitCode = await main()
