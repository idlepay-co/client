# Changelog

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
