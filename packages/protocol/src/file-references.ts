/**
 * Wire types for the remote-side `@` file-reference menu.
 *
 * The browser's `@` source asks the Host that owns the Session, and a mirrored
 * Session's owner is the remote machine: the local `fileReferences` provider is
 * `dsh-file-reference-local`, which walks the *local* directory tree with
 * `node:fs`. A mirrored Session's cwd is the remote absolute path, so that walk
 * either finds nothing or, where the path happens to exist locally, lists the
 * wrong machine's files.
 *
 * The route therefore carries one query to the host that can answer it, and the
 * remote runs the same provider against its own tree. Nothing is re-implemented
 * here: ordering, ignore rules, the entry budget and the result cap all stay the
 * remote's, because they are the remote provider's.
 *
 * **No mapping happens on the way back.** A candidate is already
 * host-independent and JSON-safe, and its path is spelled the way the remote
 * wrote it — which is what a prompt needs, since the mirror forwards the remote
 * absolute path in a `file` part and an `@<remote path>` in text resolves on the
 * remote host.
 *
 * @module @dsh-waypoint/protocol/file-references
 */

/**
 * One path-only completion candidate inside the remote Session's directory.
 *
 * Field-for-field the Host's `FileReferenceCandidate`
 * (`@deepseek-ai/dsh-file-reference/types`), declared here rather than imported
 * for the same reason the rest of this package mirrors DSH shapes: the protocol
 * stays free of DSH imports so the browser bundle can read it type-only.
 */
export interface RemoteFileReferenceCandidate {
  /**
   * User-facing path, exactly as the remote provider spelled it.
   *
   * Absolute for `dsh-file-reference-local`; the spelling is what makes the
   * selected reference resolvable on the host that produced it.
   */
  readonly path: string
  /** Directories keep completion open; files finish the mention. */
  readonly kind: 'file' | 'directory'
}

/**
 * One reference query, addressed to the Session whose directory bounds
 * discovery.
 *
 * Addressed by Session rather than by a path on purpose: the remote resolves the
 * Agent from that id and asks the provider with it, which is how the remote Web
 * UI reads the same menu. A path sent from here would be the caller's guess at
 * which directory the Session works in.
 */
export interface RemoteFileReferenceRequest {
  /** Remote Session whose Agent answers the query. */
  readonly sessionId: string
  /**
   * Path text following `@` or `@"`, verbatim.
   *
   * Not trimmed, filtered or normalised: the provider's own grammar decides what
   * a prefix means, and a query is allowed to be empty — that is the menu's
   * opening state, which lists the Session's own directory.
   */
  readonly query: string
}

/**
 * Candidates one remote query answered.
 *
 * The array is required even when nothing matched. An absent one would be a
 * shape a caller cannot tell from "this project has no files", and the two mean
 * very different things.
 */
export interface RemoteFileReferenceResult {
  readonly candidates: readonly RemoteFileReferenceCandidate[]
}
