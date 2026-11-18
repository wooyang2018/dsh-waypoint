# dsh-waypoint-agent

A remote DSH plugin that exposes the remote host's workspaces and sessions to the local plugin.

## What it does

- Registers `/dsh-waypoint-agent/api/v1` on the remote DSH web server.
- Generates and stores a bearer token in `$DSH_HOME/waypoint-agent/agent.json` (mode `0600`).
- Projects host identity, workspaces, sessions, and session snapshots.
- Streams committed session events over SSE, including surface placement metadata for native replay.
- Creates workspaces, creates sessions, submits text prompts with optional model selection, and cancels active turns.
- Writes its live port into the state file so the local plugin can discover it over SSH.
- Serves read-only filesystem APIs and a PTY terminal surface used by the native local UI.

The terminal surface executes a shell on the remote host. The bearer token and `0600` state file are
the trust boundary; keep the listener on loopback.
Approval questions are forwarded through the agent approval stream so the native local UI can answer
them. The remote browser UI keeps working: `cordis.patch.yml` leaves `dsh-api-remotes` enabled and the
approval bridge registers with `prepend`, so it runs before that carrier's listener.

## Install

Normally the local plugin installs this package for you when you add a host. For a manual install:

```sh
node packages/installer/lib/cli.js install --target user@host
# or
dsh plugin --profile web add dsh-waypoint-agent@0.2.12
dsh web --host 127.0.0.1 --port 0 --no-open
```

## Endpoints

Read and write routes are documented in [`docs/protocol.md`](../../docs/protocol.md):

- `GET /health`, `/host`, `/workspaces`, `/sessions`, `/sessions/:id`, `/sessions/:id/events`, `/sessions/:id/assistant-events`, `/web-url`, `/llm/catalog`, `/approvals/events`
- `POST /workspaces`, `/sessions`, `/sessions/:id/model`, `/sessions/:id/sandbox`, `/sessions/:id/prompt`, `/sessions/:id/cancel`, `/sessions/:id/archive`, `/approvals/answer`
- `POST /files/stat`, `/files/list`, `/files/read`, `/files/bytes`
- `GET /files/watch`, `/directories`, `/terminals`, `/terminals/:id/attach`
- `POST /terminals`, `/terminals/:id/input`, `/terminals/:id/rename`, `/terminals/:id/close`

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/remote-agent.patch.yml`](../../examples/remote-agent.patch.yml).
