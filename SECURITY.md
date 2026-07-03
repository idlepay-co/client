# Security

This repository contains **all the code idlepay runs on your machine** — the
editor extension and the Claude Code status line script. The server side
(ad marketplace, crediting, anti-fraud) is a separate private service; nothing
in it executes on user machines.

The full security model is documented at
[idlepay.co/security](https://www.idlepay.co/security). The short version:

- the status line script wired into Claude Code makes **no network calls,
  reads no credentials, and never self-updates** — see
  [`bin/idlepay-statusline.mjs`](bin/idlepay-statusline.mjs);
- the extension is the **only** component that talks to idlepay servers, and
  only for ad content, impression beacons and click counts — see
  [`src/api.ts`](src/api.ts);
- prompts, code and conversations are **never read** — the only signal used is
  the modification timestamp of the session transcript file;
- the Claude Code spinner patch is **opt-in**, disclosed, and reversible — see
  [`src/spinner-patch.ts`](src/spinner-patch.ts);
- releases ship exclusively through the editor marketplaces, built from this
  repository. See [`scripts/verify.sh`](scripts/verify.sh) to check that the
  published extension matches this source.

## Reporting a vulnerability

Email **support@idlepay.co** with `[security]` in the subject.

Please include reproduction steps and, if relevant, the extension version
(`idlepay.idlepay` in your editor's extension panel). We read every report,
aim to respond within 48 hours, and credit researchers who want to be
credited. Please give us a reasonable window to ship a fix before public
disclosure.

## Scope

In scope: everything in this repository, the published `idlepay.idlepay`
extension, the `idlepay.co` portal and the idlepay API.

Out of scope: denial of service, social engineering, and issues requiring
physical access to an unlocked machine.
