# @dsh-waypoint/installer

`dsh-waypoint-install` bootstraps `dsh-waypoint-agent` on an SSH host. The local plugin calls the same
provisioning library automatically; the CLI is for manual diagnostics.

```sh
node packages/installer/lib/cli.js install --target user@host
node packages/installer/lib/cli.js plan --target user@host
node packages/installer/lib/cli.js doctor --target user@host
node packages/installer/lib/cli.js discover --target user@host
node packages/installer/lib/cli.js tunnel --target user@host
node packages/installer/lib/cli.js pack
```

The bootstrap script:

1. detects Node.js through the account's own shell (nvm/Volta/fnm/Bun/asdf/mise/Nix/Homebrew), checks
    22.19+, and **never installs one**: a missing or too-old runtime stops with `exit 21`/`exit 22`.
   The deliberate alternative lives in the plugin, not here: Settings offers **install remote
   Node.js**, which runs `renderNodeInstallScript()` (nvm `v0.40.1` + `nvm install --lts`, no shell
   startup file touched). `probeRemoteNode()`/`installRemoteNode()` are the programmatic form;
2. resolves the npm global prefix (`--global-prefix`, else `npm prefix -g`) and installs `pnpm` and the
   pinned `@deepseek-ai/dsh` into it, on every run;
3. proves the install by running `dsh -V` and comparing it with the requested version;
4. adds the agent tarball to the chosen remote profile;
5. starts `dsh web` on `127.0.0.1` using that same global `dsh`, via a systemd user unit or `nohup`;
6. waits for the agent state file and prints the port.

There is no fallback prefix: an unwritable `npm prefix -g` fails the install with npm's own error rather
than placing `dsh` where the operator will not look. Nothing is installed outside that prefix and the
remote profile.

The installer itself never resolves credentials. The local plugin owns that decision and has two
modes:

**Direct (default).** `copyModelKey: true` / `credentialProxy: false`. The plugin resolves
`DEEPSEEK_API_KEY` from the local credential store and provisioning writes it into the remote
`dsh web` environment (`Environment="DEEPSEEK_API_KEY=…"` in the systemd user unit, or the `nohup`
environment). The remote host then calls the provider directly, so **the key is present on the
remote host**. Use this on a remote account you trust.

**Proxy.** `credentialProxy: true` / `copyModelKey: false`. The key never leaves the local machine.
The remote host is started with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key,
and the tunnel adds a reverse forward
`-R 127.0.0.1:47821:127.0.0.1:<local proxy port>`. The local proxy injects the real key and
forwards to `credentialProxyUpstream`.

When running the CLI by hand, no model flags exist: the remote host keeps whatever credentials it
already has, so configure them there first. See
[`docs/operations.md`](../../docs/operations.md) for the full comparison and troubleshooting.
