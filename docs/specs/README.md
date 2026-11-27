# Specifications

Design documents for work that is agreed, whether or not it has landed yet. Each one states the
defect, the decision, what it rejects, and the slices an implementer works through. The English page is
canonical.

An implemented specification is not deleted: it stays as the record of why the code looks the way it
does, which is the question a future reader actually has.

## Open

| Document | What it fixes | Touches |
|---|---|---|
| [`@` file references](2026-11-27-remote-file-references.md) | The `@` menu lists the local tree instead of the remote project | protocol, remote-agent, local-plugin |
| [Attachment parity](2026-11-27-mirror-attachment-parity.md) | Tool-result images are never synced, and attachment-only prompts duplicate their bubble | local-plugin |
| [Queued-message mutation](2026-11-27-mirror-queue-mutation.md) | Editing or removing a queued message never reaches the remote | protocol, local-plugin |
| [Session rename](2026-11-27-mirror-session-rename.md) | Renaming a mirrored Session only renames the local projection | protocol, remote-agent, local-plugin |
| [Mirrored namespace policy](2026-11-27-mirrored-namespace-policy.md) | Goals, jobs, teams, subagents and feedback silently write local state the remote never sees | protocol, remote-agent, local-plugin |

## Implemented

| Document | Landed as |
|---|---|
| [Remote command and skill catalogs](2026-11-26-remote-catalog-bridge.md) | 1.1.4 — `/` menu, skills, and command execution answered by the owning host |
| [Remote directory type and working directory](2026-11-27-remote-directory-type.md) | Unreleased — `file.stat` carries the type, and a mirrored cwd resolves on its own host |
