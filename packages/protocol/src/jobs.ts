/**
 * Background-job roster and output streams, as a mirrored Session needs them.
 *
 * Jobs belong to the process that started them: the registry lives in the Host
 * that ran the tool, and its ids, output ring and settlement all point at that
 * process. A mirrored Session's local Host has no such registry entries, so its
 * own `job/list` answers an empty roster — indistinguishable from "nothing is
 * running", which is the worst possible answer for a user watching a long build.
 *
 * These are the frames of the remote `job` Remote namespace
 * (`@deepseek-ai/dsh-api-job-controller`), restated without importing it: the
 * agent forwards the owning host's own stream, so the local panel receives the
 * same whole-set roster and the same per-job output frames it would have seen on
 * the remote Web UI.
 *
 * @module @dsh-waypoint/protocol/jobs
 */

/** Job lifecycle: live, stopping, then exactly one terminal status. */
export type RemoteJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** Stream label of one output chunk. */
export type RemoteJobChannel = 'stdout' | 'stderr' | 'log'

/**
 * Where one job's output ring currently stands.
 *
 * `total` is the offset the next chunk starts at; `earliest` is the oldest
 * retained byte and exceeds zero exactly when retention dropped the head.
 * `spillPaths` names complete-stream files **on the remote host**, which a local
 * reader cannot open — it is carried because the frame is the remote's own, not
 * because a local panel may use it.
 */
export interface RemoteJobOutput {
  readonly total: number
  readonly earliest: number
  readonly spillPaths?: readonly string[]
}

/** One job as the owning host projects it. */
export interface RemoteJobView {
  /** Registry-issued id (`<kind>-<short-uuid>`). */
  readonly id: string
  /** Producer kind. */
  readonly kind: string
  /** Producer-supplied one-line label. */
  readonly label: string
  /** Owning Session; absent for an unowned job, which every caller can see. */
  readonly owner?: string
  /** Producer-owned cap for model-facing notices and reads, in UTF-8 bytes. */
  readonly outputLimitBytes?: number
  /** Current lifecycle state. */
  readonly status: RemoteJobStatus
  /** Producer's live progress line; cleared at settlement. */
  readonly progress?: string
  /** Terminal reason (`exit code: 3`), with any recorded kill reason merged in. */
  readonly detail?: string
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  readonly finishedAt?: number
  /** Output ring coordinates and the complete-stream files behind it. */
  readonly output: RemoteJobOutput
}

/** One chunk of a job's output ring. */
export interface RemoteJobChunk {
  /** Absolute offset of the chunk's first byte. */
  readonly at: number
  /** Chunk text exactly as appended. */
  readonly text: string
  /** Stream label, when the producer supplied one. */
  readonly channel?: RemoteJobChannel
  /** Bytes immediately before this chunk were lost. */
  readonly gapBefore?: true
}

/**
 * One roster frame: the complete set the Session can see, after a change.
 *
 * Whole-set replacement, so a reconnecting client's first frame is already the
 * truth and no diff bookkeeping is needed on either side.
 */
export interface RemoteJobListFrame {
  readonly type: 'rows'
  readonly jobs: readonly RemoteJobView[]
}

/**
 * One observation frame of a single job.
 *
 * `opened` anchors the stream with the job's projection and the offset the first
 * `output` continues from; `output` carries coalesced chunks; `status` is the
 * settled projection, after which the stream closes normally.
 */
export type RemoteJobFollowFrame =
  | {
    readonly type: 'opened'
    readonly job: RemoteJobView
    /** Offset the first `output` frame continues from. */
    readonly from: number
  }
  | {
    readonly type: 'output'
    readonly chunks: readonly RemoteJobChunk[]
    /** Offset to resume from after this frame. */
    readonly next: number
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true
  }
  | {
    readonly type: 'status'
    readonly job: RemoteJobView
  }
