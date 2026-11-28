/**
 * Deterministic fixtures for the fake remote host.
 *
 * @module @dsh-waypoint/testkit/fixtures
 */

import type {
  AgentCapability,
  HostInfo,
  RemoteCommandDescriptor,
  RemoteFileReferenceCandidate,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteSkillEntry,
  RemoteWorkspace,
} from '@dsh-waypoint/protocol'

/** One fake workspace. */
export interface FakeWorkspace extends RemoteWorkspace {}

/** One fake session with its event log. */
export interface FakeSession {
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly cwd: string | null
  readonly createdAt: string
  readonly live: boolean
  events: RemoteSessionEvent[]
}

/** Fixture set returned by {@link createFixtures}. */
export interface Fixtures {
  readonly hostInfo: HostInfo
  readonly workspaces: FakeWorkspace[]
  readonly sessions: FakeSession[]
  /**
   * Command descriptors the fake catalogs answer with.
   *
   * Mutable so a test can simulate a remote plugin install appearing mid-run,
   * which is the one case the local menu has to notice by change detection
   * rather than by a forwarded event.
   */
  commands: RemoteCommandDescriptor[]
  /** Skill entries the fake catalog answers with. */
  skills: RemoteSkillEntry[]
  /**
   * Candidates the fake `@` reference menu answers with.
   *
   * Mutable for the same reason `commands` is: a test can change what the host
   * offers between two reads without rewriting the fixture.
   */
  fileReferences: RemoteFileReferenceCandidate[]
}

/** Build deterministic fixtures with two workspaces and three sessions. */
export function createFixtures(hostId = 'fake-host'): Fixtures {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z')
  const event = (seq: number, type: string, data: Record<string, unknown>): RemoteSessionEvent => ({
    seq,
    type,
    time: t0 + seq * 1_000,
    data: data as RemoteSessionEvent['data'],
  })
  const sessions: FakeSession[] = [
    {
      sessionId: 'session-alpha',
      workspaceId: 'workspace-alpha',
      cwd: '/srv/alpha',
      createdAt: new Date(t0).toISOString(),
      live: true,
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'user/message', { content: 'hello' }),
        event(2, 'assistant/message', { content: 'hi' }),
        event(3, 'turn/end', { turn: 1, reason: 'complete' }),
      ],
    },
    {
      sessionId: 'session-beta',
      workspaceId: 'workspace-alpha',
      cwd: '/srv/alpha',
      createdAt: new Date(t0 + 60_000).toISOString(),
      live: false,
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'user/message', { content: 'cold prompt' }),
      ],
    },
    {
      sessionId: 'session-gamma',
      workspaceId: null,
      cwd: '/tmp',
      createdAt: new Date(t0 + 120_000).toISOString(),
      live: true,
      events: [
        event(0, 'turn/start', { turn: 1 }),
      ],
    },
  ]

  const workspaces: FakeWorkspace[] = [
    {
      workspaceId: 'workspace-alpha',
      path: '/srv/alpha',
      title: 'Alpha',
      sessionIds: ['session-alpha', 'session-beta'],
      createdAt: new Date(t0).toISOString(),
      updatedAt: new Date(t0 + 60_000).toISOString(),
    },
    {
      workspaceId: 'workspace-beta',
      path: '/srv/beta',
      title: 'Beta',
      sessionIds: [],
      createdAt: new Date(t0 + 30_000).toISOString(),
      updatedAt: new Date(t0 + 30_000).toISOString(),
    },
  ]

  const capabilities: AgentCapability[] = [
    'health',
    'host.info',
    'workspace.list',
    'session.list',
    'session.snapshot',
    'session.follow',
    'web.url',
    'directory.list',
    'file.watch',
    'terminal',
    'approval.follow',
    'approval.answer',
    'session.catalog',
    'session.command',
    'file.references',
  ]
  const hostInfo: HostInfo = {
    hostId,
    hostname: 'fake-remote',
    platform: 'linux',
    arch: 'x64',
    dshVersion: '0.2.2-rc.2',
    agentVersion: '0.1.0',
    home: '/home/fake',
    loginShell: '/bin/zsh',
    startedAt: new Date(t0).toISOString(),
    protocolVersion: 1,
    capabilities,
    workspaceCount: workspaces.length,
  }

  return {
    hostInfo,
    workspaces,
    sessions,
    commands: createCommands(),
    skills: createSkills(),
    fileReferences: createFileReferences(),
  }
}

/**
 * Commands the fake host's catalogs answer with.
 *
 * One preset-shaped command with an input hint, one with no input, and one that
 * accepts attachments: the three rows a local adapter has to reproduce exactly,
 * including the `input.attachments` flag it needs to refuse a submission before
 * spending an upload.
 */
function createCommands(): RemoteCommandDescriptor[] {
  return [
    { name: 'compact', description: 'Compact this session context' },
    { name: 'goal', description: 'Set or read the session goal', input: { hint: '<text>' } },
    { name: 'export', description: 'Download this Session log as a ZIP archive' },
    { name: 'note', description: 'Attach files to a transcript remark', input: { hint: '<text>', attachments: true } },
  ]
}

/**
 * Skills the fake host's catalog answers with.
 *
 * Already filtered: the remote route returns only user-invocable skills, so the
 * fake reproduces that answer rather than the pre-filter registry.
 */
function createSkills(): RemoteSkillEntry[] {
  return [
    { name: 'dsh-doc', description: 'DeepSeek Harness reference', modelInvocable: true },
    { name: 'spec', description: 'Design a feature', whenToUse: 'before implementing', modelInvocable: true },
  ]
}

/**
 * Reference candidates the fake host's `@` menu answers with.
 *
 * A POSIX path in the first Session's directory, one directory and one file:
 * the pair a caller has to keep distinct, because a directory candidate keeps the
 * menu open while a file one finishes it. The paths are remote-spelled on
 * purpose — that is what a client must not rewrite.
 */
function createFileReferences(): RemoteFileReferenceCandidate[] {
  return [
    { path: '/srv/alpha/src', kind: 'directory' },
    { path: '/srv/alpha/README.md', kind: 'file' },
  ]
}

/** Project one fake session to the wire summary. */
export function summarize(session: FakeSession): RemoteSessionSummary {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    live: session.live,
    eventCount: session.events.length,
  }
}
