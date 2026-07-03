import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Patches every Claude Code native binary on the machine so the spinner verbs
 * ("Noodling"…) become idlepay ad lines. There can be SEVERAL binaries:
 *   - the CLI on PATH (Homebrew / native installer)
 *   - the binary bundled inside the VS Code / Cursor extension
 *     (~/.vscode/extensions/anthropic.claude-code-<ver>/resources/native-binary/claude)
 * The editor extension uses ITS bundled copy, so patching only the PATH binary
 * does nothing inside VS Code — we must patch them all.
 *
 * Verbs are small-string-optimised records:
 *   [16B meta: cap=0x10 | _ | len@+12][16B inline string, null-padded]
 * so each ad line must be <= 16 UTF-8 bytes. We patch from a pristine per-binary
 * backup, re-sign ad-hoc (macOS), verify it still runs, then atomically swap.
 */

const REC = 32;
const MAX_BYTES = 16;
const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

export interface PatchResult {
  ok: boolean;
  patched: string[];
  skipped: string[];
  failed: { binary: string; reason: string }[];
}

// --- binary discovery --------------------------------------------------------

function fromPath(): string | null {
  const which = spawnSync('sh', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  const p = which.stdout?.trim();
  if (which.status === 0 && p) {
    try {
      return fs.realpathSync(p);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Parse "2.1.195" from "anthropic.claude-code-2.1.195-darwin-arm64". */
function extVersion(dir: string): number[] {
  const m = dir.match(/claude-code-(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Latest bundled binary inside each editor's extensions dir. */
function fromEditors(): string[] {
  const out: string[] = [];
  const extRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.windsurf', 'extensions'),
  ];
  for (const root of extRoots) {
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(root)
        .filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    if (dirs.length === 0) continue;
    // Highest version only — older installs are unused by the editor.
    dirs.sort((a, b) => cmpVer(extVersion(a), extVersion(b)));
    const latest = dirs[dirs.length - 1];
    const bin = path.join(root, latest, 'resources', 'native-binary', 'claude');
    if (fs.existsSync(bin)) out.push(bin);
  }
  return out;
}

/** All distinct Claude Code native binaries to patch. */
export function claudeBinaries(): string[] {
  const set = new Set<string>();
  const p = fromPath();
  if (p) set.add(p);
  for (const b of fromEditors()) set.add(b);
  return [...set];
}

// --- binary structure --------------------------------------------------------

function isMachOHead(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0));
}

function verbAt(buf: Buffer, S: number): string | null {
  if (S < 16 || S + 16 > buf.length) return null;
  if (buf.readBigUInt64LE(S - 16) !== 0x10n) return null;
  const len = buf.readUInt32LE(S - 4);
  if (len === 0 || len > 16) return null;
  for (let i = len; i < 16; i++) if (buf[S + i] !== 0) return null;
  for (let i = 0; i < len; i++) {
    const b = buf[S + i];
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) return null;
  }
  return buf.toString('utf8', S, S + len);
}

function findSpinnerTable(buf: Buffer): { start: number; count: number } | null {
  const seed = Buffer.from('brewing\0', 'latin1');
  let pos = 0;
  while ((pos = buf.indexOf(seed, pos)) !== -1) {
    const at = pos;
    pos += seed.length;
    if (verbAt(buf, at) === null) continue;

    let start = at;
    while (verbAt(buf, start - REC) !== null) start -= REC;
    let end = at;
    while (verbAt(buf, end) !== null) end += REC;

    const count = (end - start) / REC;
    let allGerunds = true;
    for (let i = 0; i < count; i++) {
      const w = verbAt(buf, start + i * REC);
      if (!w || !w.endsWith('ing')) {
        allGerunds = false;
        break;
      }
    }
    if (allGerunds && count > 20) return { start, count };
  }
  return null;
}

// --- labels ------------------------------------------------------------------

export function shortenLabel(text: string): string {
  const t = text.trim();
  if (Buffer.byteLength(t, 'utf8') <= MAX_BYTES) return t;
  let out = '';
  for (const w of t.split(/\s+/)) {
    const cand = (out ? `${out} ${w}` : w).trim();
    if (Buffer.byteLength(`${cand} ↗`, 'utf8') <= MAX_BYTES) out = cand;
    else break;
  }
  out = out.replace(/[^\p{L}\p{N}]+$/u, '');
  if (!out) out = Buffer.from(t).subarray(0, MAX_BYTES - 4).toString('utf8');
  return `${out} ↗`;
}

// --- signing / verification --------------------------------------------------

function resign(p: string): boolean {
  if (process.platform !== 'darwin') return true;
  spawnSync('codesign', ['--remove-signature', p], { stdio: 'ignore' });
  return spawnSync('codesign', ['-s', '-', '-f', p], { encoding: 'utf8' }).status === 0;
}

function verifyRuns(p: string): boolean {
  const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && /Claude Code/.test(r.stdout ?? '');
}

// --- per-binary patch --------------------------------------------------------

function sidecarPath(bin: string): string {
  return `${bin}.idlepay-applied`;
}

/** Skip re-patching when the binary is unchanged and labels are identical. */
function alreadyCurrent(bin: string, labelsKey: string): boolean {
  try {
    const rec = JSON.parse(fs.readFileSync(sidecarPath(bin), 'utf8'));
    const st = fs.statSync(bin);
    return rec.labels === labelsKey && rec.size === st.size && rec.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

function patchOne(bin: string, rotation: string[], labelsKey: string): string {
  // Returns 'patched' | 'skipped' | a failure reason.
  if (alreadyCurrent(bin, labelsKey)) return 'skipped';

  let head: Buffer;
  try {
    const fd = fs.openSync(bin, 'r');
    head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
  } catch {
    return 'unreadable';
  }
  if (!isMachOHead(head)) return 'not-native-binary';

  const backup = `${bin}.idlepay-backup`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(bin, backup);
  } catch {
    return 'backup-failed';
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(backup);
  } catch {
    return 'read-failed';
  }

  const table = findSpinnerTable(buf);
  if (!table) return 'table-not-found';

  for (let i = 0; i < table.count; i++) {
    const S = table.start + i * REC;
    const bytes = Buffer.from(rotation[i % rotation.length], 'utf8');
    buf.fill(0, S, S + 16);
    bytes.copy(buf, S, 0, Math.min(bytes.length, 16));
    buf.writeUInt32LE(bytes.length, S - 4);
  }

  const tmp = path.join(os.tmpdir(), `claude.idlepay.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    if (!resign(tmp)) {
      fs.rmSync(tmp, { force: true });
      return 'codesign-failed';
    }
    if (!verifyRuns(tmp)) {
      fs.rmSync(tmp, { force: true });
      return 'verify-failed';
    }
    try {
      fs.renameSync(tmp, bin);
    } catch {
      fs.copyFileSync(tmp, bin);
      fs.rmSync(tmp, { force: true });
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return `swap-failed: ${(err as Error).message}`;
  }

  try {
    const st = fs.statSync(bin);
    fs.writeFileSync(
      sidecarPath(bin),
      JSON.stringify({ labels: labelsKey, size: st.size, mtimeMs: st.mtimeMs }),
    );
  } catch {
    /* sidecar is an optimisation only */
  }
  return 'patched';
}

/** Patch every Claude Code binary found. Safe + idempotent. */
export function applySpinnerPatch(labels: string[]): PatchResult {
  const result: PatchResult = { ok: false, patched: [], skipped: [], failed: [] };
  if (process.platform === 'win32') {
    result.failed.push({ binary: '*', reason: 'windows-unsupported' });
    return result;
  }

  const clean = labels
    .map(shortenLabel)
    .filter((l) => Buffer.byteLength(l, 'utf8') <= MAX_BYTES);
  const rotation = clean.length > 0 ? clean : ['Advertise here ↗'];
  const labelsKey = rotation.join('|');

  const binaries = claudeBinaries();
  if (binaries.length === 0) {
    result.failed.push({ binary: '*', reason: 'claude-not-found' });
    return result;
  }

  for (const bin of binaries) {
    const outcome = patchOne(bin, rotation, labelsKey);
    if (outcome === 'patched') result.patched.push(bin);
    else if (outcome === 'skipped') result.skipped.push(bin);
    else result.failed.push({ binary: bin, reason: outcome });
  }
  result.ok = result.patched.length > 0 || result.skipped.length > 0;
  return result;
}

/**
 * Replace `to` with a copy of `from` via tmp + atomic rename — never truncate
 * the destination in place: a process currently executing `to` keeps its mapped
 * inode, instead of being SIGKILLed by macOS when its signed pages change under
 * it (same swap pattern as patchOne).
 */
export function replaceFile(from: string, to: string): void {
  const tmp = path.join(os.tmpdir(), `claude.idlepay.restore.${process.pid}.${Date.now()}`);
  fs.copyFileSync(from, tmp);
  try {
    fs.renameSync(tmp, to);
  } catch {
    fs.copyFileSync(tmp, to);
    fs.rmSync(tmp, { force: true });
  }
}

/** Revert every binary to its pristine backup. */
export function restoreSpinner(): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const bin of claudeBinaries()) {
    const backup = `${bin}.idlepay-backup`;
    if (!fs.existsSync(backup)) continue;
    try {
      replaceFile(backup, bin);
      fs.rmSync(sidecarPath(bin), { force: true });
      restored.push(bin);
    } catch {
      failed.push(bin);
    }
  }
  for (const wv of webviewPaths()) {
    const sidecar = `${wv}.idlepay-applied`;
    const backup = `${wv}.idlepay-backup`;
    if (!fs.existsSync(backup) && !fs.existsSync(sidecar)) continue;
    try {
      // unpatchSource() guarantees pristine output even if the backup itself is
      // a contaminated (already-patched) copy.
      const raw = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : fs.readFileSync(wv, 'utf8');
      fs.writeFileSync(wv, unpatchSource(raw), 'utf8');
      fs.rmSync(sidecar, { force: true });
      restored.push(wv);
    } catch {
      failed.push(wv);
    }
  }
  return { restored, failed };
}

// --- webview patching (rich ads: logo + colour + clickable link) -------------

/** A rich spinner ad rendered inside the VS Code Claude Code panel. */
export interface SpinnerAd {
  text: string;
  url?: string;
  color?: string;
  /** Brand logo as a data: URI (CSP allows img-src data: only). */
  logo?: string;
}

// Rare printable separator (U+241F) between an ad's display text and its packed
// JSON styling. Printable (not a control char) so Claude Code can't strip it as
// noise, yet effectively never present in ad copy. Only our own render ever reads
// it (a plain/pristine render never receives a packed verb; see the parser-live
// gate in extension.ts), so it is never shown to a user.
const VERB_META_DELIM = '\u241F';
// A logo data URI longer than this is dropped from the live verb (text + colour
// + link still travel) so settings.json stays sane and Claude Code doesn't choke
// on a huge verb string. Oversized logos are a pipeline smell; the ad still shows.
const MAX_LOGO_CHARS = 8_000;

/**
 * Pack a rich ad into ONE spinner-verb string: `TEXT\u241F{c,l,u}`.
 *
 * The verb travels live through `claudeCode.spinnerVerbs` (which Claude Code
 * reads without a reload), and the patched webview render (buildSpinnerReplacement)
 * parses this back out — so a new ad's colour, logo and link appear the moment the
 * verb rotates in, with NO window reload, exactly like the plain text already did.
 * Short keys (c=colour, l=logo, u=url) keep the string small.
 */
export function packSpinnerVerb(ad: SpinnerAd): string {
  const meta: { c?: string; l?: string; u?: string } = {};
  if (ad.color) meta.c = ad.color;
  if (ad.url) meta.u = ad.url;
  if (ad.logo && ad.logo.length <= MAX_LOGO_CHARS) meta.l = ad.logo;
  return ad.text + VERB_META_DELIM + JSON.stringify(meta);
}

// Legacy patch shape (v0.0.13 and earlier): the ad data was baked into a global
// header and the render looked each verb up by name. Kept here only so an upgrade
// can strip a bundle/backup still carrying the old format.
const IDLEPAY_HEADER_RE = /^globalThis\.__IDLEPAY_ADS=.*?;\n/;
const IDLEPAY_LEGACY_WRAPPER_RE =
  /return\(function\(\)\{var __a=\(globalThis\.__IDLEPAY_ADS\|\|\{\}\)\[[\w$]+\];if\(__a\)return .*?;return (.*?);\}\)\(\)/;

// Current patch shape (live styling): the render parses colour/logo/link out of
// the verb string itself, so NO ad data is baked into the bundle. Reverting just
// pulls the plain-render fallback (`;return <PLAIN>;`) back out of our wrapper —
// which is a byte-for-byte copy of Claude Code's original render, so the patch
// stays idempotent even against a stale/already-patched backup.
const IDLEPAY_WRAPPER_RE =
  /return\(function\(\)\{var __s=String\([\w$]+\)[\s\S]*?if\(__a\)return [\s\S]*?;return ([\s\S]*?);\}\)\(\)/;

/**
 * Strip any prior idlepay patch from source, returning Claude Code's pristine
 * bundle. Exported for the patch/unpatch round-trip test.
 * @internal
 */
export function unpatchSource(src: string): string {
  return src
    .replace(IDLEPAY_HEADER_RE, '')
    .replace(IDLEPAY_WRAPPER_RE, (_m, plain: string) => `return ${plain}`)
    .replace(IDLEPAY_LEGACY_WRAPPER_RE, (_m, plain: string) => `return ${plain}`);
}

// Locates Claude Code's spinner render component structurally so it survives
// minification renames between versions ([\w$]+ captures names that contain $).
// Captures: prefix (the verb line), the element creators, the CSS-module var,
// permission-mode var, spinner-char array + frame index, and the verb var.
/** @internal — exported for the patch/unpatch round-trip test. */
export const SPINNER_COMPONENT_RE = (() => {
  const I = '[\\w$]+';
  return new RegExp(
    `(?<prefix>(?<h>${I})=${I}\\((?<u>${I})\\+"\\.\\.\\.",${I}\\+3\\);)` +
      `return (?<E>${I})\\("div",\\{className:(?<C>${I})\\.container,"data-permission-mode":(?<t>${I}),children:\\[` +
      `(?<b>${I})\\("span",\\{className:\\k<C>\\.icon,style:\\{fontSize:\`\\$\\{(?<sz>${I})\\}px\`\\},children:(?<chars>${I})\\[(?<idx>${I})\\]\\}\\),` +
      `\\k<b>\\("span",\\{className:\\k<C>\\.text,children:\\k<h>\\}\\)\\]\\}\\)`,
  );
})();

/** All Claude Code webview/index.js files across every editor's extensions dir. */
export function webviewPaths(): string[] {
  const out: string[] = [];
  const extRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.windsurf', 'extensions'),
  ];
  for (const root of extRoots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    // Patch all installed versions (each has its own webview).
    for (const dir of dirs) {
      const p = path.join(root, dir, 'webview', 'index.js');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

/**
 * A churn-free fingerprint of the Claude Code bundles currently installed
 * (the versioned webview paths). It changes when Claude Code is installed,
 * auto-updates (VS Code drops a new `anthropic.claude-code-<ver>` dir), or is
 * removed — but NOT when we patch a bundle in place. The extension polls this
 * cheaply so it can re-bake ads immediately after a Claude Code self-update,
 * instead of waiting for the slow watchdog (a fresh version ships pristine, so
 * the spinner would otherwise lose its ads/logo/colour until the next re-bake).
 */
export function claudeBundleKey(): string {
  return webviewPaths().sort().join('|');
}

// Identifies the render-logic shape currently injected. The webview patch no
// longer carries ad DATA (that rides live in the verb strings), so the patched
// bundle depends only on this version — bump it whenever buildSpinnerReplacement
// changes so bundles re-patch on upgrade. New ads never change it, so they never
// touch the bundle and never need a reload.
const RENDER_VERSION = 'idlepay-live-style-v1';

/**
 * True when every installed Claude Code webview currently carries the CURRENT
 * render logic (its `.idlepay-applied` sidecar matches the file on disk AND was
 * written by this RENDER_VERSION). Used at activation to decide whether the
 * running webview already understands packed verbs: if so we push rich (packed)
 * verbs; otherwise we push plain text this session and let the next reload pick
 * up the freshly-patched parser. Goes false the instant Claude Code restores a
 * pristine bundle, or after an idlepay upgrade that bumped RENDER_VERSION.
 */
export function isWebviewPatched(): boolean {
  const paths = webviewPaths();
  if (paths.length === 0) return true; // nothing installed → nothing to recover
  for (const p of paths) {
    try {
      const rec = JSON.parse(fs.readFileSync(`${p}.idlepay-applied`, 'utf8')) as Record<string, unknown>;
      const st = fs.statSync(p);
      if (rec['key'] !== RENDER_VERSION) return false; // old/foreign render shape
      if (rec['size'] !== st.size || rec['mtimeMs'] !== st.mtimeMs) return false;
    } catch {
      return false; // missing/stale sidecar → treat as unpatched
    }
  }
  return true;
}

/**
 * Build the replacement render code. It parses the incoming verb string
 * (`TEXT␟{c,l,u}`, produced by packSpinnerVerb) at RENDER time: the text
 * before the separator is shown, the JSON after it supplies colour/logo/link.
 * Because the verb is delivered live via claudeCode.spinnerVerbs, a new ad's
 * rich styling appears WITHOUT a window reload. A verb with no separator (Claude
 * Code's own default verbs, or a stripped one) falls through to a byte-for-byte
 * copy of the pristine plain render — which also keeps the patch idempotent, since
 * unpatchSource can pull that exact original back out.
 */
export function buildSpinnerReplacement(g: Record<string, string>): string {
  const iconDefault =
    `${g.b}("span",{className:${g.C}.icon,style:{fontSize:\`\${${g.sz}}px\`},children:${g.chars}[${g.idx}]})`;
  const richDiv =
    `${g.E}("div",{className:${g.C}.container,"data-permission-mode":${g.t},children:[` +
    `__a.l?${g.b}("img",{src:__a.l,style:{height:"13px",width:"13px",borderRadius:"3px",objectFit:"contain",verticalAlign:"middle",marginRight:"3px"}}):${iconDefault},` +
    `${g.b}("a",{className:${g.C}.text,href:__a.u||"#",style:{color:__a.c||"#12b981",textDecoration:"underline",cursor:"pointer"},children:__t+" ↗"})]})`;
  const plainDiv =
    `${g.E}("div",{className:${g.C}.container,"data-permission-mode":${g.t},children:[` +
    `${iconDefault},${g.b}("span",{className:${g.C}.text,children:${g.h}})]})`;
  return (
    `${g.prefix}return(function(){` +
    `var __s=String(${g.u}),__i=__s.indexOf("\\u241F"),__t=__i<0?__s:__s.slice(0,__i),__a=null;` +
    `if(__i>=0){try{__a=JSON.parse(__s.slice(__i+1))}catch(e){}}` +
    `if(__a)return ${richDiv};` +
    `return ${plainDiv};` +
    `})()`
  );
}

function patchWebviewFile(p: string, key: string): string {
  const sidecar = `${p}.idlepay-applied`;
  const backup = `${p}.idlepay-backup`;

  try {
    const rec = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    const st = fs.statSync(p);
    if (rec['key'] === key && rec['size'] === st.size && rec['mtimeMs'] === st.mtimeMs) {
      return 'skipped';
    }
  } catch { /* not yet patched */ }

  let src: string;
  try {
    // Read the backup if present, else the current file; either may already be
    // patched, so unpatchSource() restores Claude Code's pristine bundle. This
    // self-heals a stale/contaminated backup instead of patching our own output.
    const raw = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : fs.readFileSync(p, 'utf8');
    src = unpatchSource(raw);
  } catch {
    return 'read-failed';
  }

  try {
    // Persist the recovered pristine bundle as the backup (fixes contamination).
    if (!fs.existsSync(backup) || fs.readFileSync(backup, 'utf8') !== src) {
      fs.writeFileSync(backup, src, 'utf8');
    }
  } catch {
    return 'backup-failed';
  }

  const m = SPINNER_COMPONENT_RE.exec(src);
  if (!m || !m.groups) return 'component-not-found';

  const replacement = buildSpinnerReplacement(m.groups as Record<string, string>);
  // No baked-in ad data any more: the styling rides live inside each verb string
  // (packSpinnerVerb), so the patched bundle is identical regardless of which ads
  // are active — it only re-patches when Claude Code ships a new bundle.
  const patched = src.slice(0, m.index) + replacement + src.slice(m.index + m[0].length);

  try {
    fs.writeFileSync(p, patched, 'utf8');
    const st = fs.statSync(p);
    fs.writeFileSync(sidecar, JSON.stringify({ key, size: st.size, mtimeMs: st.mtimeMs }));
    return 'patched';
  } catch {
    return 'write-failed';
  }
}

/**
 * Install the render LOGIC that lets Claude Code's webview spinner show rich ads
 * (logo + brand colour + clickable link). The ad TEXT *and* its styling enter the
 * rotation via the official `claudeCode.spinnerVerbs` setting as packed verbs (set
 * in extension.ts); this patch just teaches the render how to unpack them. It's
 * ad-INDEPENDENT — re-patched from a pristine backup keyed on RENDER_VERSION — so
 * it's idempotent, self-heals after Claude Code updates, and a mere ad change
 * never rewrites the bundle (hence never needs a reload). `ads` is used only to
 * gate on "is there anything to show".
 */
export function applyWebviewPatch(ads: SpinnerAd[]): PatchResult {
  const result: PatchResult = { ok: false, patched: [], skipped: [], failed: [] };

  const clean = ads.filter((a) => a.text);
  if (clean.length === 0) {
    result.failed.push({ binary: '*', reason: 'no-ads' });
    return result;
  }
  const key = RENDER_VERSION;

  const paths = webviewPaths();
  if (paths.length === 0) {
    result.failed.push({ binary: '*', reason: 'webview-not-found' });
    return result;
  }

  for (const p of paths) {
    const outcome = patchWebviewFile(p, key);
    if (outcome === 'patched') result.patched.push(p);
    else if (outcome === 'skipped') result.skipped.push(p);
    else result.failed.push({ binary: p, reason: outcome });
  }
  result.ok = result.patched.length > 0 || result.skipped.length > 0;
  return result;
}
