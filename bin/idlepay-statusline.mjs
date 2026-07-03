#!/usr/bin/env node
// idlepay status line for Claude Code — LOCAL-ONLY since 0.1.0.
//
// Claude Code runs this (via `statusLine` in ~/.claude/settings.json) every few
// seconds and prints its stdout as the bottom status line. We are NOT patching
// Claude Code — we are filling a supported extension slot.
//
// This script makes NO network calls, reads NO credentials, and never updates
// itself. It does exactly two things:
//
//   1. RENDER the ad the idlepay VS Code extension last wrote to
//      ~/.idlepay/ad-cache.json. When that file is stale (VS Code closed, so
//      nothing is fetching ads or crediting earnings), it shows a dim
//      "earnings paused" notice linking to https://idlepay.co/paused instead.
//
//   2. TOUCH ~/.idlepay/heartbeat when — and only when — this session shows
//      real activity (Claude Code pipes session JSON into our stdin; a
//      transcript modified in the last few minutes is the signal). The
//      extension reads that mtime to keep crediting terminal sessions while
//      VS Code sits unfocused. An idle-but-open CLI writes no heartbeat.
//
// All network, identity and crediting live in the extension. What Claude Code
// executes is only this file — audit it in one sitting; that is the point.
//
// Rules: zero dependencies, must be fast, must NEVER throw or hang. Worst case
// it prints a tiny fallback so the line is never broken.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Version marker — the extension overwrites this file whenever its bundled
// copy is strictly newer, so releases ride the extension's update channel.
const IDLEPAY_STATUSLINE_VERSION = '0.1.0';

const IDLEPAY_DIR = join(homedir(), '.idlepay');
// Written by the extension every ad-rotation tick (~30s while VS Code runs):
// { fetchedAt, ad: { text, url, style } } — url is already the click-through
// (tracked) link, so this script needs no API origin and no device identity.
const AD_CACHE_FILE = join(IDLEPAY_DIR, 'ad-cache.json');
// Touched by us while the session is active; read (mtime) by the extension.
const HEARTBEAT_FILE = join(IDLEPAY_DIR, 'heartbeat');

// Past this age the cache is treated as "no extension running". Generous on
// purpose: the extension's 30s rotation timer can be throttled by the OS when
// VS Code is backgrounded (App Nap), and a stale-but-recent ad beats a false
// "paused" flicker.
const AD_STALE_MS = 5 * 60_000;
// Transcript idle window past which the session stops asserting activity.
// Mirrors the extension's CLAUDE_ACTIVITY_WINDOW_MS so both agree on what
// "actively using Claude" means.
const ACTIVITY_WINDOW_MS = 5 * 60_000;
// Claude Code writes its session JSON to our stdin and closes it immediately;
// the deadline only guards against a runner that never closes the pipe.
const STDIN_DEADLINE_MS = 250;

// Shown when the extension is not running (no fresh ad cache). Not an ad — no
// SPONSORED badge, dim styling — just the one action that resumes earning.
const PAUSED_URL = 'https://idlepay.co/paused';
const PAUSED_TEXT = '⏸ idlepay paused — open VS Code to keep earning';

// --- sanitisation (ad content is untrusted) --------------------------------

// Drop ESC + C0/C1 control characters and DEL — blocks terminal escape-sequence
// injection via advertiser-supplied strings. Iterates by code point so emoji
// (surrogate pairs) stay intact.
function clean(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c <= 31 || (c >= 127 && c <= 159)) continue;
    out += ch;
  }
  return out.trim();
}

/** Allow only control-free http(s) URLs (so ad data can't break out of OSC 8). */
function safeUrl(u) {
  const c = clean(u);
  return /^https?:\/\//i.test(c) ? c : null;
}

/** "#635BFF" -> { r, g, b }, or null for anything invalid. */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Black or white text, whichever contrasts better with the given background. */
function contrastFg({ r, g, b }) {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 30 : 97;
}

// --- rendering -------------------------------------------------------------

const RESET = '\x1b[0m';
const DEFAULT_BADGE = { r: 245, g: 158, b: 11 }; // amber fallback
const MAX_TEXT = 120;

/** Wraps text in an OSC 8 terminal hyperlink (clickable in supporting terms). */
function link(url, text) {
  if (!url) return text;
  const ESC = '\x1b';
  const ST = '\x1b\\'; // string terminator
  return `${ESC}]8;;${url}${ST}${text}${ESC}]8;;${ST}`;
}

function render(ad) {
  const style = ad.style ?? {};

  // Every advertiser-supplied string is sanitised + length-capped here.
  const text = clean(ad.text).slice(0, MAX_TEXT) || 'Sponsored';
  const url = safeUrl(ad.url);

  // Badge: the "SPONSORED" label is fixed (not advertiser-editable, for
  // transparency); only its background colour is brandable.
  const bg = hexToRgb(style.badgeColorHex) ?? DEFAULT_BADGE;
  const badge = `\x1b[1;${contrastFg(bg)};48;2;${bg.r};${bg.g};${bg.b}m SPONSORED ${RESET}`;

  // Ad text: advertiser colour (truecolor), bold by default.
  const weight = style.bold === false ? '' : '1;';
  const fg = hexToRgb(style.textColorHex);
  const color = fg ? `38;2;${fg.r};${fg.g};${fg.b}` : '97';
  const body = `\x1b[${weight}${color}m${link(url, text)}${RESET}`;

  const arrow = url ? `\x1b[2;37m ↗${RESET}` : '';
  return `${badge} ${body}${arrow}`;
}

function renderPaused() {
  return `\x1b[2;37m${link(PAUSED_URL, PAUSED_TEXT)} ↗${RESET}`;
}

// --- ad cache (written by the extension) ------------------------------------

async function readAdCache() {
  try {
    const cache = JSON.parse(await readFile(AD_CACHE_FILE, 'utf8'));
    if (
      typeof cache?.fetchedAt === 'number' &&
      cache.ad &&
      typeof cache.ad.text === 'string'
    ) {
      return cache;
    }
  } catch {
    /* no/invalid cache → extension not running yet */
  }
  return null;
}

// --- activity gate -----------------------------------------------------------

/**
 * Session JSON that Claude Code pipes into the statusLine command's stdin
 * ({ transcript_path, session_id, … }). Null when stdin is a TTY, empty, or
 * unparseable — all treated as "no evidence of activity".
 */
async function readStdinSession() {
  if (process.stdin.isTTY) return null;
  try {
    const chunks = [];
    // unref'd so a pending deadline can never hold the process open.
    const deadline = setTimeout(() => process.stdin.destroy(), STDIN_DEADLINE_MS);
    deadline.unref();
    for await (const chunk of process.stdin) chunks.push(chunk);
    clearTimeout(deadline);
    if (chunks.length === 0) return null;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null; // destroyed pipe / bad JSON → idle
  }
}

/**
 * True only when this session's transcript was written recently. The transcript
 * moves when messages are actually exchanged — never from a terminal merely
 * sitting open — so it is the one signal that separates "using Claude" from
 * "left a CLI open overnight". Missing transcript (session opened, zero
 * prompts) counts as idle.
 */
async function hasRecentActivity(session) {
  const transcript = session?.transcript_path;
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  try {
    const { mtimeMs } = await stat(transcript);
    return Date.now() - mtimeMs < ACTIVITY_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Liveness signal for the extension: "a Claude session in SOME terminal is
 * genuinely active right now". Only its mtime is read, so a torn write is
 * harmless. Best-effort — a failure must never break the line.
 */
async function touchHeartbeat() {
  try {
    await writeFile(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* ~/.idlepay missing (not installed via the extension) — nothing to signal */
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const [session, cache] = await Promise.all([readStdinSession(), readAdCache()]);

  if (await hasRecentActivity(session)) await touchHeartbeat();

  if (cache && Date.now() - cache.fetchedAt < AD_STALE_MS) {
    process.stdout.write(render(cache.ad));
  } else {
    process.stdout.write(renderPaused());
  }
}

main().catch(() => {
  process.stdout.write('✶ idlepay'); // never break the line
});
