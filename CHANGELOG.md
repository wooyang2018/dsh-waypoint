# Changelog

## Unreleased

### Fixed

- **A forwarded file now reaches a Session nobody has opened yet.** An attachment is admitted before
  `promptSession` hands the prompt to `sessionController.prompt`, and that hand-off is what resumes a
  cold Session — so at admit time there was no live Agent. The agent read `ctx.agents.get()`, a
  synchronous table lookup, answered `undefined`, and refused the whole prompt as `session/not-live`
  even though the next step would have woken it. Text prompts never hit it because they need no Agent
  until that same step, which made "text works, files do not" look like an attachment bug rather than
  a resolution-order one. Admission now uses `fileUploads.uploadStream`, which takes a Session id and
  resolves the Agent itself — resuming on a miss through the controller's registered resolver — so one
  path serves cold and warm Sessions.
- The same bug affected every "cold Session plus attachment" entry, not only mirrored ones: a browser
  upload to a Session opened for the first time failed the same way. It surfaced as the generic
  "remote agent returned an error", because `session/not-live` carries no user-facing wording.
- **A prompt the mirror refuses now tells the user instead of vanishing.** The failure was reported
  through `agent/error`, which the Host relays into the client Session's `lastAgentError` — a field no
  component renders. So a refused prompt produced no visible reaction at all, and a correct refusal
  looked like a message that disappeared. The failure now also queues a notice on the channel the
  archive-failure toast already used: it rides the claim heartbeat and becomes a toast, carrying the
  localizable reference and its `{path}` parameter so the specific cause reaches the user. A cause with
  no localizable text falls back to one generic sentence rather than a raw host message.
- Notices are shown only while the Session they belong to is still the one on screen, so a failure from
  a conversation the user has left does not interrupt them or point at the wrong transcript.
- **A file picked in the Desktop application now reaches a mirrored Session.** The Desktop preload
  exposes a host-path bridge, and the composer prefers a path over an upload whenever that bridge
  answers — so a non-image file became an `@path` reference instead of an attachment, and a mirrored
  Session sent that path as ordinary text. The remote could not open it: `relativizeToCwd` strips the
  workspace root only when the path is under it, and a mirror's root is an empty local anchor, so the
  reference usually arrived as an absolute path on the *user's* machine. Images were unaffected
  because the composer short-circuits them to the upload branch first, and `dsh web` was unaffected
  because it has no bridge at all — which is exactly why the failure could not be reproduced in a
  browser.
- The plugin now resolves such a reference itself (`#resolveTextReferences`): an `@`-prefixed absolute
  path is confirmed with `stat` and forwarded as a `file` part through the channel a picked
  attachment already uses. The `@` prefix is required so prose containing `src/main/index.ts` or a
  bare `C:` is never read as a request, and `stat` — not the shape of the text — decides whether
  something is forwarded.
- A reference that cannot be forwarded now fails with the path named, instead of travelling as text
  the remote cannot open: a missing path, a directory, a file over the forward limit, or a remote agent
  without `session.file-attachment` each report their own cause.
- The rewritten text replaces `@<path>` with `[<name>]`, and the pending entry records the text
  actually sent. Pairing an echoed `user/message` is by text, so keeping the original reference there
  would have appended the echo as a second bubble.
- **The right-sidebar file panel now opens a local path instead of failing on it.** Reading a file by
  its own absolute path in a mirrored Session reported
  `读取失败：remote file path is outside the mirrored workspace: C:/…/plugin.json`. The path resolver
  saw three cases — a remote absolute path, a path inside the local anchor, and a remote absolute path
  outside the workspace — and threw for everything else, which is what a Windows drive path is: absolute
  in the local syntax, impossible in the remote one. Naming the mirror was the wrong reading. Such a path
  can only exist on this machine, so it now answers "local-only" and the adapter's existing not-mirrored
  branch serves it from the stock service — the same branch that already handles every ordinary local
  workspace. The reference is not an accident either: the Desktop composer turns a picked non-image file
  into an `@<path>` reference, so a mirrored transcript holds these paths by design. The refusal that
  remains is a relative path escaping the anchor, which is a statement about the request rather than
  about the mirror.
- **A mirrored `/compact` now shows its compaction card.** The card is built from two pieces of remote
  evidence, and both were being filtered as "not the conversation": the `compaction/summary` carrying
  the text and token accounting, and the `user/message` whose `surfaceOp` replaces the compacted span.
  The second one was collateral damage — the rule that drops injected context (`source.kind !== 'user'`)
  caught the checkpoint too, although a checkpoint is a real surface replacement rather than injection.
  The summary is now replayed with its `rawOutput` reduced to the `reasoning` blocks — the summary
  text is already a projection of the rest, and the thinking is the only part with a reader (the
  trajectory panel) — while the checkpoint is replayed as a replacement, and the remote
  `compaction/start`/`compaction/end` pair is still dropped because a local copy of the remote lock
  would imply a transaction this log cannot run.
- **A replacement range crossing into a mirrored Session kept the remote numbering.** `remapRemoteEvent`
  translated `sourceEventSeqs` but passed `event.surfaceOp` through untouched, so replaying a
  replacement deleted whatever local events happened to carry those seqs. The branch had never executed
  against real data — every replacement event was filtered — which is why it was wrong for months
  without a symptom. The span is now computed over the part of the range this log actually holds, so a
  compaction whose boundary falls on an unreproduced injected message still places instead of vanishing.

- **A mirrored Session's `/` menu now offers the remote agent's own commands and skills.** The menu is
  served by Host services backed by scoped registry layers, and a mirror's Agent façade joins no Agent
  preset — so `/goal`, `/compact`, `/plan` (which the Web surface keeps off the host plane and mounts
  inside a preset) and the project's skills were simply absent. Both catalogs and command execution are
  now answered by the host that runs the Session: `commands.list`, `commands.execute` and
  `sessionSkillCatalog.list` forward for a mirrored Session and delegate unchanged for everything else.
  A draft mirror answers through its preset without creating a remote Session; executing a command
  materializes one first, because the registry logs its lifecycle there.
- **That menu no longer empties out when the remote Session is cold.** After a remote DSH restart or a
  reconnect no Agent is bound to the Session, which is the ordinary state and exactly when someone types
  `/` in a conversation they have not resumed. The read answered `session/not-live`, the local adapter
  degraded to its own list, and the menu lost every remote command and skill with only a `debug` line to
  show for it. It is now answered the way a draft already was — lease the preset the log recorded and
  resolve the directory from the same observation a resume restores — so reading a menu never wakes a
  Session. `execute` still requires the live Session, because a command appends its lifecycle to it.
- **A command run in a mirrored Session now renders where it belongs.** The remote's `command/done`
  carries `sourceEventSeq` in the remote numbering, and the chat command node adopts that value as the
  event it follows, so an unremapped citation pointed at whatever local event happened to carry that
  seq. The mirror now rewrites it into its own log and drops it when the target is unknown.
- **An attachment sent from a mirrored Session now reaches the remote Session.** A file was dropped
  silently: `promptParts` recognised only `text` and `image`, so a file-only prompt returned before
  anything was sent and a mixed prompt arrived without it. The local transcript had already shown the
  message as accepted, so the symptom was "my file is in the session but the remote never saw it". A
  `file` part now travels as its own `content` entry, and a host without `session.file-attachment`
  refuses before sending instead of losing it.
- **An image prompt in a mirrored Session was rejected as "agent busy".** Local prompt admission
  resolves the model through `ctx.llm` whenever the content carries an image, and a `direct`-mode
  host's model exists only on the remote — so resolution threw `LlmError NO_ADAPTER`, which admission
  wraps as `session/agent-busy`. Text prompts never reach that check, which is why only attachments
  failed. `RemoteMirrorAgent.model.current()` now reports no local route, which is the truth: the
  model runs on the remote Host. The composer's selectors read the remote catalog and the forward path
  reads `selectionFor`, so neither was relying on it.
- **A remote user's attachments now appear in the mirrored Session.** A replayed `user/message`
  carries durable references whose bytes live only on the remote host. Nothing fetched them, so an
  image rendered blank for the life of the Session, and a file could be seen but not opened. Both are
  now copied into the local store before the message is projected — a prefetch, because the image
  loader never retries a miss. Files are re-saved verbatim (same bytes, same content address);
  images are published byte-for-byte under the id their digest names, because an image's id covers an
  object that was already normalized remotely and re-encoding it would change the digest.
- **A local terminal no longer fails with "Terminal attachment requires a Remote invocation".** The
  gateway terminal adapter captured each stock method with `.bind(controller)`, which freezes the
  `this` of *install time*. The Typert Gateway never calls a service method on the instance: it builds
  a per-call view with `receiverContext.extend({ invocation })`, and the stock `attach` reads
  `this.ctx.invocation.uplink` from it. So the bound delegate saw a context with no invocation and
  threw — for **every** Session, local ones included, since the local branch is exactly the one that
  delegated to the stock method. The delegates now forward the call-time receiver, and restore goes
  through `remote/install.ts` so unload puts the instance back. The regression test asserts a local
  `attach` reaches an invocation-carrying receiver; it fails on the previous code.

### Added

- `session.file-attachment` and `attachment.read` capabilities, plus `POST /attachments/read`, so a
  client can tell before sending whether a host can carry attachments in either direction. An older
  agent is refused with a Reinstall instruction rather than a silent drop.
- `session.catalog` and `session.command` capabilities, plus `POST /catalog/commands`,
  `POST /catalog/skills` and `POST /commands/execute`. Each is separate because they fail differently:
  an agent without the catalogs keeps its local answer, while an agent without command execution
  delegates execution instead of accepting a line it cannot run. Both catalog routes accept either a
  Session id or a draft's `{ agentPreset, cwd }`, so a mirrored conversation shows a populated menu
  before its first message.
- `mirrorRemoteCatalog` (default on) and `mirrorCommandTimeoutMs` (default 120 s). A command handler
  may legitimately run for minutes — `/compact` performs a summarization call — so the request timeout
  that suits a metadata read would report a failure for work still in progress.
- `RemoteMirrorService.forwardedSelection`, the model a mirror would forward for one local Session.
  It exists because the Agent façade can no longer answer that question, and it is what the
  model-selection tests now assert on.
## 1.1.4

### Added

- **`ask_user_question` from a mirrored Session now shows its card locally instead of silently
  disappearing.** Only `approval/request` was bridged, so a remote agent that asked a question waited
  for an answer that never arrived: the card only ever existed in the remote Web UI, which is exactly
  the context a mirror user does not have open. The plugin now bridges the second human-interaction
  seam the same way it bridges the first — the remote agent prepends a listener to
  `user-questions/request` (`#bindQuestions`), replays the pending set over the new
  `GET /questions/events`, and the local side rebuilds the waterfall through
  `scopeTarget(runtime.agent, …)` before returning the answer to `POST /questions/answer`.

  Three rules differ from the approval bridge, and each one is a failure the naive port would have
  caused. The agent only claims a question while a local stream is attached, because an approval can
  resolve `unavailable` — which reads as a refusal — while a question resolves into a tool result the
  model acts on, so "nobody was listening" must never become "the user declined". A new `delegated`
  outcome reports that no local mirror can show the question, which hands it back to the remote UI
  instead of reporting a decision a human never made. And the wire carries no `wait` field: a timed
  wait would make the local card attach to a foreground stream owned by the *local* Host's
  `userQuestions` service, which has never heard of a remote call.

  Neither bridged seam has a clock by default: `questionTimeoutMs` and `approvalTimeoutMs` both
  default to `0`, meaning wait indefinitely, because neither `dsh-user-questions` nor
  `dsh-user-approval` contains a timer. Adding one would make this plugin the only part of the system
  that decides a person has taken too long, and the thing it produces at that point is not an answer.
  A deployment may opt in; an expiring question then fails with `ASK_UNANSWERED` rather than
  `ASK_CANCELLED`, because "the question was never seen" and "the user withdrew it" are different
  facts. Both capabilities (`question.follow`, `question.answer`) are required before the local side
  opens the stream, so an older remote agent keeps its current behaviour and an older plugin keeps
  its current behaviour against a newer agent.

### Fixed

- **A bridged approval no longer gives up after a hard-coded ten minutes.** The remote agent used to
  answer `unavailable` ten minutes into any approval nobody had replied to. `dsh-user-approval` has
  no such timer, and its `unavailable` outcome means "no answerer was reachable" — so the constant
  reported "nobody replied yet" in the vocabulary of "nobody could be asked". The wait is now
  indefinite by default (`approvalTimeoutMs: 0`); a deployment that wants a bound sets one and gets
  the same `unavailable` outcome, which is truthful once a timer is genuinely the explanation.

## 1.1.3

### Fixed

- **Archiving a mirrored Session now archives its remote Session, and unarchiving restores it.** The
  sidebar's Archive action went straight to the Host's `workspaceRegistry`, which knows nothing about
  mirroring, so only the local projection was hidden: the remote Session stayed alive and listed, the
  next reconciliation mirrored it again, and the archived conversation reappeared after every restart.
  The plugin now interposes on the registry's `archiveSession`/`unarchiveSession` — the same one-layer
  host-side replacement `remote/files.ts` uses for files — and forwards a user's archive to
  `POST /sessions/:id/archive`, restoring through the new `POST /sessions/:id/unarchive` route and the
  `session.unarchive` capability added in this release.

  Both directions ship together and are required before the plugin touches the remote at all. DSH's
  `ArchivedSessionGate` rejects every model step of an archived Session, so a remote archived by a
  plugin that could not restore it would leave a mirror that opens, shows its history, and silently
  refuses to answer. On an agent that does not advertise both capabilities the plugin archives locally
  only, exactly as before; reinstall the remote agent to get the round trip.

  The plugin's own cleanup — removing a workspace, pruning a subagent mirror, hiding a test workspace,
  abandoning a promotion — never reaches the remote, because `stopActivity` cannot express that
  distinction (the internal helper always passes `true`); those archives are marked in-process instead.
  An archived mirror is also no longer recreated on restart, which is what makes the fix hold for
  records archived before this release as well — nothing is deleted, so unarchiving still works.

- **A failed remote archive is reported instead of failing silently.** The local archive is written
  first, so a host that is offline or refuses the call leaves the row hidden and cannot resurrect it —
  but the remote Session is still live, any running turn was never stopped, and nothing retries. The
  client is now told: a short toast arrives through the heartbeat the page already polls, saying the
  remote Session could not be archived and is still running. Unarchiving stays fail-closed by contrast;
  a remote that cannot be restored keeps its local archive rather than handing back a conversation that
  silently rejects every prompt.


## 1.1.2

### Changed

- **The tested DSH release moves from `0.2.2-rc.3` to `0.2.2-rc.5`.** CI's `DSH_TARGET`, the
  installer's `--dsh-version` default, `FALLBACK_REMOTE_DSH_VERSION`, the committed dependency
  baseline and the supported-version matrix all follow it. **No plugin code changed**, and no peer
  range needed widening: `>=0.2.2-rc.2 <0.3.0-0` already admits `rc.5` under both DSH's
  prerelease-inclusive check and npm's stricter one, and `@deepseek-ai/cordis` (`4.1.0`) and
  `@deepseek-ai/schemastery` (`3.19.0`) are unchanged between the two. Of the 338 DSH packages, 16
  changed; `dsh-api-terminal-controller`'s `lib/index.js` — the service this plugin patches — is
  byte-identical, and the only relevant difference (`dsh-api-remotes`) is confined to its browser
  bundle. The full suite passes unchanged.
- **The package description and keywords name what the plugin does.** The npm listing carried a
  serialized feature list ("host registry, SSH tunnels, remote workspace/session discovery, an
  authenticated Connection RPC surface, …") instead of a sentence a reader can act on, and five
  keywords that no plausible search uses. It is now one sentence — SSH remote development for
  DeepSeek Harness, mirroring remote Sessions into the sidebar with terminals, files and dev servers
  over one tunnel — with keywords for the words people search for (`ssh-tunnel`, `remote-session`,
  `remote-workspace`, `dev-server`, `port-forwarding`).

### Documentation

- **Both READMEs and the package README show the plugin.** The Settings host list and the
  add-workspace dialog were only described in prose, which left the plugin-market entry — the page
  most people see first — as a wall of text with no image at all. Each page now opens with the host
  list and the add-workspace dialog, in both themes.
- **The READMEs carry the Awesome DSH Plugin badge.** The project has been listed in
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com) under **Remote & Mobile** since 2026-11-19;
  the badge links back to the list.
- **[Adapting to a new DSH release](docs/adapting-to-dsh-releases.md) is rewritten around the
  measurements that actually decide a migration.** It gains a step 0 that asks which npm channel the
  release is on, whether the plugin installs **into a real DSH runtime** (rather than into a bare
  directory, where npm invents an optional-peer resolution no profile would have), and which packages
  changed by comparing built output rather than version numbers. It also records two answers that were
  wrong until they were measured: that the plugin cannot install into a newer line because a bare
  directory reported a conflict, and that a differing package always means work — `dsh-api-remotes`
  differed only in a browser bundle this plugin never patches. It documents the npm-versus-pnpm
  prerelease divergence and why widening the peer range broke a line that installed cleanly, and ends
  with the `rc.3 → rc.5` move as a worked example to compare the next one against.
- **The DSH dependency range records what it does and does not admit.** DSH evaluates
  `engines.dsh` with `includePrerelease: true` while npm and pnpm use semver's defaults, so the
  current `>=0.2.2-rc.2 <0.3.0-0` admits the whole `0.2.2` line to an installer but not the
  `0.2.3-alpha.*` line. Widening it to cover those prereleases was implemented, measured and
  reverted in this release: npm resolves every optional DSH peer to the highest matching version, so
  admitting `0.2.3-alpha.*` pulled in `dsh-api-terminal-controller@0.2.3-alpha.2`, whose
  `@deepseek-ai/cordis@~4.2.0-alpha.1` conflicts with `cordis-plugin-include@1.2.0-alpha.1` — and the
  install then failed on `0.2.2`, which installs cleanly today. `docs/adapting-to-dsh-releases.md`
  now records that measurement, and `packages/local-plugin/test/peer-range.test.ts` pins what each
  evaluator decides for every published DSH release so the range cannot drift silently.

## 1.1.1

### Added

- **Proxy mode now offers this machine's models on the remote host.** A host using **本地 Key 代理**
  used to advertise exactly one provider, derived from `DEEPSEEK_BASE_URL`, so a Session mirrored from
  that host could only pick a DeepSeek model even though every request was already arriving locally.
  The local `llm-pi-ai` providers are now projected onto the remote: each one keeps its own `api`,
  models, compatibility settings and headers, is published at `<proxy>/p/<provider-id>`, and reaches its
  own configured endpoint with its own key. Nothing is translated between wire protocols — the remote
  speaks the dialect its own profile names, to the endpoint that profile names.
- **`ModelCredentialProxy` takes a route table instead of one upstream.** A route with an empty id is the
  catch-all that keeps the DeepSeek path byte-for-byte identical; a named route answers `/p/<id>/…` and
  uses its own upstream base path and key. An unknown `/p/<id>` answers `404` and contacts no upstream,
  because falling back to another provider would bill the wrong account and return another vendor's
  answer.
- **`mirrorLocalProviders` / `mirrorProviderIds`.** The first turns the projection off (default `true`);
  the second publishes a subset. A provider with no `apiKeyEnv` — OAuth or cloud-metadata auth — has no
  key to forward and is skipped with a warning rather than given an invented one.
- **`HostInfo.modelRouteIds`.** The remote reports the provider routes its live `llm` registry
  resolves, so a refused or ignored overlay is visible as a different set instead of as a prompt failing
  later. The field is optional, so `PROTOCOL_VERSION` stays `1` and an older agent keeps working.

### Changed

- **Installing remote Node.js is one menu click, and the label now says so.** The host card's detail
  pane carried a **远端 Node.js** button that opened a panel, which meant the action sat behind two
  disclosures (expand the card, then open the panel) and, in the common case, answered "already
  satisfied, nothing to install". It is now `⋯` → **安装远端 Node.js** / **Install remote Node.js**,
  the same shape as **重新安装远端 agent**: the host probes, installs nvm plus the latest LTS only
  when the probe says the current runtime will not do, and reports the outcome as a status line on
  the card. The word "manage" described the panel rather than the result, and it disagreed with the
  provisioning errors, the README and the bootstrap script, all of which already named **安装远端
  Node.js**; "reinstall" would be wrong in the other direction, because the installer adds a
  version-managed runtime and never replaces the one the account has. `host/node` (the read-only
  probe) is gone with the panel that was its only caller — the verdict now travels on the host view
  as `HostView.node`, so a run that outlives a page reload still reports itself. A failed runtime
  install leaves a connected host connected instead of moving it to `error`.
- **The installer writes a profile overlay and passes it to `dsh web`.** The projection is rendered as a
  patch list (`$DSH_HOME/waypoint-agent/model-routes.json`) and added to the systemd unit and the nohup
  launcher as `--patch`. It is JSON — a subset of YAML 1.2, so a valid patch list — because hand-building
  YAML would have to escape display names, descriptions and arbitrary headers, and the first missed case
  would corrupt a provider instead of failing loudly. It reaches the host base64-encoded so no
  operator-authored byte can be read as shell syntax. An empty projection removes a previously written
  file, which is what switching a host back to direct mode needs.
- **A proxied host stops offering providers configured on the remote itself.** A patch layer replaces a
  row's whole `config` rather than merging into it, which is what makes "the remote list is the local
  list" true. `mirrorLocalProviders: false` restores the previous behaviour.
- **Publishing a dev-server port is now a click.** Settings → **Remote development** → **Remote ports**
  is gone, along with `remote_port_forward`, `remote_ports_list` and `remote_port_forward_remove`. In a
  Session mirrored from a remote host, clicking a loopback address in the transcript publishes that port
  on local loopback and opens the page in the sidebar Browser tab. A forward only makes sense on the
  machine holding the SSH connection — the same machine that draws the browser — so the tool family could
  never be called by the Session that needs the port, and the remote agent has no route to create one.
- **The published set is memory-only.** `HostRecord` no longer carries `forwards`, and a registry written
  by an earlier build still loads because the field is ignored rather than validated. A restart or a
  reconnect clears the set and the next click republishes, so there are no rows left for a user who no
  longer remembers asking. The host's expanded row in Settings lists what is currently published, which
  is also where a refused bind explains itself.
- **One `ssh` child per published port**, instead of one per host carrying every `-L`. A running `ssh`
  cannot gain a `-L`, so the old shape restarted the first port's child whenever a second was published,
  dropping any page already reading through it. That was tolerable when publishing was a deliberate visit
  to a card; it is not when it happens during ordinary use.
- **`host/ports` and `host/ports/remove` are gone**; `host/ports/add` became `host/ports/publish`, which
  takes no local port and answers with one row. `parseLoopbackUrl` accepts a scheme-less `localhost:5173`
  as well as `http://…`, because `new URL('localhost:5173')` parses as scheme `localhost:` with an empty
  host and a base argument does not change that.
- **`install-local` installs into the `desktop` profile instead of printing instructions.** It used to
  pack, print a tarball path and stop, leaving a second manual step, because `dsh plugin --profile
  desktop` is refused at argument parse time. That refusal is fed by a boolean parameter of the exported
  `runCli(options)`, so the script imports it and passes `manageDesktopProfile: true`: the install then
  runs through the Host's own `runProfilePnpm`, including the file lock, the compatibility preflight and
  the `reconcile` step that registers the bundle. Nothing is reimplemented. Two platform facts shape
  the implementation: only the application's runtime can read inside `app.asar`, so the script
  re-executes itself under it when started with plain Node; and a bare Windows path is refused by
  `import` with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, so the CLI is imported through a `file://` URL. The
  packed tarball travels in `DSH_INSTALL_TARBALL` because spawning pnpm from that runtime fails on
  Windows. Quit DSH before installing: a running Host holds the plugin files that pnpm renames.
- **`install-local.sh` is now `install-local.mjs`.** A shell cannot do this portably on Windows — `node`
  need not be on its PATH, a Windows Node can lose stdout through a WSL command substitution, and the
  resulting `/mnt/c/...` path is unreadable to the Host — and the desktop install needs to become the
  application's own process, which a shell script cannot arrange for itself.
- **`test-sandbox.sh` is now `test-sandbox.mjs`** for the same reason, and it is the one documented
  command for an isolated environment. Four shell idioms each failed on Windows: `mktemp -d`,
  backgrounding with `&` plus `kill`, polling a log with `grep -o`, and a heredoc. The replacement
  compares resolved paths before adopting a `DSH_HOME` (so `~/.dsh/../.dsh` and a case difference are
  still refused), spawns the host without a shell — one would split a path containing spaces — and
  stops it on exit, including the shim's grandchild on Windows. It reports the tokenized URL it waited
  for and writes the `test-visibility.json` manifest rather than deleting test workspaces.

### Fixed

- **The changed-files card was empty for every mirrored turn.** Two independent defects, both found
  by driving the real mirror code against a live remote checkout. The prefetch that fills the card's
  synchronous cache ran *before* the append that records `localSeq -> turn`, so it looked up a
  mapping that did not exist yet, resolved synchronously, and cached nothing; and the live event
  stream never prefetched at all, so a turn produced after the mirror attached could not get a card
  even in principle. The fetch now takes the remote coordinates from the caller, and both arrival
  paths await it before projecting — which is what makes "the summary is already present once the
  event is visible" true rather than merely intended. A turn already in the cache is not re-fetched,
  so a replay costs one round trip per turn, and a host that never answers delays the event up to
  `PREFETCH_TIMEOUT_MS` and then degrades to no card rather than to a lost event.
The Forge panel could not read Git information for any mirrored workspace, and the three defects
below had to be fixed together for it to work at all.

- **The agent refused every command the panel sent.** `gitIn()` never emits a bare subcommand: it
  builds `[git, --no-optional-locks, -c core.hooksPath=…, -c core.fsmonitor=false, …args]`, and its
  diff argv adds `-c core.quotePath=false` before the subcommand. The bridge read `args[0]` as the
  subcommand, so the very first `rev-parse --show-toplevel` was refused as
  `git subcommand "--no-optional-locks" is not permitted` and the panel could only render
  **Git information could not be read**. The argv is now parsed the way Git parses it: leading
  global options, then the subcommand. `show-ref`, `config` and `hash-object` were also missing from
  the allowlist and are now allowed, which is what the branch listing, filter overrides and
  empty-tree comparison need.
- **Global options are forwarded, not just tolerated.** `-c`, `--config-env`, `--work-tree` and
  `--git-dir` now reach Git, because they carry real semantics: dropping `core.quotePath=false`
  corrupts every non-ASCII path in a diff, and dropping `--work-tree` aims a worktree `reset` at the
  wrong checkout. The agent's own `-c` for hooks and the filesystem monitor comes after the caller's,
  so its settings still win.
- **The allowlist no longer pretends to be a security boundary.** It gained `check-ref-format`,
  `worktree`, `reset` and `add`, so the worktree service and change recorder work on a mirrored
  workspace instead of throwing. Narrowing argv never contained anything: the agent already exposes a
  full PTY, and a repository's own `.git/config` runs programs through an ordinary `git diff`
  (verified on a real host — a `.gitattributes` rule plus `filter.<name>.clean` executes), so the
  gate is about clear errors, not safety. `env` likewise drops only client-local path variables
  (`PATH`, `HOME`, `TMPDIR`, …) that cannot mean anything on a Linux remote, and forwards the rest.
- **A repository without `.gitattributes` failed every diff.** The Forge panel reads that
  optional file inside `try/catch` and tolerates only `FsError` + `FS_NOT_FOUND`, while the
  adapter rethrew the protocol's `workspace-file/not-found`. The result was a changed-files view
  that worked only on repositories that happened to have the file. `stat`, `lstat` and the stat
  `readBytes` performs now map that code, and a failure that is not "not found" still propagates.
  Found by driving the Forge panel's own code against a real remote checkout
  (`scripts/e2e-review/`); the unit tests only ever read files that exist.
- **Path interception only knew the local anchor.** The first inspection canonicalizes the paths Git
  printed, so from that point on the panel works in the *remote* namespace: its runner's `cwd` is the
  remote checkout and each changed file is read relative to it. `subprocess.spawn` did not recognize
  that `cwd` and fell back to the local provider, `fs.resolve` handed the panel a local path for
  `--show-toplevel`/`--git-common-dir`/`--git-dir`, and `sandbox.confine` did not treat the remote
  root as mirrored. `RemoteMirrorService.remoteContextForRemotePath` is the remote-namespace lookup
  all three now consult alongside `remoteFileContext`.
- **A remote path no longer decides which host owns it.** The remote-namespace lookup above matched
  the first workspace whose `remoteRoot` was a prefix of the path, which is not the same question as
  "which host owns this". A host that once ran a Session from a home directory keeps an `ungrouped`
  workspace rooted at that whole directory, so it encloses every checkout on every host. The
  changed-files card then vanished for a mirrored workspace: its `forkPoint()` command is the only one
  in an inspection that starts from the remote path rather than the anchor, it was attributed to the
  enclosing host, and `git` cannot start in a directory that host does not have — reported as
  `spawn git ENOENT`, which reads like a git failure but means the process never started.

  Attribution now has three layers, and each removes a different false answer:

  1. **`ungrouped` workspaces never answer it.** Their root is the directory a Session happened to
     start in, not a checkout, so `/data/home/user00` no longer claims every project beneath it. They
     still host Sessions and still count for confinement, which asks a different question.
  2. **An exact `remoteRoot` beats an enclosing one**, which is the shape that matters: `forkPoint`
     passes the canonicalized checkout root verbatim, so the workspace it belongs to matches exactly.
  3. **A genuine tie between two real workspaces is settled by the Session that asked.** Two hosts
     really can serve the same absolute directory, and then no string is decisive. A mirror Session's
     `header.cwd` is its anchor, and an anchor maps to exactly one host, so `subprocess.spawn` —
     which carries no Session of its own — reads the anchor recorded when Forge resolved that
     Session's sandbox policy, one synchronous step earlier.

  `remoteContextForRemotePath(path, hostId)` still takes the host as a required input;
  `resolveHostForRemotePath` narrows a path to a single host, and `ownsMirroredRemotePath` answers the
  separate "does any mirror claim this" question confinement needs. A path that survives all three
  layers still raises with the directory named, rather than falling back to another host or to the
  local provider — the fallback that used to make "which host?" look like "not a mirrored workspace".
  See [docs/mirror-host-resolution.md](docs/mirror-host-resolution.md).

## 1.1.0

### Added

A mirrored workspace now answers the two native review surfaces, with no UI change.

- **Forge panel — Local changes.** The panel runs every Git query through `ctx.subprocess` and reads
  file contents through `ctx.fs`; both now route a mirrored workspace to its remote checkout, so the
  branch/fork-point view, the changed-file list and per-file diffs describe the remote repository
  instead of the empty local anchor. `remote/sandbox.ts` returns argv unchanged for those commands
  because a locally confined argv names a wrapper the remote host does not have.
- **Changed-files card.** `workspaceChanges.summary` is synchronous and addressed by the local event
  sequence, while the record lives in the remote process; the mirror now fetches the summary just
  before it appends the announcing event, so the card has its data the moment it renders. `diff`
  round-trips on demand.
- The remote agent gains two capabilities, `git.exec` and `workspace.changes`. `git.exec` is a
  read-only Git bridge with a subcommand allowlist, **not** a general remote exec: a non-`git`
  `argv[0]` is refused locally, and the agent refuses anything outside its allowlist. An agent that
  predates this change reports `error.agentOutdated` and Settings offers **Reinstall**.
- Summaries are not persisted. Cross-restart behaviour matches the local experience exactly, except
  that a local restart while the remote DSH still runs keeps its change cards — a case the local
  workspace cannot offer.
- Open a remote dev server in the right-sidebar browser. The native browser renders pages on this
  machine, so `http://localhost:5173` typed there reaches a server here, not on the remote host — and
  unlike files and terminals there is no Host service to shadow, because
  `dsh-client-ui-sidebar-browser` has an empty Host half and navigates with the client's own `loadURL`.
  Settings → **Remote ports** now publishes a remote loopback port on this machine's loopback through the
  existing SSH transport (`ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`), so the unmodified browser
  loads the remote page. The same port number is preferred, which is what keeps a dev server's own
  absolute links working; when that number is taken locally an ephemeral port is used and the card warns,
  while an explicitly requested busy port is reported as an error rather than silently moved. The forward
  is raw TCP, so WebSocket and HMR work, and it rides its own ssh child so adding a port never restarts
  the agent tunnel the session mirror follows. Desired ports persist on the host record and are restored
  on reconnect; a failed forward turns only its own row into `error` and leaves the host connected.
  `remote_port_forward`, `remote_ports_list` and `remote_port_forward_remove` expose the same three
  actions to an agent — ungated, because a forward copies no credential. Disable with
  `portForwarding: false`.
- Search a remote workspace from the native file panel. `POST /files/search` joins the agent's file
  surface (`file.search` capability) and the host-side adapter, so the panel's search box answers from
  the remote tree instead of the empty local anchor. Matching follows the Host's own rules — a query
  without `/` matches an entry name at any depth, one with `/` matches a workspace-relative path — and
  the result keeps `truncated` and `incomplete` separate, because a walk stopped by its budgets must
  not be presented as "no results". The walk never follows a symlink and never leaves its root.
- Report a broken file-routing contract instead of showing an empty tree. The install step compares the
  live `workspaceFiles` service against the methods the adapter replaces, names any that are missing in
  the log, and exposes `fileRouting` in the state the Settings page reads. The adapter also now returns
  a restorer that runs inside `ctx.effect`, deleting only the own properties it created.
- Drop the `dsh-better-sidebar` integration. The native **Workspace files** panel already browses a
  remote workspace without it, so the extra tab, its stylesheet, its glyph map, its tests and its copy
  were dead weight in any profile that did not install that plugin.


### Fixed

- **Remote terminals work again.** The bundle disabled the stock `terminal-controller` row and mounted a
  bundled fork in its place, but the fork imported `@deepseek-ai/dsh-api-terminal-controller`, a name the
  Host only resolves for packages inside the profile's dependency closure. On a real installation the
  fork failed to load, and because the stock row was disabled nothing provided the `terminalController`
  service at all — so every terminal method was absent, not merely routed to the wrong machine. The
  support rows are gone and the stock row is left enabled: terminals are routed by patching that service
  per method, which is the same mechanism the file tree already uses. This also removes the build step
  that rewrote DSH's minified client artifact with a regex — the most fragile coupling in the repository
  and the one most likely to break on a DSH upgrade.
- **The terminal patch covers every method the Host exposes.** `openForAgent`, `readScreen` and
  `inspectActivity` were left to the stock implementation, so an Agent working in a mirrored
  workspace would open a terminal on the *local* machine, and read its screen from the local
  emulator. `openForAgent` now allocates through the remote agent, `inspectActivity` answers
  `unknown` (which the contract allows), and the two screen readers refuse with
  `terminal/unavailable` rather than returning an empty page an Agent would read as "no output".
  A test compares the installer's method list against the Host's own Remote face, so a DSH release
  that adds a terminal method fails in CI instead of silently serving it locally.
- **Provisioning no longer fails on a host whose `pnpm` is a corepack shim.** A Node.js distribution
  puts `bin/pnpm` in place as a symlink into corepack, and `npm install --global --prefix <prefix>
  pnpm@X` refuses to replace it (`EEXIST`), which surfaced as `install/pnpm-missing` and told the
  operator to delete the link. Deleting it takes corepack away from every other project in the
  account, so the installer now prepares the pinned version through `corepack prepare --activate`
  and leaves the link untouched. A pnpm already installed in the prefix is still preferred — npm
  installs it as a symlink too, so the check is where the link resolves, not whether one exists.
  A host with neither still installs one; the failure message now names both recoveries instead of
  only the destructive one.


## 1.0.1

Re-publish of 1.0.0 with a tarball that actually exists.

`dsh-waypoint@1.0.0` reached the registry with its metadata intact but its tarball answering 404:
`npm publish` exited 0, the version appeared in the packument, and `npm install` could not fetch it.
A published version cannot be republished, so this is the same tree released under a new patch
version. The plugin, the remote agent and the terminal controller are otherwise unchanged.

Publishing runs on a maintainer's machine with `pnpm release:publish`, which builds, packs, publishes
dependency-first, and **downloads every published tarball before reporting success** — the check that
would have caught 1.0.0. The `Release` workflow builds and attaches the GitHub release assets and does
not touch npm.

- Offer a deliberate **install remote Node.js** action instead of dead-ending on a missing runtime.
  Provisioning still never installs one (`exit 21`/`exit 22`), but the expanded host card now probes
  the remote first and then, on confirmation, installs nvm `v0.40.1` and the latest Node.js LTS
  (`nvm install --lts`). nvm's installer runs with `PROFILE=/dev/null`, so no shell startup file is
  modified; the card prints the snippet to add yourself. The finished panel offers **Reinstall**
  because the running DSH keeps its old runtime until provisioning reruns. The action never rewrites
  your `nvm alias default`, so the Node.js your own shells use is untouched; DSH resolves `lts/*`
  directly. Verified end to end on a real host: from no nvm and no Node.js, and on a host where a
  newer LTS already satisfied the minimum (nothing changed).
- Stop retrying failures a retry cannot fix. A host with no Node.js, an outdated one, no npm, or a
  profile that refuses migration is recorded as blocked: reconnecting no longer re-uploads the agent
  and reruns the bootstrap every 30 seconds, the card keeps the real cause instead of a later
  timeout, and the "retrying, attempt N" line stops growing. Transient failures still retry, now
  bounded by the new `provisionRetryLimit` (default 3). **Reinstall** clears the block.
- Prefer the nvm Node.js over an older system one during provisioning, so reinstalling after an
  install actually switches the runtime instead of silently reusing the old `node`.

## 1.0.0


The project is now maintained independently as **`dsh-waypoint`**, a fork of
[`Golden-Pigeon/dsh-remote`](https://github.com/Golden-Pigeon/dsh-remote). The upstream attempt to
merge these changes back was declined, so the work continues here under its own name. History and
authorship are preserved unchanged; thanks to `@Golden-Pigeon` for the original implementation.

Renaming a DSH bundle renames the identity DSH persists, so **this is not an in-place upgrade of
`dsh-remote-local-plugin`** — the two installs coexist and neither reads the other's state:

- Packages: `dsh-remote-local-plugin` → `dsh-waypoint`, `@goldenpigeon/dsh-remote-agent` →
  `dsh-waypoint-agent`, `dsh-remote-terminal-controller` → `dsh-waypoint-terminal-controller`.
  Workspace-only packages: `@dsh-remote/*` → `@dsh-waypoint/*`.
- On-disk identity: `$DSH_HOME/remote` → `$DSH_HOME/waypoint`, `$DSH_HOME/remote-agent` →
  `$DSH_HOME/waypoint-agent`, and the systemd user unit `dsh-remote-agent.service` →
  `dsh-waypoint-agent.service`. `docs/operations.md` describes the manual move for anyone switching
  over; nothing is migrated automatically, because a half-migrated host registry is worse than an
  empty one.
- Transport identity: `/api/dsh-remote` → `/api/dsh-waypoint`, the agent API prefix
  `/dsh-waypoint-agent/api/v1`, and the `x-dsh-waypoint-*` request headers. A remote host keeps
  answering the old protocol until its agent is reinstalled; Settings offers **Reinstall** for
  exactly that case.
- Loader rows: `dsh-remote-local` → `dsh-waypoint`, `terminal-controller-remote` →
  `terminal-controller-waypoint`. On its next run the installer also removes a leftover upstream
  `dsh-remote-agent` dependency from the remote profile, so the profile holds one agent rather than
  two. It does **not** stop an upstream `dsh-remote-agent.service` that is still running: that unit
  belongs to the old install, and `docs/operations.md` walks through disabling it — until you do, the
  old agent keeps answering on the same remote host.

Everyone else keeps their state: an install of this version starts from an empty host registry.

Previously, in the 0.8.x line:

- One source of truth for the minimum Node.js version and the shell check that enforces it
  (`node-runtime.ts`), so the bootstrap, `doctor`, and the localized message cannot disagree.
- Fix the documentation, which claimed in one place that the installer downloads a Node.js tarball
  "when needed" and in another that it never installs one. `docs/operations.md` now describes the
  actual behaviour, including the new install action.
- Report a failed `npm install pnpm` as its own cause (new bootstrap `exit 25`,
  `install/pnpm-missing`, localized as `error.agentInstallNoPnpm`) instead of the
  generic "installing @deepseek-ai/dsh failed, or the installed dsh cannot start".
  dsh is installed *after* pnpm, so a pnpm failure means dsh was never attempted;
  the old message sent operators to the wrong prefix, the wrong Node.js version and
  the wrong log line. The common trigger is a host that ships corepack: `bin/pnpm`
  and `bin/pnpx` are symlinks into corepack, and npm refuses to replace them
  (`EEXIST`) without `--force`. The bootstrap now names that fix on stderr.
- Add `--dry-run` and `--keep-tracked` to `pnpm clean`, and warn when a removal would delete a file
  git still tracks. `lib/` is gitignored, but a file git already tracks stays tracked after the
  ignore rule appears, so a plain clean could leave an unrelated deletion staged for the next commit.
- Type-check and test `scripts/` alongside the packages. `scripts/tsconfig.json` runs `allowJs` +
  `checkJs` over the directory, `scripts/*.test.mjs` cover the package-manager resolver and the
  development-version shape, and CI now runs the root `pnpm typecheck`/`pnpm test` — the previous
  `pnpm -r` form skips the root package, so none of this ran there.
- Stamp local plugin builds with a unique `<version>-dev-<timestamp>` prerelease.
  A package manager keys an install on the dependency version and the recorded
  tarball integrity, so rebuilding at a constant version and path left the
  profile's already-unpacked files in place: the plugin reported as installed
  while still running the previous code. `scripts/release-plugin.mjs --release`
  keeps the manifest version for publishing, and development builds now delete
  each other instead of accumulating.
- Install the remote `dsh` and `pnpm` into the npm global prefix instead of a
  private `$remoteInstallDir/node_modules`, so the `dsh` the plugin starts and
  the `dsh` an operator types are one file at one version. The prefix is
  `remoteGlobalPrefix` when set and `npm prefix -g` otherwise; there is no
  fallback location, because a silently relocated command is the divergence
  this removes. Both installs now run on every provisioning run and the result
  is verified by executing `dsh -V` rather than by inspecting paths. A prefix
  that is not on the login shell's `PATH` gets one printed `export PATH=…` line
  — no shell startup file is edited. An existing global `dsh` at the prefix is
  replaced with the requested version.
- Report the remote DSH version from the installer (`DSH_WAYPOINT_DSH_VERSION`),
  so "Update remote DSH" compares real versions instead of `unknown`.
- Offer the remote host's models in the model menu for mirrored Sessions, by
  merging them into the shared per-Session model directory. Every selector
  reads that directory, so the rows appear for the native composer seat and for
  a skin that draws its own menu; a model the remote alone serves
  (`deepseek-v4-pro`, for example) can be chosen directly instead of falling
  back to the remote default. A mirrored Session lists only what the remote can
  run — a local provider there is a choice that cannot be honoured, because the
  prompt is executed on the remote Host — and it starts on the remote catalog's
  own default instead of this machine's. The contributed section is labelled
  `Remote · DeepSeek`, because a remote provider is usually named after the same
  vendor as a local one. When the remote catalog is unreachable or advertises
  nothing, the list stays empty rather than borrowing this machine's providers:
  a local model cannot run there, so offering one would hide the failure behind
  a choice that silently degrades, and a local pick is refused instead.
  Picking a remote one installs the selection on the mirror over
  the existing bridge, and a Session that is not a mirror keeps exactly the
  Host's own list.

- Serve the remote host's model catalog over `llm.catalog` and show it in
  Settings. A mirrored Session now checks a model selection against that
  catalog before sending, so a selection the remote cannot route to no longer
  costs a rejected round trip.
- Deliver a prompt whose model selection the remote host cannot serve, instead
  of failing silently. The remote agent now reports the rejection as
  `session/model-unavailable` rather than a generic `internal` error, and the
  local plugin resends the prompt once without the unusable selection and
  remembers it so later messages skip the failing round trip.
- Add `session/model-unavailable` to the protocol error taxonomy (HTTP 400,
  not retryable).


## 0.8.21

- Provision new remote hosts with the local DSH runtime version by default.
  `remoteDshVersion` still supports pinning a specific remote version, and the
  Settings "Update remote DSH" action still upgrades existing hosts; no remote
  is upgraded automatically
  ([#29](https://github.com/Golden-Pigeon/dsh-remote/pull/29)).
- Test and document DSH 0.2.2-rc.3 for the desktop client and remote runtime,
  including the Playwright suite.

## 0.8.20

- Support DSH 0.2.2-rc.2 only: require `>=0.2.2-rc.2 <0.3.0-0` through
  `engines.dsh`, align peer ranges, runtime defaults, CI, and docs, and drop
  older DSH support.
- Rebuild the terminal-controller fork client from the rc.2 artifact, route the
  rc.2 `watch`/roster face for mirrored Sessions, and keep mirror retain streams
  open so rc.2 no longer reports "This terminal no longer exists".
- Use the remote account's login shell for mirrored terminals (passwd shell,
  fallback `$SHELL`, then `/bin/bash`); the bundled remote agent is `0.2.12`.
- Add mirrored-terminal and install/upgrade Playwright coverage plus
  login-shell and client-bundle unit tests
  ([#28](https://github.com/Golden-Pigeon/dsh-remote/pull/28)).

## 0.8.19

- Keep first-time remote provisioning running on hosts without Node or nvm.
  The nvm probe no longer aborts the bootstrap before the configured Node
  auto-install step; verified on an isolated host with no Node
  ([#20](https://github.com/Golden-Pigeon/dsh-remote/issues/20),
  [#24](https://github.com/Golden-Pigeon/dsh-remote/pull/24)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Browse mirrored workspaces from Windows clients. Remote POSIX roots stay
  POSIX while the local anchor keeps Windows paths, so `/home/ubuntu` is no
  longer sent to the remote agent as `C:\home\ubuntu`
  ([#21](https://github.com/Golden-Pigeon/dsh-remote/issues/21),
  [#25](https://github.com/Golden-Pigeon/dsh-remote/pull/25)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Show mirrored approvals instead of answering them unavailable before the user
  can see them. Approval requests wait until the mirror runtime exists and a
  client is showing the Session, then use the native approval UI. Replayed
  requests are deduplicated, and a two-client E2E test covers one client
  answering while the other dismisses
  ([#22](https://github.com/Golden-Pigeon/dsh-remote/issues/22),
  [#27](https://github.com/Golden-Pigeon/dsh-remote/pull/27)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Restore gateway terminal endpoints for third-party clients when the
  terminal-controller fork replaces the stock row. The fork now exports its own
  Typert host face and routes gateway terminals for mirrored Sessions through
  the remote PTY; the bundled terminal-controller is `0.1.3`
  ([#23](https://github.com/Golden-Pigeon/dsh-remote/issues/23),
  [#26](https://github.com/Golden-Pigeon/dsh-remote/pull/26)).
  Thanks [@simonsysun](https://github.com/simonsysun)!

## 0.8.18

- Replace the private DSH current-session field with the public
  `uiSession` current binding, so the claim focus guard does not depend on
  private workspace UI state
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).
- Archive remote Sessions left behind when a native draft promotion or blank
  materialization fails before its local mirror exists. The remote agent now
  exposes an archive route, filters archived Sessions from workspace/session
  lists, and ships as `0.2.11`
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).
- Add protocol, agent HTTP, mirror lifecycle, and client bundle coverage for the
  archive and focus-guard paths
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).

## 0.8.17

- Support DSH 0.2.2-rc.1: align the Cordis dependency line, adapt the branded
  reasoning-effort type, and test both DSH 0.2.1-rc.5 and 0.2.2-rc.1 in CI
  ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).
- Provision remote DSH 0.2.2-rc.1 by default. The updated agent was verified on
  two real remote hosts, including workspace discovery, session creation, and a
  first prompt through an isolated local profile
  ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).
- Update the Playwright harness and testkit fixtures for the current DSH package
  line ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).

## 0.8.16

- Restore native mode and model selection for new remote sessions. Mirrored
  workspaces now open a process-local Lazy draft in DSH's native blank surface;
  the first prompt creates the remote Session and forwards the selected preset,
  model, and prompt content. Failed promotion retries reuse the same remote
  Session and never silently fall back to local execution
  ([#17](https://github.com/Golden-Pigeon/dsh-remote/pull/17)).
- Keep workspace `+`, global New Session, local-workspace fallback, workspace
  add/delete, host-disconnected failure, and two-window claim behavior covered by
  Playwright E2E tests. Add testkit failure controls and fake directory listings
  ([#17](https://github.com/Golden-Pigeon/dsh-remote/pull/17)).

## 0.8.15

- Route remote files, directories, and terminals through the remote agent's authenticated APIs
  over the existing single SSH tunnel. Remove per-operation SSH file/terminal/directory fallbacks
  and ControlMaster plumbing; older agents must be reinstalled to expose the new capabilities
  ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).
- Localize host detail/status and error messages with stable codes and parameters, and avoid
  reporting a remote workspace creation as failed while its local mirror is still settling
  ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).
- Verify the installed remote agent version during provisioning, avoid false version-mismatch
  failures while the agent process is restarting, and validate deterministic prerelease
  packaging before release ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).

## 0.8.14

- Restore native model selection and remote-mirror lifecycle ownership for persisted mirrors:
  implement the façade model operations, assign Agent scopes, await teardown, and block native
  resume until persisted mirror mappings load. CI now verifies both DSH rc.2 and rc.3
  ([#13](https://github.com/Golden-Pigeon/dsh-remote/pull/13)).
- Keep locally removed mirrored remote workspaces removed across discovery, restart, and reconnect.
  Local Sessions are archived instead of appearing under Ungrouped, remote execution and approvals
  continue, and an explicit re-add restores local history, including when the remote workspace id
  changes ([#14](https://github.com/Golden-Pigeon/dsh-remote/pull/14)).
- Correct the native workspace-delete description for mirrored workspaces so it says Sessions are
  archived locally rather than moved to Ungrouped
  ([#14](https://github.com/Golden-Pigeon/dsh-remote/pull/14)).
  Thanks [@samwei12](https://github.com/samwei12)!

## 0.8.13

- Detect an outdated remote DSH runtime and offer a manual, non-blocking update from Settings.
  The installer replaces the remote runtime, restarts the service, and reconnects
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).
- Show the retry attempt, countdown, and failing stage during reconnects, and keep transient host
  API failures from overwriting the install/connect status
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).

## 0.8.12

- Tolerate approval-stream heartbeat events and recover a mirrored turn abandoned by a remote host
  restart, so approvals keep reaching the local UI after reconnects
  ([#1](https://github.com/Golden-Pigeon/dsh-remote/issues/1),
  [#2](https://github.com/Golden-Pigeon/dsh-remote/issues/2),
  [#3](https://github.com/Golden-Pigeon/dsh-remote/pull/3)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Coalesce concurrent mirror creation per remote Session, preventing duplicate local rows for one
  remote Session
  ([#4](https://github.com/Golden-Pigeon/dsh-remote/issues/4),
  [#5](https://github.com/Golden-Pigeon/dsh-remote/pull/5)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Mirror remote subagent Sessions as local subagent children of their mirrored parent instead of
  hiding them. A mirrored parent transcript carries the remote `subagent/catalog`, so opening one of
  its subagent conversations previously failed with `subagent/not-found`. Children keep the remote
  Session id, never attach to a Workspaces row, and are pruned only when the remote stops reporting
  them. A child whose mirror window lost its `subagent/descriptor` is skipped with a warning
  ([#8](https://github.com/Golden-Pigeon/dsh-remote/issues/8),
  [#9](https://github.com/Golden-Pigeon/dsh-remote/pull/9)).
  Thanks [@NoidLiu](https://github.com/NoidLiu)!

## 0.8.11

- Stop mirroring internal remote context messages (`compact-checkpoint`, `agent-instructions`,
  `runtime-context`, `skill-catalog`) as if they were user prompts. A large checkpoint previously
  stalled the local mirror and left the live transcript behind.
- Drop late Assistant stream chunks once the matching durable `assistant/message` has been appended.
  The poll and stream channels can arrive out of order; injecting a late transient chunk after the
  durable message made the client conversation assembler fail with `non-appended Match` and stop its
  live event feed until the user switched Sessions.
- Renumber forwarded Assistant chunks and their terminal index so the client's `nextIndex` matches
  the end frame after transient `tool-call-delta` chunks are omitted.
- Remove the turn-end synthetic Assistant settlement; durable step/turn boundaries are authoritative.

## 0.8.10

- Support mirroring remote Sessions longer than the remote snapshot window by seeding from the first
  complete turn in the available tail. Local history starts from that turn; older remote history stays
  in the remote Session.
- Treat remote surface replacement events as local appends, both during seed and live mirroring. A
  replacement range refers to the remote log and can target a node omitted from the local mirror,
  which previously poisoned the local surface projection and made history fail to load.
- When a poll finds the remote log has advanced past the mirror window, skip to the available tail and
  continue mirroring instead of stopping the mirror.

## 0.8.9

- Forward image attachments from a mirrored prompt to the remote Session, including ordered text
  and image content. The remote agent admits the images through the remote DSH attachment store.
- Allow the remote file adapter to open any absolute remote path, not only paths under the mirrored
  workspace; remote transcript links and editor paths can now read arbitrary host files.
- Increase the remote prompt request body bound for normalized image payloads.
- Publish the mirror Agent as running as soon as a remote `turn/start` arrives, so a session opened
  while its remote turn is active exposes steering instead of a disabled submit control.
- Start the remote workspace folder picker at the account's home directory (`~`) instead of the
  remote DSH home (`.dsh`).
- Keep a typed trailing slash in the workspace folder picker while navigating into a subdirectory.
- Publish a local `agent/error` when a mirrored prompt cannot reach the remote host instead of only
  logging the failure.
- Never fall back to creating a local Session when the native New Session action targets a
  mirrored remote workspace and the host is unavailable; show an error instead.
- Read normalized image metadata from the attachment reference returned by `readImage` (`ref.mediaType`),
  fixing remote image prompts being rejected as an invalid content part.
- Map Assistant stream `startedAfterSeq` from remote to local sequence numbers instead of dropping it;
  the client needs the local boundary to settle the final Assistant message.
- Remap `developer/message.headerSeq` from remote to local sequence numbers; a stale header reference
  previously stopped the mirror mid-turn and left the UI waiting forever.
- Keep queued/steer messages in the mirror Agent's local pending inbox while a remote turn is
  running. Pressing Enter no longer forwards them immediately; edit/delete and the steer arrow are
  resolved by the local inbox, and queued next-turn messages are forwarded when the remote turn
  completes. Aborting a turn clears the pending inbox.
- Preserve each remote Session's original `createdAt` when recreating its local mirror Session after a
  restart, so the sidebar no longer shows every restored remote session as "now" and time ordering
  remains stable.

## 0.8.8

- Forward a mirrored Session's `sandbox/mode` change to its remote Session instead of only updating
  the local projection, so switching a remote Session to `danger-full-access` takes effect on the
  remote Bash/filesystem sandbox.
- On reattach, compare the local and remote sandbox modes and repair a previously unsynchronized
  mode once.
- Add the remote agent `POST /sessions/:id/sandbox` endpoint with strict mode validation.

## 0.8.7

- Hide remote subagent Sessions from the Workspaces sidebar and remote session picker. The remote
  agent now projects `origin: "subagent"` / `parentSession`, and the local mirror archives any
  subagent sessions created by earlier releases. Remote subagent data and logs are left intact.

## 0.8.6

- Automatically migrate a legacy `dsh-waypoint-agent` entry out of the remote DSH profile during
  Reinstall. The installer backs up `package.json` and the stale lockfile, removes the old dependency
  and bundle entry, then installs the scoped npm agent. Existing remote plugins such as `dsh-mnemon`
  are preserved; no manual SSH profile editing is required.

## 0.8.5

- Add a **Restart remote DSH** host action and `remote_host_restart` agent tool. It restarts the
  installer-owned systemd unit, waits for the agent state file, and reconnects without reinstalling
  DSH or overwriting the remote profile. Nohup deployments still use Reinstall or a manual restart.
- Publish the remote agent as `dsh-waypoint-agent` and install it from npm before falling
  back to the bundled tarball.
- Keep the bundled agent artifact under the installer's persistent artifacts directory instead of a
  temporary `/tmp` path, so later plugin installations cannot break on a missing file dependency.
- Retain remote-only plugins such as `dsh-mnemon` when updating the remote agent.
- Hide remote subagent Sessions from mirrored workspaces and the remote session picker; existing
  subagent mirrors are archived during the next sync.

## 0.8.4

- Keep mirrored Session identity stable across plugin reloads and ended turns; reattach the runtime
  instead of recreating the local Session, stopping sidebar flicker.
- Stream remote Session events over SSE and forward dense Assistant start/chunk/end frames into the
  local Agent stream for token-level reasoning and text output.
- Suppress incomplete transient tool-call cards; durable tool results own the final card state.
- Publish `agent/status` transitions so the Stop control reflects the mirrored Agent's running state.
- Read the per-session model selection from the local projection/default and forward provider, model,
  and reasoning effort to the remote Session.
- Remap `sourceEventSeqs` and surface ranges from remote to local Session sequence numbers.
- Normalize remote absolute file paths and abort cancelled remote file reads.
- Propagate the remote proxy into the systemd/nohup runtime environment for model requests.

## 0.8.3

- Detect the remote installer proxy through the account's actual login shell, including zsh, fish,
  and other shell-specific login/interactive startup files, instead of hard-coding bash.
- Propagate the detected proxy into the remote systemd unit (and nohup process) so model calls use it
  after installation, not only package downloads.

## 0.8.2

- Use a remote-visible HTTP(S) proxy for installer downloads. The bootstrap reads
  `HTTPS_PROXY`/`HTTP_PROXY` from the remote login and interactive shells, and supports explicit
  `remoteInstallProxy`/`remoteInstallNoProxy` configuration.
- Include the last bootstrap stderr lines in provisioning failures.
- Show staged remote-install progress across upload, proxy, Node.js, pnpm, DSH, agent, service,
  state-file, tunnel, and health phases.

## 0.8.1

- Show staged remote-install progress in the host card: upload, Node.js, pnpm, DSH, agent,
  service start, state-file wait, tunnel, and health checks.
- Stream installer output into the local progress callback without exposing raw logs.

## 0.8.0

- Publish one installable `dsh-waypoint` package.
- Bundle `dsh-waypoint-terminal-controller` inside the plugin and merge its bundle patch.
- Add the DSH plugin-page installation path.
- Add online metadata, CI, release workflow, and release documentation.
- Harden systemd unit permissions, credential-proxy authentication, terminal fallback, approval
  gating, and remote file/terminal resource limits.

## 0.7.16

- Truncate oversized remote text lines and bound remote file page sizes.

## 0.7.15

- Use mode `0600` for the remote systemd unit that may contain a model key.
- Add per-host credential-proxy tokens and model-key fingerprint reconciliation.
- Refuse to fall back to a local terminal when a mirrored remote terminal fails.
- Bound terminal output queues and clean up aborted terminal waiters.
- Serialize mirror state writes.
- Bound installer output and handle stdin errors.
- Require approval for agent host-write tools.

## 0.7.14

- Add automatic remote Node.js discovery/install with checksum verification.

## 0.7.13

- Add live remote folder filtering and native local directory selection.

## 0.7.12

- Follow the DSH locale service with English/Chinese client copy.

## 0.7.11

- Add unified workspace creation and remote directory browsing.

- Default `dsh-waypoint-install --dsh-version` to `0.2.2-rc.3`, matching the
  tested desktop and remote runtime.
- Move the committed dependency baseline to DSH `0.2.2-rc.3`: every
  `overrides` and `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`, plus
  the regenerated `pnpm-lock.yaml`, so a fresh clone installs the same release
  CI tests instead of the previous one. The `engines.dsh` range already covered
  rc.3 and is unchanged.
- Run CI against `0.2.2-rc.3` instead of the stale `0.2.2-rc.2` baseline: one
  `verify` job installs the committed lockfile, re-pins every installed DSH
  package and peer to the workflow's `DSH_TARGET` with
  `scripts/select_dsh_version.mjs`, asserts the resolved version, and then
  builds, typechecks, tests, and packages. Bumping a DSH release means changing
  that one value. The run uploads both installable tarballs, the plugin bundle
  and the standalone remote agent, as a `dsh-waypoint-<DSH_TARGET>` artifact.

- Align the remote agent on connect instead of only flagging it. A connected
  host whose agent version differs from the bundled one is now re-provisioned
  automatically; previously only an *older* agent was marked in the UI, so a
  bundle that changed behaviour without a version bump was never corrected.

- Remove the browser-side `workspaceFiles` proxy. It rested on a false premise: that the Host binds
  generated Remote methods once at mount time. The Typert Gateway resolves them per call with
  `Reflect.get(receiver, method)`, so the host-side adapter alone reaches every caller. Dropping the
  proxy also fixes a real defect — it forwarded the wire JSON, handing `readBytes` callers a base64
  string where `WorkspaceFileBytes.data` is a `Uint8Array`.
- Stop `install-local.sh` from attempting the reserved `desktop` profile through a launcher that cannot
  manage it, and drop a pinned `dsh-client-ui-sidebar@0.2.2-rc.2` install from `test-sandbox.sh`: the
  `dsh-web-app` bundle already depends on that package at the profile's own version.

- Stamp the packed remote agent with a unique prerelease version by default, in
  the manifest and in the bundle's `AGENT_VERSION` together, so the runtime
  reports the version it actually ships. `--release` keeps the manifest version.
- Stop calling `dsh plugin remove` during provisioning. On a profile with many
  plugins it rewrote the manifest and then hung inside pnpm for minutes with no
  output, leaving `package.json` half-written. Re-adding a different spec
  replaces the dependency without it.
- Install only the uploaded agent tarball on the remote, never a registry
  package. `dsh plugin add <version>` resolves against the version recorded in
  the remote profile, so when the published `0.2.12` differed from the local
  build while keeping the same version number, the profile already satisfied the
  request: nothing was replaced, and a stale `cordis.patch.yml` kept disabling
  `dsh-api-remotes`, so the remote Web UI booted with `Failed to load plugins`
  while every install log reported success. The timestamped upload path makes
  each run's spec distinct, so the dependency really is replaced.
- Resolve Node.js through the account's own shell before choosing that prefix.
  A non-interactive SSH command does not read the startup files that nvm, fnm
  and Volta use, so a host with both a system Node.js and a version-managed one
  had the installer pick the system Node and compute a system-wide prefix —
  installing `dsh` where the operator's shell would never find it. The login
  shell is now asked first (login + interactive, falling back to login only), so
  `npm prefix -g` answers what the operator actually sees.
- Stop installing Node.js on the remote. It is now detected through the
  account's own shell (nvm/fnm/Volta included) and only verified; a missing or
  too-old runtime fails provisioning with an explicit message. Downloading a
  runtime silently picked a version the operator never chose, and left a second
  Node.js on hosts that already had one. `remoteNodeVersion`,
  `autoInstallNode`, and `remoteInstallDir` are removed with it.
- `dsh-waypoint-install doctor` reports the npm global prefix it would use, which
  of npm's two write targets are usable (`lib/node_modules` and `bin`), the
  `dsh` version that prefix yields, whether the login shell can find that
  command, and how many `dsh web` processes are running (two for one `DSH_HOME`
  overwrite each other's state file).
- Rebuild the Settings panel as a host list instead of nested cards. Each
  machine is one summary row with its details behind it, the rare and
  destructive actions move into an overflow menu, and every colour now comes
  from the Harness design tokens so the panel follows the active theme.
- Merge the aliases of one `Host` line into a single entry. A config such as
  `Host devcloud_64g_alice cloud64` used to appear twice, because grouping
  compared alias text; it now groups on the resolved target, shows the longest
  alias as the name, and tags the rest. A machine already registered under a
  sibling alias is no longer offered again.
- Choose the model-key source per host in Settings: `proxy` keeps the local
  `DEEPSEEK_API_KEY` on this machine and routes model requests back over the
  tunnel, `direct` lets the remote call the provider with its own key. The
  profile-wide `credentialProxy` setting now only seeds hosts that never chose,
  so existing hosts keep their behaviour.

- Add an "Open remote Web UI" action to each connected host in Settings, so the
  remote DSH Web UI (for installing remote plugins and similar) opens in a
  browser tab already signed in through the SSH tunnel.
