/**
 * Projection from the installer's probe to the shape Settings renders.
 *
 * The raw probe answers questions a browser has no use for (which downloader
 * the host has, which login shell answered). The client only needs to decide
 * between three sentences: already fine, needs installing, or cannot be
 * installed here — and the version verdict must come from the same rule the
 * bootstrap enforces, never from a comparison written in the UI.
 *
 * @module dsh-waypoint/remote/node-state
 */

import { MINIMUM_NODE_VERSION, type RemoteNodeStatus } from '@dsh-waypoint/installer'
import type { RemoteNodeState } from '../host-api/contract.ts'

/** Collapse a probe result into the browser-safe state. */
export function toRemoteNodeState(status: RemoteNodeStatus): RemoteNodeState {
  const version = status.version.trim() === '' ? null : status.version.trim()
  return {
    supported: status.supported,
    version,
    // Trust the probe's own verdict, which runs the shared check on the remote.
    satisfied: status.satisfied,
    minimum: MINIMUM_NODE_VERSION,
    nvmInstalled: status.nvmInstalled && status.nvmNodeVersion !== '',
  }
}
