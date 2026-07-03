import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';

const IDLEPAY_DIR = path.join(os.homedir(), '.idlepay');
const SCRIPT_DEST = path.join(IDLEPAY_DIR, 'idlepay-statusline.mjs');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Version marker embedded in the script. Legacy scripts (<0.1.0) self-updated
 * from idlepay.co, so an installed copy can legitimately be NEWER than an old
 * bundle; since 0.1.0 the script is local-only (no network, no self-update)
 * and releases ride this extension's channel exclusively.
 */
function scriptVersion(file: string): string | null {
  try {
    const m = /const IDLEPAY_STATUSLINE_VERSION = '([^']+)'/.exec(fs.readFileSync(file, 'utf8'));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True when semver-ish `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Copies the bundled statusline script and registers it in ~/.claude/settings.json. */
export function installStatusLine(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(IDLEPAY_DIR, { recursive: true });

    // Install/refresh the script, but never DOWNGRADE: the installed copy
    // self-updates from idlepay.co, so it may be ahead of this bundle. Only
    // overwrite when the bundle is strictly newer, or the installed copy is
    // missing/unversioned/unreadable (the self-heal path this watchdog is for).
    const src = path.join(context.extensionPath, 'bin', 'idlepay-statusline.mjs');
    const bundled = scriptVersion(src);
    const installed = scriptVersion(SCRIPT_DEST);
    if (!installed || !bundled || isNewer(bundled, installed)) {
      fs.copyFileSync(src, SCRIPT_DEST);
    }

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) as Record<string, unknown>;
    } catch { /* no existing settings.json — start fresh */ }

    // No env vars, no URLs: the script is local-only (renders ~/.idlepay/
    // ad-cache.json, written by this extension). What a user auditing their
    // Claude settings sees is exactly `node <50-line local script>`.
    settings['statusLine'] = {
      type: 'command',
      command: `node "${SCRIPT_DEST}"`,
      refreshInterval: 5,
    };

    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

    console.log(`[idlepay] statusLine installed → ${SCRIPT_DEST}`);
  } catch (err) {
    console.warn('[idlepay] statusLine install failed:', (err as Error).message);
  }
}

/** Removes the statusLine entry from ~/.claude/settings.json and cleans up ~/.idlepay on extension deactivation. */
export function uninstallStatusLine(): void {
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if ('statusLine' in settings) {
      delete settings['statusLine'];
      fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
      console.log('[idlepay] statusLine removed from Claude settings');
    }
  } catch { /* settings.json missing or unreadable — nothing to do */ }

  try {
    fs.rmSync(IDLEPAY_DIR, { recursive: true, force: true });
    console.log('[idlepay] ~/.idlepay cleaned up');
  } catch { /* best effort */ }
}
