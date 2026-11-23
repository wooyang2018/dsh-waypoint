# Whose directory is it? Host routing for a mirrored workspace's paths

A mirrored workspace has two names: the **local anchor** (an empty directory that stands in for the
remote one) and the **remote absolute path** (where the files actually are). Most code sees only the
second — the Forge panel, the change recorder, and the worktree service all run `git` through
`ctx.subprocess` with a `cwd`, and after the first inspection that `cwd` is the remote absolute path.

That is the seam this page is about. A remote path does **not** identify a host, and this plugin used
to guess one from the string. The guess was wrong often enough to hide a whole panel, and the way it
failed is worth recording, because the symptom pointed at git rather than at routing.

Source locations are cited as `file → symbol`, since line numbers drift.

## 1. The rule

**Routing takes the host as input. It never infers a host from a path alone.**

Attribution is layered, and each layer removes a different false answer:

1. **`ungrouped` workspaces never participate.** Their `remoteRoot` is the directory a Session
   happened to start in — often an entire home directory — so they enclose real checkouts without
   naming one. They still host Sessions, appear in the sidebar, and count for confinement.
2. **An exact `remoteRoot` beats an enclosing one.** `forkPoint` passes the canonicalized checkout
   root verbatim, so the workspace that owns it matches exactly; an enclosing root only answers when
   nothing matches exactly.
3. **A tie between two real workspaces is settled by the Session that asked.** Two hosts can serve the
   same absolute directory. The Session knows which one it is looking at, because its `header.cwd` is
   its local anchor and an anchor maps to exactly one host.

`packages/local-plugin/src/mirror/service.ts` exposes the pieces:

| Method | Question it answers | Needs a host? |
|---|---|---|
| `remoteFileContext(root)` | Which mirror owns this **local anchor** (or a path below one)? | No — anchors are unique |
| `resolveHostForRemotePath(path)` | Which **single** host owns this remote path under layers 1–2? | No, and it refuses on a tie |
| `hostForRemotePathOnBehalfOf(path, sessionId)` | Same, but layer 3 may break a tie | No |
| `remoteContextForRemotePath(path, hostId)` | Which of **that host's** workspaces mirrors this path? | **Yes, required** |
| `ownsMirroredRemotePath(path)` | Does **any** mirror claim this path? (boolean only) | No — never routes |

### How a spawn learns which Session it belongs to

`SubprocessSpawnSpec` carries no Session — only `argv`, `cwd`, `env`, `signal`, and limits. So the
Session's host is captured where a Session *is* available: Forge calls
`ctx.sandboxPolicy.resolve({ session })` once per Git runner (`gitIn`), and
`remote/sandbox-policy.ts` records `session → host` from that Session's anchor there.

That record is a Session-level fact, **not** a resolve-to-spawn pairing. Seven Git commands are
issued concurrently within milliseconds of each other, so "the most recent resolve" would attribute
commands to each other's Sessions. A Session-keyed map has no such race; the only value read at spawn
time is "which Session resolved a policy most recently", and it is consulted **only** when layers 1–2
left a genuine tie.

Note that `remote/sandbox.ts`'s `confine` interception cannot carry this: Forge skips `confine`
entirely under `danger-full-access`, which is the common case for a mirrored Session. `resolve` is
called unconditionally.

## 2. How the bug actually presented

The Forge panel's "local changes" card measures the branch with `forkPoint()`, whose first command is:

```text
git symbolic-ref --quiet --short refs/remotes/origin/HEAD
```

Every other command in the inspection starts from the **anchor**; this one starts from the **remote
path** that the earlier commands printed. So exactly one call in each refresh took the remote-path
lookup, and exactly one call failed:

```text
[anchor] rev-parse --show-toplevel              exit=0
[anchor] symbolic-ref --short HEAD              exit=0
... 5 more, all exit=0 ...
[remote] symbolic-ref --short refs/remotes/origin/HEAD
         → git/unavailable: could not run git: spawn git ENOENT
```

`forkPoint()` returned `null`, `localChanges()` returned `null`, and the panel rendered no card at
all. Nothing was logged: the panel's own `localOf()` swallows every error by design.

### `spawn git ENOENT` does not mean "git failed"

This is the expensive lesson. `ENOENT` from `child_process.spawn` means the **process could not be
started**, and a missing `cwd` produces exactly the same error as a missing executable. The command
never ran. So:

- `git` was installed and on `PATH`.
- The repository was fine.
- The **host the command was sent to did not have that directory**.

The remote path `/data/home/user00/siyuan-trex-toolbox` was routed to a host that only had
`/data/home/user00`, because that host owned an `ungrouped` workspace whose root was the home
directory. Git cannot `chdir` into a directory that does not exist, so it never started.

If you see `spawn git ENOENT` in this project, suspect **routing** before suspecting git.

### Why an `ungrouped` workspace makes it worse

An `ungrouped` workspace is created when a Session starts in a directory no workspace covers; its
`remoteRoot` is that entire directory. A host that once ran one Session from a home directory
therefore owns a workspace rooted at the whole home, and every real checkout on **every** host lies
inside it. Path-prefix inference then finds that broad workspace first and attributes unrelated
projects to that host.

That is why layer 1 excludes them from attribution. They are still real for everything else — they
host the Sessions that created them, they appear in the sidebar, and confinement must still recognise
a path inside one — they simply never answer "which checkout is this".

## 3. When routing is still ambiguous

After layers 1–2, a path that names no single host has exactly one cause: **two real workspaces on
different hosts share the same absolute directory**, for example
`/data/home/user00/my-trex-skills`. Nothing in the string distinguishes them, and no amount of prefix
analysis ever will.

Layer 3 handles it, because the Session does know: it was created for one host, and its anchor
identifies which. `hostForRemotePathOnBehalfOf(path, sessionId)` consults that first.

If no Session identifies the caller — a spawn that arrived outside any mirrored Session's work — the
callers refuse rather than guess. `packages/local-plugin/src/remote/subprocess.ts → contextOf` raises
a `LocalError` naming the directory, as does `remote/fs.ts → remoteOwnerOf`. **Neither falls back** to:

- another host that plausibly matches,
- the local provider (which would run against the empty anchor),
- iteration order of the workspace map.

Falling back to the local provider is the worst of the three: the command runs, git answers
"not a git repository", and the caller reads that as "this is not a mirrored workspace" — the exact
misreading that hid the panel. A refusal is loud and names the directory; that is the intended
behaviour for a case this code genuinely cannot decide.

## 4. How to diagnose a routing problem

Start with what the mirror already records.

**The routing-miss plugin record.** When a path that belongs to some mirror is served locally instead,
`service.ts → noteRoutingMiss` appends `plugin:dsh-waypoint/routing-miss` to that workspace's Session
log, once per path. Read it from the Session transcript; it carries `operation`, `path`, and `base`.
A miss with no host attributed means the path was ambiguous — nothing was written to any Session,
because no Session owns an ambiguous path.

**The live workspace table.** `~/.dsh/waypoint/mirrors.json` → `workspaces` is the ground truth for
"which host claims which root". Before believing any theory about routing, read it: look for
`remoteRoot` entries that are prefixes of the path in question, and for `ungrouped:` keys, whose
roots are whole directories.

**The distinction that resolves most confusion.** Ask the two questions separately:

```text
Hosts the agent:      POST /dsh-waypoint-agent/api/v1/git   {cwd, args}
```

If that succeeds, the remote side is healthy and the *code* is fine — what remains is *where the Host
sent it*. A direct agent call proves the destination works; it proves nothing about routing, because
it bypasses the Host entirely.

## 5. What not to conclude from a green local run

A local Session's Forge panel shares no routing code with a mirrored one: local paths resolve through
`remoteFileContext` and miss, so the stock provider runs. A correct card in a local workspace is not
evidence that mirrored routing works.

Likewise, a unit test with a single-host fixture cannot catch a host-attribution bug at all — the
fixture has only one host to be wrong about. `packages/local-plugin/test/mirror_remote_path.test.ts`
therefore builds a two-host catalog, including one host whose `ungrouped` root encloses the other's
checkout, and asserts that ambiguity refuses rather than resolving.
