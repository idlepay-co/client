# Changelog

## 0.0.24

- **Easier to turn sponsored lines on**: the status bar now shows when the
  Claude Code / Codex sponsored lines are off and lets you switch them on in one
  click, instead of only offering the choice in a one-time prompt right after
  install. Clicking opens a small menu with an on/off row per surface (Codex
  only shows when it's installed). This is about where ads appear — your
  earnings work the same either way.

## 0.0.23

- **Codex support**: idlepay can now show sponsored lines inside the OpenAI
  Codex panel — a small bar above the composer — and the time you spend in
  Codex now earns too. It's opt-in and separate from the Claude Code setting:
  the extension asks once, only if Codex is installed, and it's reversible
  anytime ("idlepay: Restore agent ad surfaces to default"). Clicks are tracked
  through idlepay's redirect, same as the other surfaces.

## 0.0.22

- Clicking a sponsored line now opens through idlepay's tracked redirect, so
  advertisers can measure results — UTM params and a unique click id are added
  to the destination, and the creative variant that was shown is recorded for
  A/B testing. Reporting only; no extra data leaves your machine.

## 0.0.21

- Sharper marketplace icon.

## 0.0.20

- **The client is now open source**: this release is the first one built from
  the public repository — [github.com/idlepay-co/client](https://github.com/idlepay-co/client).
  Verify any release against its source with `scripts/verify.sh`.

## 0.0.19

Initial marketplace release.

- Sponsored lines in the VS Code status bar and the Claude Code status line,
  with live earnings tracking and a 50% revenue share.
- Optional spinner ads (opt-in, reversible at any time).
- Sign in with your idlepay account to claim earnings at idlepay.co.
