# Contributing

Thanks for looking under the hood — that's what this repo is for.

## Ground rules

- **Security first.** The status line script must stay free of network calls,
  credentials and self-update logic — CI enforces this, and no PR that
  weakens it will be merged. Same spirit everywhere: if a change makes the
  client harder to audit, it needs a very good reason.
- Keep the zero-dependency stance of `bin/idlepay-statusline.mjs` (Node
  built-ins only) and the extension's devDependencies-only policy.
- Match the style of the file you're editing; comments explain *why*, not
  *what*.

## Workflow

1. Open an issue first for anything non-trivial.
2. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build` must pass.
3. PRs should be small and focused. Describe the user-visible effect.

For vulnerabilities, **do not open an issue** — see [SECURITY.md](SECURITY.md).
