# allman-tui

A re-imagined LinkedIn messenger inbox, in your terminal. A thin terminal
front-end over the standalone `allman` binary and its on-disk message store.

> **Companion repos:** [`tarkaai/allman-cli`](https://github.com/tarkaai/allman-cli) — the underlying CLI. The TUI bundles a pinned `allman` binary built from that repo; install just this one and you have both. Prefer a native window? [`tarkaai/allman-mac`](https://github.com/tarkaai/allman-mac) is the macOS menu bar app over the same CLI and store.

```
┌─ allman · your-account ──────────┬─────────────────────────────────────────────┐
│ / search                     │ Jamie Rivera  @jamie-rivera                 │
│ ──────────────────────────── │ Senior Engineer | Building …         │
│ ▸ ● Jamie Rivera         3d  │                                             │
│   you: Hey Jamie! I sent…    │ ─── Apr 3 ───                               │
│                              │ Jamie  3:46p                                │
│   ● Taylor Osei    4d  │   Submitted                                 │
│   you: Hi Taylor, a fellow…│                                             │
│                              │ ─── Apr 7 ───                               │
│   ○ Morgan Patel     1w  │ you  4:28p                                  │
│   you: Morgan, thanks for…     │   Hey Jamie! I sent a message to John…      │
│   …                          │                                             │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ ▶ Reply to Jamie…   (press i to compose)                                   │
│ allman · your-account · ● connected · 292 convs · 4 unread             [browse]│
│ j/k navigate · ↵ open · i compose · / search · n new · r sync · ? help     │
└────────────────────────────────────────────────────────────────────────────┘
```

## Install

### From GitHub Releases (Linux and macOS, x64 and arm64)

```bash
curl -fsSL https://raw.githubusercontent.com/tarkaai/allman-tui/main/install.sh | bash
```

Binaries include the `allman` CLI embedded inside — no separate install required.
See the [releases page](https://github.com/tarkaai/allman-tui/releases) for direct downloads.

## Run

```bash
bun install
bun run dev
```

### Bundled `allman` binary

`bun run build` produces a single self-contained `dist/allman-tui` executable
with the standalone `allman` binary embedded inside. On first launch, the
embedded copy is extracted to `$XDG_CACHE_HOME/allman-tui/bin/allman-<sha>` and
re-used on every subsequent run — no separate `allman` install required.

The build script (`scripts/build.ts`) needs to know where to find a real
`allman` binary to embed; it picks `ALLMAN_BIN` first, then `allman` on `PATH`.

### Resolution order at runtime

1. `ALLMAN_BIN` environment variable (explicit override)
2. The bundled binary embedded in `dist/allman-tui` (production builds)
3. `allman` on `PATH` (dev mode and unbundled installs)

Store discovery: `ALLMAN_STORE` env, otherwise always `$HOME/.allman`. The
directory doesn't need to exist yet — if it's missing or empty, the TUI
prints a clear "no accounts" error pointing at the bundled `allman login`
command.

If you have a single account, it loads automatically. Otherwise set
`ALLMAN_ACCOUNT=<slug>`.

## Architecture

`allman-tui` is a thin React/Ink front-end over the on-disk allman message
store and the standalone `allman` binary. It never reaches into the CLI's
source tree — only the binary on `PATH` (or `ALLMAN_BIN`) and the
public file-store layout.

- **Reads** (conversation list, message history, slug resolution) come straight
  from the JSONL/JSON files on disk for snappy navigation. No subprocess
  overhead per keystroke.
- **Writes** (`send`, `sync`, `search`) shell out to the `allman` binary so
  rate limiting, pre-send sync, and git commits go through the canonical path.
- **Live updates** subscribe to `allman listen`'s NDJSON event stream from a
  long-running subprocess. Disable with `ALLMAN_TUI_LISTEN=0`.

```
src/
  index.tsx                 entry point
  app.tsx                   root component, mode + state machine
  components/
    Sidebar.tsx             conversation list with inline search
    Thread.tsx              message thread, day-grouped, word-wrapped
    Composer.tsx            reply input
    StatusBar.tsx           account, listen, mode, hint bar
    NewConversation.tsx     contact-search modal for starting threads
    Help.tsx                key reference overlay
  lib/
    allman.ts                file-store reader + allman binary shell-outs
    bundled-bin.ts          extracts the embedded allman binary on first run
    types.ts                message / conversation / event shapes
    format.ts               relativeTime, dayLabel, color hashing
scripts/
  build.ts                  copies the allman binary into assets/, runs
                            `bun build --compile`, restores the stub
assets/
  allman                     4-byte stub in the repo; replaced with the real
                            allman binary at build time, then restored
```

## Keys

| Key             | What it does |
| --------------- | ------------ |
| `j` / `↓`       | next conversation |
| `k` / `↑`       | previous conversation |
| `g` / `G`       | top / bottom of list |
| `↵`             | open conversation under cursor (also auto-previewed) |
| `i`             | compose a reply |
| `Esc`           | leave any sub-mode |
| `/`             | filter the conversation list |
| `n`             | search contacts and start a new conversation |
| `:`             | command palette (`sync`, `connections`, `enrich`, `connect`, `reload`, `help`, `quit`) |
| `r`             | sync everything from LinkedIn |
| `R`             | reload from the local store (no network) |
| `PgUp` / `PgDn` | scroll the message thread |
| `?`             | toggle help |
| `q` / `Ctrl+C`  | quit |

### Network commands

Run from the `:` palette. Each shells out to the `allman` binary, which owns
rate limiting, the per-day/per-hour volume caps, duplicate detection, and the
300-character note cap — the TUI never bypasses any of them.

| Command | What it does |
| ------- | ------------ |
| `:connections` | Pull your 1st-degree connection list (flagship backend) |
| `:connections 500` | ...capped at 500 |
| `:connections salesnav` | Use Sales Navigator instead (richer, but capped at 2,500 results) |
| `:enrich` | Fill in title, company, location and about for stored connections |
| `:enrich 200` | ...for at most 200 profiles this run |
| `:enrich deep` | ...also work history, education and skills |
| `:enrich <slug>` | Enrich one person |
| `:connect <slug>` | Send a connection request |
| `:connect <slug> <note…>` | ...with a personalized note (max 300 chars) |

Once a contact is enriched, the thread header shows their current role and
location in place of their LinkedIn headline.

> `:connect` sends a real, irreversible invitation. There is no undo, and
> LinkedIn caps how many you can send — see the CLI's `RESPONSIBLE_USE.md`.

## Modes

`allman-tui` is modal — what your keys mean depends on which mode you're in.
The current mode is shown on the right of the status bar (`[browse]`,
`[search]`, `[compose]`, `[new]`, `[command]`, `[help]`). The hint line below
it always reflects the keys available in the current mode.

| Mode       | What you can do |
| ---------- | --------------- |
| `browse`   | navigate conversations, jump into other modes |
| `search`   | filter the sidebar by name / slug / headline |
| `compose`  | type a reply, `↵` to send, `Esc` to cancel |
| `new`      | search contacts via `allman search`, pick one to open or draft |
| `command`  | type a command palette command |
| `help`     | full keybinding reference |

## Environment

| Variable            | Description |
| ------------------- | ----------- |
| `ALLMAN_BIN`         | Absolute path to the `allman` binary. Defaults to `allman` on `PATH`. |
| `ALLMAN_STORE`       | Absolute path to a `.allman` directory. Defaults to `$HOME/.allman`. |
| `ALLMAN_ACCOUNT`     | Account slug to use when multiple accounts exist |
| `ALLMAN_TUI_LISTEN`  | Set to `0`/`false` to disable the `allman listen` subprocess |

## Notes

- Pre-send sync, rate limiting, and git commits are all handled by `allman
  send` — the TUI never writes to the store directly.
- Starting a brand-new conversation drafts a placeholder thread in the
  sidebar and creates the real thread on LinkedIn on the first send.
- Listening is best-effort: if the subprocess fails, the status dot in the
  bar turns red and the rest of the app keeps working from the on-disk store.

## Contributing

Issues and pull requests welcome. Before sending a PR:

```bash
bun test
bun run lint
```

## License

MIT — see [LICENSE](./LICENSE).

Companion to [`allman-cli`](https://github.com/tarkaai/allman-cli), named in tribute to [Eric Allman](https://en.wikipedia.org/wiki/Eric_Allman), author of sendmail.
