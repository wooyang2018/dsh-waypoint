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

**Routing takes the host as input. It never infers a host from a path.**

`packages/local-plugin/src/mirror/service.ts` exposes three methods that answer three different
questions, and only one of them needs a host:

| Method | Question it answers | Needs a host? |
|---|---|---|
| `remoteFileContext(root)` | Which mirror owns this **local anchor** (or a path below one)? | No — anchors are unique |
| `resolveHostForRemotePath(path)` | Which **single** host could own this remote path? | No, and it refuses when several could |
| `remoteContextForRemotePath(path, hostId)` | Which of **that host's** workspaces mirrors this path? | **Yes, required** |
| `ownsMirroredRemotePath(path)` | Does **any** mirror claim this path? (boolean only) | No — never routes |

The signature of `remoteContextForRemotePath` is the enforcement: `hostId` is a required parameter,
so a caller that has not established the host cannot call it. There is deliberately no overload, no
optional host, and no fallback.

### Why not "longest prefix wins"

Longest-prefix matching is still used, but only *inside* a named host, to pick between that host's own
workspaces. It cannot decide between hosts: two machines can serve the same absolute path, and then
no amount of string analysis separates them. When a first-match-wins scan was used across hosts, it
did not merely pick a wrong-but-close answer — it picked a **different machine**.

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

## 3. When routing is ambiguous

Two conditions produce a path that names no single host:

1. **The same absolute path exists on two hosts** — for example
   `/data/home/user00/my-trex-skills` on two machines. Nothing in the string distinguishes them.
2. **One host's broad root encloses another host's checkout** — the `ungrouped` case above.

Both are handled the same way: `resolveHostForRemotePath` returns `undefined`, and the callers refuse.
`packages/local-plugin/src/remote/subprocess.ts → contextOf` raises a `LocalError` naming the
directory, and `remote/fs.ts → remoteOwnerOf` does the same. **Neither falls back** to:

- another host that plausibly matches,
- the local provider (which would run against the empty anchor),
- iteration order of the workspace map.

Falling back to the local provider is the worst of the three: the command runs, git answers
"not a git repository", and the caller reads that as "this is not a mirrored workspace" — the exact
misreading that hid the panel.

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
