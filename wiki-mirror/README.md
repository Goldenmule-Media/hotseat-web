# wiki-mirror

The **local Markdown mirror**: a headless process that tails a (possibly remote) `wiki-server`'s
Durable Stream, folds and renders each commit with the embedded `wiki` engine, and writes the
deterministic Markdown tree into folders on this machine. The disk-writing sibling of `wiki-ui` —
it reads the stream and authors nothing back.

This repo's own [`docs/hotseat-wiki/`](../docs/hotseat-wiki/) is one such mirror.

**Why it is a separate process.** Its roots are absolute paths that mean something only on the
machine holding the disk, so emission — and its `workspaceId → root` map — is inherently local.
That is why the server can be deployed remotely while the Markdown lands in your checkouts.

---

## Install it as a service

The mirror is meant to run unattended: a launchd agent that starts at login, restarts on a crash,
and is watched from the menu bar by [`wiki-mirror-menubar`](../wiki-mirror-menubar/README.md).

### On any Mac (no checkout needed)

Download the latest release — it carries the mirror, the menu-bar app, and an installer:

```sh
gh release download --repo Goldenmule-Media/hotseat-web --pattern '*-macos.tar.gz'
tar -xzf wiki-mirror-*-macos.tar.gz
./wiki-mirror-*-macos/install.sh
```

No `gh`? Grab it from the [Releases page](https://github.com/Goldenmule-Media/hotseat-web/releases),
or:

```sh
curl -fsSL https://api.github.com/repos/Goldenmule-Media/hotseat-web/releases/latest \
  | grep -o 'https://[^"]*-macos\.tar\.gz' | head -1 \
  | xargs curl -fsSLO
```

Requires **macOS 14+** and **Node 20+**. It needs no checkout, no npm, and no Xcode: the mirror
ships as one self-contained `.mjs` with its model bundles beside it. Everything is copied to its
final home, so the installer removes the download when it is done (`--keep` to hold on to it).

A first install writes `~/.wiki/wiki-mirror.config.json` pointing at
**`https://hotseat.thegoldenmule.com`**, with no folders mirrored yet — so **Sign in…** works
immediately and the workspace picker fills in. It never touches an existing config: that file is
shared by every project on the machine, and overwriting it would silently drop your other mirrors.
Point it elsewhere in Configure → Server. The app is ad-hoc signed
rather than notarized, so macOS quarantines it on download — `install.sh` clears that for the files
it installs, which is the same trust you extend by running the script.

### From this checkout (a development machine)

```sh
./scripts/install-agent.sh --mode source     # runs the working tree via tsx — always current
./scripts/install-agent.sh --mode dist       # runs the built dist/bin.js (npm run build -w wiki-mirror first)
./scripts/install-agent.sh --status          # launchd state + what the health endpoint says
./scripts/install-agent.sh --restart         # config is read at startup — restart after editing it
./scripts/install-agent.sh --logs
./scripts/install-agent.sh --uninstall
```

`--mode source` is the one to want while developing: the service always reflects your checkout, so
a restart is all an engine or model change needs.

Build the portable artifact yourself with `npm run bundle -w wiki-mirror` → `build/`.

### Run it in a terminal instead

```sh
npm run start -w wiki-mirror          # or, from the repo root: npm run start:mirror
```

Debugging only. Stop the service first — two mirrors fight over port 4440, and the second exits 0
with a message rather than running a competing writer against the same roots.

---

## Configure it

Per-machine, at **`~/.wiki/wiki-mirror.config.json`** — ONE file shared by every project on this
Mac, never server state (point elsewhere with `--config` / `WIKI_MIRROR_CONFIG`):

```json
{
  "streamBaseUrl": "https://your-wiki.example.com",
  "namespace": "default",
  "models": ["wiki-models/feature", "wiki-models/toc"],
  "emitters": [
    { "workspaceId": "ws:...", "root": "/Users/you/projects/thing/docs" }
  ]
}
```

Easiest path is the menu-bar app's **Configure…**, which picks workspaces by name and folders with
a file chooser. By hand, the rules the mirror enforces are: roots must be **absolute**, each
workspace appears **once**, and no two workspaces share a root (one root is one writer — they would
clobber each other's manifest).

It is read **once at startup**: restart the agent after editing it.

| Key | |
|---|---|
| `streamBaseUrl` | the Durable Streams host to tail (library default `http://127.0.0.1:4437`; a release install seeds `https://hotseat.thegoldenmule.com`) |
| `namespace` | must match the server's `WIKI_MCP_NAMESPACE` |
| `models` | bundle specifiers to `import()` — resolved through `node_modules` |
| `modelsDir` | a directory of bundles discovered one level deep — how a portable install carries its schema without `node_modules` |
| `emitters` | `workspaceId → absolute root`, one tail loop each |
| `token` | a static bearer token; usually unnecessary, see below |
| `healthPort` / `healthHost` | the local status endpoint (default `127.0.0.1:4440`) |
| `probeIntervalMs` | how often to check the host is reachable and the tail is keeping pace |

Resolution order is `flags → env WIKI_MIRROR_* → file → defaults`.

## Sign in

Against an auth-gated server the mirror needs its own credentials:

```sh
npm run start -w wiki-mirror -- login       # or the app's Sign in…
npm run start -w wiki-mirror -- logout      # or Configure → Account → Sign out
```

`login` runs a browser sign-in once and stores a self-refreshing grant at
`~/.wiki/credentials.json` (shared with `migrate-workspace`). A running mirror picks a new grant up
on its next self-restart — no token copying, no kill.

`logout` forgets the grant for that server and leaves every other server's alone. The running
mirror holds its token in memory until the engine rebuilds, so restart it (the app does) or
sign-out won't take effect until it does.

## When the docs stop moving

The mirror's quietest failure is Markdown that simply stops changing, so it says which of its
failures it is:

```sh
curl -s localhost:4440/_mirror/status | python3 -m json.tool
```

- **`auth.expired: true`** — the grant ran out. Sign in again; the mirror rebuilds its engine on its
  own within ~30s of the server accepting it. This is the usual culprit.
- **`server.reachable: false`** — the mirror is fine and cannot reach the host.
- **a workspace with `lastReconcileError`** — the reason is in the message, and `nextRetryAt` says
  when it tries again. A failed emitter stays listed rather than vanishing, because an omitted entry
  is indistinguishable from one you never configured.
- **nothing answering at all** — the process is down: `./scripts/install-agent.sh --status`.

Logs are at `~/Library/Logs/wiki-mirror/`. `GET /_mirror/workspaces` lists everything on the server
with the root this machine mirrors it to.

## What lands on disk

`<root>/<workspace>/<page tree>` — a folder plus `index.md` for a page with children. Every file is
content-hashed, so a re-render that produces identical bytes writes nothing and the git diff stays
honest. Writes are atomic (temp + rename), an on-disk `.wiki-md-manifest.json` records the applied
version, and a wiped output directory self-heals on the next boot.

**Archiving never deletes a mirrored file**: an archived page moves to
`<workspace>/.archived/<type>--<id>.md` and moves back when unarchived. Only a hard page delete
removes one.

## Design intent

[`docs/hotseat-wiki/architecture/wiki-mirror/`](../docs/hotseat-wiki/architecture/wiki-mirror/) —
the supervisor, the liveness probe, and why recovery is a full engine rebuild. Boundaries and
conventions: [`CLAUDE.md`](../CLAUDE.md).
