# idlepay client

> The code that runs on your machine. All of it.

[idlepay](https://idlepay.co) sells the idle moments of your AI coding
sessions to sponsors and pays you 50% of every impression — while you work in
**Claude Code** (both the terminal CLI and the VS Code / Cursor / Windsurf
extension) or the **OpenAI Codex** extension panel (`openai.chatgpt`, not the
`codex` terminal CLI). This repository is the complete source of the
client side — the
[`idlepay.idlepay`](https://marketplace.visualstudio.com/items?itemName=idlepay.idlepay)
editor extension and the Claude Code status line script. If it executes on
your machine, it's in this repo.

The server (ad marketplace, crediting, anti-fraud) is a private service;
none of it runs on user machines.

## What's in here

| Path | What it is |
|---|---|
| [`bin/idlepay-statusline.mjs`](bin/idlepay-statusline.mjs) | The script wired into `~/.claude/settings.json`. **No network, no credentials, no self-update** — it renders a local JSON file and reads one file timestamp. ~50 lines of logic; start your audit here. |
| [`src/api.ts`](src/api.ts) | Every network call the extension makes: ad content in, impression beacons and click counts out. That's the whole list. |
| [`src/extension.ts`](src/extension.ts) | Extension entry point: status bar ads, credited heartbeat (activity-gated), sign-in, ad cache for the status line. |
| [`src/spinner-patch.ts`](src/spinner-patch.ts) | The **opt-in** Claude Code spinner patch — asked once, pristine backup kept, reversible via the `Restore` command. |
| [`src/codex-webview-patch.ts`](src/codex-webview-patch.ts) | The **opt-in** OpenAI Codex panel patch — a sponsored bar above the composer, asked once (only if Codex is installed), reversible via the `Restore` command. |
| [`src/statusline.ts`](src/statusline.ts) | Installs the status line script and its `settings.json` entry. |
| [`src/uninstall.ts`](src/uninstall.ts) | Real uninstall: restores the pristine binary, strips settings, deletes `~/.idlepay`. |

The full security model — what is read, what leaves the machine, what never
does — is at [idlepay.co/security](https://www.idlepay.co/security).

## Build it yourself

```bash
corepack enable          # pnpm, pinned by packageManager in package.json
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm package             # → idlepay-<version>.vsix
```

Install the result with `code --install-extension idlepay-<version>.vsix`.

## Verify the published extension

Don't trust the marketplace blob — check it:

```bash
./scripts/verify.sh            # compares your local build to the published vsix
./scripts/verify.sh 0.0.20     # …or a specific version (check out its tag first)
```

The script downloads the published `idlepay.idlepay` package, builds this
repository at your working tree, and diffs the **contents** of both archives
file by file. (Zip archives embed timestamps, so comparing archive hashes is
meaningless — content diff is the honest check.) Applies to versions ≥ 0.0.20,
the first release built from this repository; each release is tagged with the
exact source it was built from.

## Contributing

Bug reports and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Security reports: see [SECURITY.md](SECURITY.md).

## License

[FSL-1.1-MIT](LICENSE.md) — the source is open to read, audit, fork and use
for any non-competing purpose, and every release converts to plain MIT two
years after publication.
