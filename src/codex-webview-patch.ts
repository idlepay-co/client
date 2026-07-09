import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PatchResult } from './spinner-patch';
import type { SpinnerAd } from './api';

/**
 * Renders idlepay ads INSIDE the OpenAI Codex (`openai.chatgpt`) panel webview.
 *
 * Codex has no config-injectable verb channel (unlike Claude Code's
 * `claudeCode.spinnerVerbs`) and its CSP blocks INLINE <script> (script-src is
 * cspSource-only, or carries a nonce that nullifies 'unsafe-inline'). So the ad
 * lives as a small patch of the STABLE `webview/index.html` plus two EXTERNAL,
 * same-origin script files under `assets/` (allowed by `script-src cspSource`,
 * exactly like Codex's own `index-*.js`):
 *   - idlepay-runtime.js : ad-independent logic (bump RENDER_VERSION when it
 *     changes). Inserts a bar IN FLOW just above the composer — it pushes the
 *     composer down instead of floating over content, so nothing overlaps — and
 *     re-inserts it via a MutationObserver whenever React re-renders the stack.
 *   - idlepay-ads.js     : the current roster as `window.__IDLEPAY_ADS`,
 *     rewritten whenever the campaign set changes. The runtime rotates through it
 *     live; a brand-new campaign is picked up on the next webview (re)load
 *     (Codex sets retainContextWhenHidden:true, and the CSP connect-src blocks a
 *     webview-side fetch, so there is no live push channel — by platform design).
 *
 * The patch touches ONLY these webview assets: never Codex's host `out/extension.js`,
 * never its Rust binary. It backs up the pristine `index.html`, is idempotent, and
 * `restoreCodex()` reverts every file. `index.html` is a fixed filename (not a
 * content-hashed chunk), so the injection point survives Codex updates.
 */

const START = '<!--idlepay:start-->';
const END = '<!--idlepay:end-->';
const RUNTIME_FILE = 'idlepay-runtime.js';
const ADS_FILE = 'idlepay-ads.js';
// Bump whenever BLOCK or RUNTIME_JS changes so patched bundles re-patch on upgrade.
// Ad DATA never changes this (it rides in idlepay-ads.js), so a new campaign never
// rewrites index.html and never needs the RENDER_VERSION to move.
const RENDER_VERSION = 'idlepay-codex-v4';

// --- discovery ---------------------------------------------------------------

function extRoots(): string[] {
  return [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.windsurf', 'extensions'),
  ];
}

/** Parse "26.623.141536" from "openai.chatgpt-26.623.141536-darwin-arm64". */
function extVersion(dir: string): number[] {
  const m = dir.match(/openai\.chatgpt-([\d.]+)/);
  return m ? m[1].split('.').map(Number) : [0];
}

function cmpVer(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest Codex `webview/index.html` in each editor's extensions dir. */
export function codexIndexPaths(): string[] {
  const out: string[] = [];
  for (const root of extRoots()) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('openai.chatgpt-'));
    } catch {
      continue;
    }
    if (dirs.length === 0) continue;
    dirs.sort((a, b) => cmpVer(extVersion(a), extVersion(b)));
    const latest = dirs[dirs.length - 1];
    const idx = path.join(root, latest, 'webview', 'index.html');
    if (fs.existsSync(idx)) out.push(idx);
  }
  return out;
}

// --- markup / logic (ad-independent) -----------------------------------------

const BLOCK =
  `\n${START}\n` +
  `<style>\n` +
  `#idlepay-ad{display:flex;align-items:center;gap:9px;margin:4px 12px 8px;padding:7px 11px;` +
  `box-sizing:border-box;flex:0 0 auto;border-radius:9px;` +
  `font:12px/1.3 -apple-system,system-ui,sans-serif;text-decoration:none;` +
  `background:var(--vscode-editorWidget-background,#26262b);` +
  `border:1px solid var(--vscode-editorWidget-border,rgba(255,255,255,.10));` +
  `cursor:pointer;opacity:0;transition:opacity .28s ease}\n` +
  `#idlepay-ad.ip-in{opacity:1}\n` +
  `#idlepay-ad .ip-badge{font-size:9px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;` +
  `padding:1px 5px;border-radius:4px;flex:0 0 auto;color:var(--vscode-descriptionForeground,#9aa0a6);` +
  `border:1px solid var(--vscode-editorWidget-border,rgba(255,255,255,.14))}\n` +
  `#idlepay-ad .ip-logo{width:16px;height:16px;border-radius:4px;object-fit:contain;flex:0 0 auto}\n` +
  `#idlepay-ad .ip-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px rgba(255,255,255,.04)}\n` +
  `#idlepay-ad .ip-text{color:var(--vscode-foreground,#e9e9e9);font-weight:500;white-space:nowrap;` +
  `overflow:hidden;text-overflow:ellipsis;transition:opacity .28s ease}\n` +
  `#idlepay-ad .ip-cta{margin-left:auto;font-size:11px;opacity:.55;flex:0 0 auto;color:var(--vscode-descriptionForeground,#9aa0a6)}\n` +
  `</style>\n` +
  `<a id="idlepay-ad" href="#" target="_blank" rel="noopener noreferrer">` +
  `<span class="ip-badge">Ad</span>` +
  `<img class="ip-logo" alt="" hidden>` +
  `<span class="ip-dot"></span>` +
  `<span class="ip-text"></span>` +
  `<span class="ip-cta">via idlepay ↗</span>` +
  `</a>\n` +
  `<script src="./assets/${ADS_FILE}"></script>\n` +
  `<script src="./assets/${RUNTIME_FILE}"></script>\n` +
  `${END}\n`;

// Ad-independent runtime. Reads window.__IDLEPAY_ADS (set by idlepay-ads.js) and
// keeps the bar mounted in-flow above the composer. No backticks/template literals
// here so it survives being embedded in this TS template string unescaped.
const RUNTIME_JS =
  `// idlepay — Codex webview ad runtime (RENDER_VERSION=${RENDER_VERSION}).\n` +
  `(function(){\n` +
  `  var ADS=(window.__IDLEPAY_ADS||[]).filter(function(a){return a&&a.text;});\n` +
  `  if(!ADS.length)return;\n` +
  `  function boot(){\n` +
  `    var el=document.getElementById('idlepay-ad');\n` +
  `    if(!el){return setTimeout(boot,200);}\n` +
  `    var t=el.querySelector('.ip-text'),dot=el.querySelector('.ip-dot'),img=el.querySelector('.ip-logo'),i=0;\n` +
  `    // Sanitize every ad-supplied value before it reaches a DOM sink: only http(s)\n` +
  `    // for the link, https/data:image for the logo, hex for the colour. Defence in\n` +
  `    // depth — the CSP already blocks javascript: and non-allowed img origins.\n` +
  `    function safeUrl(u){try{var p=new URL(u);return(p.protocol==='https:'||p.protocol==='http:')?p.href:'#';}catch(e){return '#';}}\n` +
  `    function safeLogo(l){return typeof l==='string'&&/^(https:\\/\\/|data:image\\/)/i.test(l)?l:'';}\n` +
  `    function safeColor(c){return typeof c==='string'&&/^#[0-9a-fA-F]{3,8}$/.test(c)?c:'#12b981';}\n` +
  `    function paint(a){\n` +
  `      t.textContent=a.text;el.href=safeUrl(a.url);\n` +
  `      var logo=safeLogo(a.logo);\n` +
  `      if(logo){img.src=logo;img.hidden=false;dot.style.display='none';}\n` +
  `      else{img.hidden=true;dot.style.display='';dot.style.background=safeColor(a.color);}\n` +
  `    }\n` +
  `    paint(ADS[0]);\n` +
  `    if(ADS.length>1)setInterval(function(){\n` +
  `      t.style.opacity=0;\n` +
  `      setTimeout(function(){i=(i+1)%ADS.length;paint(ADS[i]);t.style.opacity=1;},220);\n` +
  `    },4500);\n` +
  `    // Insert the bar in flow, right before the composer's block (the ancestor\n` +
  `    // whose previous sibling is the tall conversation area), so it reserves its\n` +
  `    // own row and never overlaps. .composer-attachment-surface is a stable\n` +
  `    // (non-hashed) Codex class; fall back to the last editable element.\n` +
  `    function findHost(){\n` +
  `      var anchor=document.querySelector('.composer-attachment-surface');\n` +
  `      if(!anchor){var ed=document.querySelectorAll('[contenteditable=\"true\"],textarea');anchor=ed[ed.length-1];}\n` +
  `      if(!anchor)return null;\n` +
  `      var n=anchor;\n` +
  `      for(var j=0;j<14&&n&&n.parentElement&&n.parentElement!==document.body;j++){\n` +
  `        var prev=n.previousElementSibling;\n` +
  `        if(prev&&prev.getBoundingClientRect().height>120)return n;\n` +
  `        n=n.parentElement;\n` +
  `      }\n` +
  `      return null;\n` +
  `    }\n` +
  `    // Place the bar in the composer flow ONCE, then leave it alone as long as it\n` +
  `    // stays in the DOM. Re-inserting/re-positioning on every scroll or message\n` +
  `    // re-render is what made it pop/depop, so once placed we act ONLY if it has\n` +
  `    // actually been detached (React replaced the composer stack). NOTE: the node\n` +
  `    // starts life connected (injected in <body> by index.html), so 'connected' is\n` +
  `    // not enough — we track that we placed it into the composer flow.\n` +
  `    var obs=null,placed=false;\n` +
  `    function place(){\n` +
  `      if(placed&&el.isConnected)return;\n` +
  `      var host=findHost();\n` +
  `      if(!host)return;\n` +
  `      host.parentElement.insertBefore(el,host);\n` +
  `      placed=true;\n` +
  `      requestAnimationFrame(function(){el.classList.add('ip-in');});\n` +
  `      if(obs)obs.disconnect();\n` +
  `      obs=new MutationObserver(function(){if(!el.isConnected)place();});\n` +
  `      try{obs.observe(host.parentElement,{childList:true});}catch(e){}\n` +
  `    }\n` +
  `    place();\n` +
  `    setInterval(place,1000);\n` +
  `  }\n` +
  `  boot();\n` +
  `})();\n`;

/** The roster file the runtime reads. Only text/url/color/logo are exposed. */
function adsFileContent(ads: SpinnerAd[]): string {
  const roster = ads
    .filter((a) => a.text)
    .map((a) => ({ text: a.text, url: a.url, color: a.color, logo: a.logo }));
  return `window.__IDLEPAY_ADS=${JSON.stringify(roster)};\n`;
}

// --- patch / restore ---------------------------------------------------------

const strip = (html: string): string =>
  html.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`, 'g'), '');

function sidecarPath(idx: string): string {
  return `${idx}.idlepay-applied`;
}
function backupPath(idx: string): string {
  return `${idx}.idlepay-backup`;
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    /* fall through and (re)write */
  }
  fs.writeFileSync(file, content, 'utf8');
}

/** Patch ONE index.html (ad-independent, sidecar-gated on RENDER_VERSION). */
function patchIndexHtml(idx: string): string {
  const sidecar = sidecarPath(idx);
  const backup = backupPath(idx);

  try {
    const rec = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    const st = fs.statSync(idx);
    if (rec['key'] === RENDER_VERSION && rec['size'] === st.size && rec['mtimeMs'] === st.mtimeMs) {
      return 'skipped';
    }
  } catch {
    /* not yet patched with this version */
  }

  let raw: string;
  try {
    // Read the backup if present, else the current file; either may already be
    // patched, so strip() restores Codex's pristine index.html.
    raw = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : fs.readFileSync(idx, 'utf8');
  } catch {
    return 'read-failed';
  }
  const pristine = strip(raw);
  if (!pristine.includes('</body>')) return 'no-body';

  try {
    if (!fs.existsSync(backup) || fs.readFileSync(backup, 'utf8') !== pristine) {
      fs.writeFileSync(backup, pristine, 'utf8');
    }
  } catch {
    return 'backup-failed';
  }

  const patched = pristine.replace('</body>', `${BLOCK}</body>`);
  try {
    fs.writeFileSync(idx, patched, 'utf8');
    writeIfChanged(path.join(path.dirname(idx), 'assets', RUNTIME_FILE), RUNTIME_JS);
    const st = fs.statSync(idx);
    fs.writeFileSync(sidecar, JSON.stringify({ key: RENDER_VERSION, size: st.size, mtimeMs: st.mtimeMs }));
    return 'patched';
  } catch {
    return 'write-failed';
  }
}

/**
 * Install the Codex ad bar and publish the current roster. The index.html patch
 * is ad-independent (re-patched only when Codex ships a fresh bundle); the roster
 * file is rewritten whenever the ad set changes. Safe + idempotent.
 */
export function applyCodexPatch(ads: SpinnerAd[]): PatchResult {
  const result: PatchResult = { ok: false, patched: [], skipped: [], failed: [] };

  const clean = ads.filter((a) => a.text);
  if (clean.length === 0) {
    result.failed.push({ binary: '*', reason: 'no-ads' });
    return result;
  }

  const paths = codexIndexPaths();
  if (paths.length === 0) {
    result.failed.push({ binary: '*', reason: 'codex-not-found' });
    return result;
  }

  const roster = adsFileContent(clean);
  for (const idx of paths) {
    // Roster first, so the runtime always finds ads on load even on the very
    // first patch. Both files live in the same stable assets/ dir as index.html.
    try {
      writeIfChanged(path.join(path.dirname(idx), 'assets', ADS_FILE), roster);
    } catch {
      /* the index patch below still reports its own failure */
    }
    const outcome = patchIndexHtml(idx);
    if (outcome === 'patched') result.patched.push(idx);
    else if (outcome === 'skipped') result.skipped.push(idx);
    else result.failed.push({ binary: idx, reason: outcome });
  }
  result.ok = result.patched.length > 0 || result.skipped.length > 0;
  return result;
}

/** Revert every Codex webview to pristine and drop all idlepay files. */
export function restoreCodex(): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const idx of codexIndexPaths()) {
    const backup = backupPath(idx);
    const sidecar = sidecarPath(idx);
    if (!fs.existsSync(backup) && !fs.existsSync(sidecar)) continue;
    try {
      const raw = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : fs.readFileSync(idx, 'utf8');
      fs.writeFileSync(idx, strip(raw), 'utf8');
      const assets = path.join(path.dirname(idx), 'assets');
      for (const f of [sidecar, backup, path.join(assets, RUNTIME_FILE), path.join(assets, ADS_FILE)]) {
        fs.rmSync(f, { force: true });
      }
      restored.push(idx);
    } catch {
      failed.push(idx);
    }
  }
  return { restored, failed };
}
