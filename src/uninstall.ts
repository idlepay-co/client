/**
 * `vscode:uninstall` hook — the ONLY teardown path. VS Code runs this script in
 * a plain Node process (no `vscode` module — never import it here, directly or
 * transitively) on the first editor restart after the user uninstalls idlepay.
 * It never runs on window reload, extension disable, or extension update, so it
 * cannot reproduce the 2026-07-01 regression where teardown in deactivate()
 * wiped ~/.idlepay on every reload.
 *
 * It removes every ad surface idlepay installed OUTSIDE its own extension dir
 * (the dir itself is deleted by VS Code right after this script exits):
 *   1. Claude Code CLI binary spinner  → restore the pristine backup
 *   2. Claude Code panel webview       → restore the pristine bundle
 *      (+ drop all .idlepay-backup / .idlepay-applied files next to both)
 *   3. `claudeCode.spinnerVerbs`       → strip from each editor's settings.json
 *      (this key persists after uninstall and keeps ad TEXT in the panel even
 *      once the webview is pristine — Claude Code reads it live)
 *   4. statusLine ad beacon            → strip from ~/.claude/settings.json
 *      (only when it is ours) and delete ~/.idlepay
 *
 * Everything is best-effort: a failure on one surface must not block the rest,
 * and the process always exits 0. Outcome is logged to
 * <tmpdir>/idlepay-uninstall.log (~/.idlepay is gone by the end, so not there).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeBinaries, replaceFile, restoreSpinner, webviewPaths } from './spinner-patch';
import { restoreCodex } from './codex-webview-patch';

const IDLEPAY_DIR = path.join(os.homedir(), '.idlepay');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SPINNER_VERBS_KEY = 'claudeCode.spinnerVerbs';

const log: string[] = [`idlepay uninstall @ ${new Date().toISOString()}`];

function main(): void {
  // 1 + 2. Un-patch every Claude Code binary and webview from its backup.
  try {
    const r = restoreSpinner();
    log.push(`restored: ${r.restored.join(', ') || '(none)'}`);
    if (r.failed.length > 0) log.push(`restore failed: ${r.failed.join(', ')}`);
  } catch (err) {
    log.push(`restoreSpinner error: ${(err as Error).message}`);
  }

  // Codex (openai.chatgpt) panel — revert index.html and drop the injected
  // assets/idlepay-*.js. Best-effort, like everything else here.
  try {
    const c = restoreCodex();
    log.push(`codex restored: ${c.restored.join(', ') || '(none)'}`);
    if (c.failed.length > 0) log.push(`codex restore failed: ${c.failed.join(', ')}`);
  } catch (err) {
    log.push(`restoreCodex error: ${(err as Error).message}`);
  }

  // Leave no idlepay files behind next to Claude Code. restoreSpinner only
  // discovers the LATEST binary per editor (+ the one on PATH), but earlier
  // Claude Code versions keep their patched binary and our ~215MB backup next
  // to it (e.g. ~/.local/bin/2.1.197.idlepay-backup after an installer update).
  // Sweep every dir we ever touched: restore any remaining backup onto its
  // still-present base file, then delete all .idlepay-* files.
  const sweepDirs = new Set<string>();
  for (const f of [...safe(claudeBinaries), ...safe(webviewPaths)]) sweepDirs.add(path.dirname(f));
  for (const root of extensionRoots()) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch { /* editor not installed */ }
    for (const d of dirs) {
      sweepDirs.add(path.join(root, d, 'resources', 'native-binary'));
      sweepDirs.add(path.join(root, d, 'webview'));
    }
    // Codex webviews: catch stale versions restoreCodex (newest-only) skipped —
    // the index.html backup/sidecar live in webview/, the injected scripts in
    // webview/assets/.
    let codexDirs: string[] = [];
    try {
      codexDirs = fs.readdirSync(root).filter((d) => d.startsWith('openai.chatgpt-'));
    } catch { /* editor not installed */ }
    for (const d of codexDirs) {
      sweepDirs.add(path.join(root, d, 'webview'));
      sweepDirs.add(path.join(root, d, 'webview', 'assets'));
    }
  }
  // Homebrew cask keeps old version dirs that may carry a sidecar from before
  // the user switched to the native installer (no longer reachable via PATH).
  const caskRoot = '/opt/homebrew/Caskroom/claude-code@latest';
  for (const d of safe(() => fs.readdirSync(caskRoot))) sweepDirs.add(path.join(caskRoot, d));
  for (const dir of sweepDirs) sweepIdlepayFiles(dir);

  // 3. Drop the spinnerVerbs override from every editor's user settings.
  for (const file of editorSettingsFiles()) {
    try {
      if (stripKeyFromFile(file, SPINNER_VERBS_KEY)) log.push(`spinnerVerbs removed: ${file}`);
    } catch (err) {
      log.push(`settings scrub failed ${file}: ${(err as Error).message}`);
    }
  }

  // 4. statusLine beacon — remove only OUR entry (never a user's custom one),
  // then delete ~/.idlepay (scripts, identity, debug log). On a later reinstall
  // the extension rebuilds identity.json from globalState, which survives.
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) as Record<string, unknown>;
    const command = (settings['statusLine'] as { command?: unknown } | undefined)?.command;
    if (typeof command === 'string' && command.includes('idlepay')) {
      delete settings['statusLine'];
      fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
      log.push('statusLine removed from ~/.claude/settings.json');
    }
  } catch { /* settings.json missing or unreadable — nothing to do */ }

  try {
    fs.rmSync(IDLEPAY_DIR, { recursive: true, force: true });
    log.push('~/.idlepay removed');
  } catch (err) {
    log.push(`~/.idlepay removal failed: ${(err as Error).message}`);
  }
}

function safe(list: () => string[]): string[] {
  try {
    return list();
  } catch {
    return [];
  }
}

/** Extension roots of every editor spinner-patch targets (mirrors fromEditors). */
function extensionRoots(): string[] {
  return ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor', '.windsurf'].map((d) =>
    path.join(os.homedir(), d, 'extensions'),
  );
}

/**
 * Restore any *.idlepay-backup in `dir` onto its base file (backups are always
 * pristine copies — for stale versioned binaries restoreSpinner never visits),
 * then delete every idlepay sidecar/backup so nothing of ours remains.
 */
function sweepIdlepayFiles(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    // The Codex injected scripts have no ".idlepay-" infix — remove by exact name.
    if (name === 'idlepay-ads.js' || name === 'idlepay-runtime.js') {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch { /* best effort */ }
      continue;
    }
    if (!name.includes('.idlepay-')) continue;
    const full = path.join(dir, name);
    if (name.endsWith('.idlepay-backup')) {
      const base = path.join(dir, name.slice(0, -'.idlepay-backup'.length));
      try {
        if (fs.existsSync(base)) replaceFile(full, base);
      } catch (err) {
        log.push(`stale restore failed ${base}: ${(err as Error).message}`);
      }
    }
    try {
      fs.rmSync(full, { force: true });
    } catch { /* best effort */ }
  }
}

/** User settings.json of every editor idlepay targets, on this platform. */
function editorSettingsFiles(): string[] {
  const apps = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  let root: string;
  if (process.platform === 'darwin') root = path.join(os.homedir(), 'Library', 'Application Support');
  else if (process.platform === 'win32') root = process.env['APPDATA'] ?? '';
  else root = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  if (!root) return [];
  return apps
    .map((app) => path.join(root, app, 'User', 'settings.json'))
    .filter((p) => fs.existsSync(p));
}

/** Remove every occurrence of a top-level property from a settings file. True if changed. */
function stripKeyFromFile(file: string, key: string): boolean {
  let text = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (let out = removeJsoncProperty(text, key); out !== null; out = removeJsoncProperty(text, key)) {
    text = out;
    changed = true;
  }
  if (changed) fs.writeFileSync(file, text, 'utf8');
  return changed;
}

/**
 * Surgically remove `"key": <value>` from JSONC text, preserving the user's
 * comments and formatting — settings.json allows comments and trailing commas,
 * so parse-and-rewrite (JSON.parse → stringify) would corrupt or lose them.
 * Returns the new text, or null when the key is absent.
 */
function removeJsoncProperty(text: string, key: string): string | null {
  const needle = JSON.stringify(key);
  let searchFrom = 0;
  while (true) {
    const keyStart = text.indexOf(needle, searchFrom);
    if (keyStart === -1) return null;
    searchFrom = keyStart + needle.length;

    // Property position only: the next non-whitespace char must be ':'.
    let i = searchFrom;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ':') continue;

    const valueEnd = scanValueEnd(text, i + 1);
    if (valueEnd === -1) return null;

    let start = keyStart;
    let end = valueEnd;

    // Take the separating comma with us — the one after the value, or, for a
    // last property, the one before the key — so no dangling comma remains.
    let j = end;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === ',') {
      end = j + 1;
    } else {
      let p = start - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
      if (p >= 0 && text[p] === ',') start = p;
    }

    // If the removal leaves a blank line, take that too.
    let lineStart = start;
    while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t')) lineStart--;
    if (lineStart === 0 || text[lineStart - 1] === '\n') {
      let lineEnd = end;
      while (lineEnd < text.length && (text[lineEnd] === ' ' || text[lineEnd] === '\t')) lineEnd++;
      if (lineEnd >= text.length || text[lineEnd] === '\n' || text[lineEnd] === '\r') {
        start = lineStart;
        end = lineEnd;
        if (text[end] === '\r') end++;
        if (text[end] === '\n') end++;
      }
    }

    return text.slice(0, start) + text.slice(end);
  }
}

/** Index just past a JSONC value starting at/after `from` (-1 when malformed). */
function scanValueEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return -1;

  const c = text[i];
  if (c === '"') return scanString(text, i);

  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i = scanString(text, i);
        if (i === -1) return -1;
        continue;
      }
      if (ch === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        if (nl === -1) return -1;
        i = nl + 1;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close === -1) return -1;
        i = close + 2;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }

  // Scalar (true / false / null / number): runs to the next delimiter.
  while (i < text.length && !',}]\r\n'.includes(text[i])) i++;
  return i;
}

/** Index just past a JSON string whose opening quote is at `at` (-1 when unterminated). */
function scanString(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

try {
  main();
} catch (err) {
  log.push(`fatal: ${(err as Error).message}`);
}
try {
  fs.writeFileSync(path.join(os.tmpdir(), 'idlepay-uninstall.log'), `${log.join('\n')}\n`);
} catch { /* nowhere left to report */ }
console.log(log.join('\n'));
process.exitCode = 0;
