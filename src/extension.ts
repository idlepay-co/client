import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ad } from './types';
import { clickThroughUrl, fetchDisplayAd, fetchEarnings, fetchProfile, fetchAdLabels, fetchSpinnerAds, pingImpression, setApiOrigin } from './api';
import type { SpinnerAd } from './api';
import { installStatusLine } from './statusline';
import {
  applySpinnerPatch,
  applyWebviewPatch,
  isWebviewPatched,
  packSpinnerVerb,
  restoreSpinner,
  webviewPaths,
} from './spinner-patch';

const DEVELOPER_ID_KEY = 'idlepay.developerId';
const DEVICE_TOKEN_KEY = 'idlepay.deviceToken';
const WELCOMED_KEY = 'idlepay.welcomed';
// 'granted' | 'declined' — records the spinner-patch consent decision so the
// prompt is shown at most once (a dismissed toast re-asks next activation).
const SPINNER_CONSENT_KEY = 'idlepay.spinnerConsent';
// Last-good ads/labels, so a pristine bundle can be re-baked even when the live
// /ad fetch is momentarily empty (cold API right after boot).
const SPINNER_ADS_CACHE_KEY = 'idlepay.spinnerAdsCache';
const SPINNER_LABELS_CACHE_KEY = 'idlepay.spinnerLabelsCache';
const REFRESH_AD_MS = 30_000;
const REFRESH_ACCOUNT_MS = 60_000;
const HEARTBEAT_MS = 30_000; // credited beacon cadence (mirrors the statusLine's ~1 credit/30s)
const SPINNER_WATCH_MS = 60_000; // re-fetch /ads + re-bake on change; also recovers after Claude updates / pristine resets
// Statusline liveness: the statusline script (local-only since 0.1.0) touches
// ~/.idlepay/heartbeat every ~5s while ITS session shows real activity. A
// recent mtime therefore means "a Claude session in some terminal is genuinely
// active", which unlocks crediting even while the VS Code window sits
// unfocused. 90s tolerates render-loop jitter without keeping the gate open
// long after the terminal went quiet.
const STATUSLINE_HEARTBEAT_FRESH_MS = 90_000;
const OPEN_AD_COMMAND = 'idlepay.openAd';
const SIGNIN_COMMAND = 'idlepay.signIn';
const SIGNOUT_COMMAND = 'idlepay.signOut';
const ACCOUNT_MENU_COMMAND = 'idlepay.accountMenu';
const DASHBOARD_COMMAND = 'idlepay.openDashboard';
const RESTORE_SPINNER_COMMAND = 'idlepay.restoreSpinner';
const PORTAL_URL = 'https://idlepay.co';

interface State {
  ad: Ad | null;
  connected: boolean;
}

// Whether the Claude Code webview loaded at window start already carried our
// current render parser. Captured once per activation (before we patch anything)
// and read by refreshSpinner to decide rich (packed) vs plain verbs — see the
// note at the capture site in activate().
let webviewParserLiveAtLoad = false;

export function activate(context: vscode.ExtensionContext): void {
  installStatusLine(context);

  const apiUrl = vscode.workspace.getConfiguration('idlepay').get<string>('apiUrl');
  if (apiUrl) setApiOrigin(apiUrl);

  const developerId = ensureDeveloperId(context);

  // Publish identity for LEGACY statusline scripts (<0.1.0 — they fetch and
  // credit on their own until this extension replaces them with the local-only
  // script). Harmless once replaced: the 0.1.0 script never reads it.
  writeIdentity(developerId, context.globalState.get<string>(DEVICE_TOKEN_KEY), apiUrl);

  // Capture the device token handed back from the sign-in web flow
  // (vscode://idlepay.idlepay/linked?device_id=…&token=…).
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        if (uri.path !== '/linked') return;
        const token = new URLSearchParams(uri.query).get('token');
        if (!token) return;
        await context.globalState.update(DEVICE_TOKEN_KEY, token);
        writeIdentity(developerId, token, apiUrl);
        refreshAccount(); // reflect the signed-in state on the status bar now
        const choice = await vscode.window.showInformationMessage(
          'idlepay: signed in — this device is now earning. 💸 Reload the window so your account is picked up everywhere.',
          'Reload Window',
          'Later',
        );
        if (choice === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      },
    }),
  );

  const state: State = { ad: null, connected: false };

  // --- Ad status bar (right side) -------------------------------------------
  const adBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  adBar.command = OPEN_AD_COMMAND;
  renderAd(adBar, state);
  adBar.show();
  context.subscriptions.push(adBar);

  // --- Account status bar (sign-in / earnings) ------------------------------
  const accountBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  accountBar.text = '$(sign-in) Sign in to idlepay';
  accountBar.tooltip = 'Sign in to claim your earnings — you keep 50%';
  accountBar.color = new vscode.ThemeColor('charts.yellow');
  accountBar.command = SIGNIN_COMMAND;
  accountBar.show();
  context.subscriptions.push(accountBar);

  // --- Commands ---------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_AD_COMMAND, () => {
      void openCurrentAd(state.ad, developerId);
    }),
    vscode.commands.registerCommand(SIGNIN_COMMAND, () => {
      // Pass the editor's URI scheme so the web flow can deep-link the device
      // token back to this extension after Google sign-in.
      const scheme = vscode.env.uriScheme;
      void vscode.env.openExternal(
        vscode.Uri.parse(
          `${PORTAL_URL}/connect?device_id=${developerId}&scheme=${encodeURIComponent(scheme)}`,
        ),
      );
    }),
    vscode.commands.registerCommand(DASHBOARD_COMMAND, () => {
      void vscode.env.openExternal(vscode.Uri.parse(`${PORTAL_URL}/dashboard`));
    }),
    vscode.commands.registerCommand(RESTORE_SPINNER_COMMAND, () => {
      const r = restoreSpinner();
      void vscode.window.showInformationMessage(
        r.restored.length > 0
          ? `idlepay: restored ${r.restored.length} Claude Code binary(ies) to default. Reload the window / restart your session.`
          : 'idlepay: nothing to restore (no patched binary found).',
      );
    }),
  );

  // --- Spinner ads — bake idlepay ad lines into the Claude Code binary --------
  // Capture, BEFORE we patch anything this session, whether the running webview
  // already carries our current render logic. Its bundle was loaded once at window
  // start, so this reflects what the LIVE panel can actually parse: if true, it
  // understands packed verbs and we push rich (styled) verbs; if false, it's still
  // plain/pristine and we push plain text this session, then patch the bundle so
  // the parser goes live on the next reload. This is what makes a new ad's colour/
  // logo/link update live once the parser is in — and avoids ever showing raw
  // packed JSON to a webview that can't yet decode it.
  // Require an actually-installed webview: with none present, a future pristine
  // panel installed mid-session must not inherit packed verbs it can't decode.
  webviewParserLiveAtLoad = webviewPaths().length > 0 && isWebviewPatched();

  // Spinner ads are OPT-IN since 0.0.17 (marketplace posture: patching the
  // local Claude Code binary happens only after an explicit yes). This resolves
  // the consent state — migrating existing installs, prompting fresh ones —
  // and the refresh loops below stay unconditional because refreshSpinner
  // re-reads the setting on every tick and no-ops until it turns true.
  void ensureSpinnerConsent(context);

  // Retry a few times early on: at activation the network may not be ready yet,
  // and refreshSpinner now no-ops on an empty fetch rather than clearing the
  // spinner. These catch-up attempts get ads in without waiting for the watchdog.
  void refreshSpinner(context);
  for (const delay of [4_000, 15_000, 60_000]) {
    const h = setTimeout(() => { void refreshSpinner(context); }, delay);
    context.subscriptions.push({ dispose: () => clearTimeout(h) });
  }

  // --- Spinner refresh loop (every 60s) — re-fetch /ads and push the active set.
  // The ad TEXT *and* its colour/logo/link now travel live via
  // claudeCode.spinnerVerbs (each verb is packed with its own styling), so once the
  // parser is live a newly added or changed campaign shows FULLY within ~1 min with
  // NO window reload. The webview bundle patch only installs that parser; it's
  // ad-independent, so applyWebviewPatch re-touches a bundle only when Claude Code
  // ships/restores a new one (sidecar check) — this loop also recovers after a
  // Claude Code self-update. On a cold/empty fetch it keeps the last-good state and
  // retries next tick.
  const spinnerWatchHandle = setInterval(() => { void refreshSpinner(context); }, SPINNER_WATCH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(spinnerWatchHandle) });

  // --- Refresh on window focus — the 60s interval above is a background timer,
  // and the OS throttles/suspends it when VS Code is not frontmost (macOS App Nap,
  // Chromium background-timer throttling). So a campaign added while VS Code sat
  // in the background could stay unpushed until the window was touched again.
  // Re-pushing the instant the window regains focus makes new ads reliable
  // regardless of the timer: add a campaign → click back into VS Code → verbs
  // update live (no reload once the parser is in).
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void refreshSpinner(context);
    }),
  );

  // --- One-time welcome (sign in directly after install) --------------------
  void maybeWelcome(context);

  // --- Ad rotation — feeds the status bar AND ~/.idlepay/ad-cache.json, the
  // file the (local-only) statusline script renders from. Crediting stays in
  // the heartbeat below; this fetch uses the anonymous endpoint and never
  // touches the device's cooldown bucket.
  const refreshAd = (): void => { void rotateAd(adBar, state, developerId); };
  refreshAd();
  const adHandle = setInterval(refreshAd, REFRESH_AD_MS);

  // --- Account refresh --------------------------------------------------------
  const refreshAccount = (): void => { void updateAccount(accountBar, context, developerId, state); };
  refreshAccount();
  const accountHandle = setInterval(refreshAccount, REFRESH_ACCOUNT_MS);

  // --- Account menu (dashboard / sign out), opened by clicking the earnings item.
  context.subscriptions.push(
    vscode.commands.registerCommand(ACCOUNT_MENU_COMMAND, async () => {
      const items: (vscode.QuickPickItem & { run: string })[] = [
        { label: '$(dashboard) Open dashboard', run: DASHBOARD_COMMAND },
        {
          label: '$(sign-out) Sign out',
          description: 'Pause earning on this device',
          run: SIGNOUT_COMMAND,
        },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'idlepay account',
      });
      if (pick) void vscode.commands.executeCommand(pick.run);
    }),
    vscode.commands.registerCommand(SIGNOUT_COMMAND, async () => {
      // Forget the device token locally (and rewrite identity WITHOUT it for
      // legacy statuslines), so crediting stops — ads still show — until the
      // user signs in again. The server-side account link is left intact.
      await context.globalState.update(DEVICE_TOKEN_KEY, undefined);
      writeIdentity(developerId, undefined, apiUrl);
      accountBar.text = '$(sign-in) Sign in to idlepay';
      accountBar.tooltip = 'Signed out on this device — sign in to resume earning. You keep 50%.';
      accountBar.color = new vscode.ThemeColor('charts.yellow');
      accountBar.command = SIGNIN_COMMAND;
      refreshAccount();
      void vscode.window.showInformationMessage(
        'idlepay: signed out on this device. Ads still show, but earning is paused until you sign in again.',
      );
    }),
  );

  // --- Credited heartbeat — since statusline 0.1.0 this is the ONLY component
  // that talks to the network, so it is also the only crediting path (the
  // statusline script renders from ad-cache.json and asserts liveness via
  // ~/.idlepay/heartbeat, but never fetches). Crediting is gated on:
  //   (a) the window being focused, OR a fresh statusline heartbeat — the
  //       latter covers Claude running in an external terminal while VS Code
  //       sits in the background (inventory the statusline's own beacon used
  //       to credit; the heartbeat carries its per-session activity signal
  //       over instead of losing it);
  //   (b) AND a Claude session having written its transcript recently — so
  //       earning tracks actually using Claude, not "an editor is open".
  // The server still enforces the per-account cooldown + daily cap (which also
  // absorb overlap with legacy statusline beacons during the rollout window);
  // the ~30s cadence keeps the credit rate at the historical ~1/30s.
  const heartbeat = async (): Promise<void> => {
    const token = context.globalState.get<string>(DEVICE_TOKEN_KEY);
    if (!token) return; // not signed in → nothing to credit
    if (!vscode.window.state.focused && !(await hasFreshStatuslineHeartbeat())) return;
    if (!(await hasRecentClaudeActivity())) return; // no live Claude session → no credit
    void pingImpression(developerId, token);
  };
  void heartbeat(); // credit promptly on activation when already focused
  const heartbeatHandle = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  // --- statusLine watchdog — Claude Code can overwrite settings.json and drop
  // the statusLine key; re-install every 5 minutes to recover automatically.
  const statusLineHandle = setInterval(() => installStatusLine(context), 5 * 60_000);

  // Updates are owned by the editor's marketplace channel since 0.0.17 — the
  // homemade self-update (download a vsix from idlepay.co and install it) is
  // gone. Rationale: an extension that replaces itself from the vendor's site
  // defeats every trust property of a marketplace install (signing, listing,
  // changelog, user-controlled auto-update) — and that trust is the product.

  context.subscriptions.push(
    { dispose: () => clearInterval(adHandle) },
    { dispose: () => clearInterval(accountHandle) },
    { dispose: () => clearInterval(heartbeatHandle) },
    { dispose: () => clearInterval(statusLineHandle) },
  );

  console.log(`[idlepay] activated (developer ${developerId})`);
}

export function deactivate(): void {
  // deactivate() runs on EVERY window reload / host shutdown — NOT just on
  // uninstall. So it must tear NOTHING down. Previously it called
  // uninstallStatusLine(), which deleted ~/.idlepay (incl. identity.json) and
  // dropped the statusLine beacon on every reload — silently resetting earners
  // to $0 as the statusLine fell back to anonymous (uncredited) ads.
  // The statusLine self-heals on activation + via the 5-min watchdog, and the
  // spinner teardown lives in the explicit `idlepay.restoreSpinner` command.
  // Real teardown belongs to an explicit uninstall flow, never here.
}

// --- rendering ----------------------------------------------------------------

const JADE = '#12b981';

function renderAd(item: vscode.StatusBarItem, state: State): void {
  if (!state.ad) {
    item.text = '$(sparkle) idlepay';
    item.tooltip = 'idlepay — sponsored, revenue-shared';
    item.color = JADE;
    return;
  }
  item.text = `$(megaphone) ${state.ad.text}`;
  item.tooltip = state.ad.url
    ? `Sponsored · idlepay — click to open ${state.ad.url}`
    : 'Sponsored · idlepay';
  // Render each ad in its sponsor's brand colour when provided.
  item.color = hexColor(state.ad.style?.textColorHex) ?? JADE;
}

function hexColor(value: string | undefined): string | undefined {
  return value && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : undefined;
}

async function rotateAd(
  item: vscode.StatusBarItem,
  state: State,
  developerId: string,
): Promise<void> {
  try {
    state.ad = await fetchDisplayAd();
    renderAd(item, state);
    await writeAdCache(state.ad, developerId);
  } catch (err) {
    // Deliberately do NOT touch ad-cache.json here: its staleness is the
    // statusline's honest "nothing is fetching/crediting" signal.
    state.ad = null;
    renderAd(item, state);
    console.warn(`[idlepay] ad refresh skipped: ${(err as Error).message}`);
  }
}

// --- statusline ad cache ----------------------------------------------------
// The statusline script is local-only (no network, no identity): it renders
// whatever this file holds and shows "earnings paused — open VS Code" once it
// goes stale. The click URL is pre-resolved here so the script needs neither
// the API origin nor the device id.
const AD_CACHE_FILE = path.join(os.homedir(), '.idlepay', 'ad-cache.json');
const HEARTBEAT_FILE = path.join(os.homedir(), '.idlepay', 'heartbeat');

async function writeAdCache(ad: Ad, developerId: string): Promise<void> {
  try {
    const payload = JSON.stringify({
      fetchedAt: Date.now(),
      ad: { text: ad.text, url: clickThroughUrl(ad, developerId), style: ad.style },
    });
    // Write-then-rename: the statusline reads this file every ~5s, and a torn
    // JSON read would drop the ad for a tick. The rename is atomic on POSIX;
    // on Windows rename-over-existing can fail, so fall back to a direct
    // write (worst case there: one torn read, self-heals next tick).
    const tmp = `${AD_CACHE_FILE}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(AD_CACHE_FILE), { recursive: true });
    await fs.promises.writeFile(tmp, payload);
    try {
      await fs.promises.rename(tmp, AD_CACHE_FILE);
    } catch {
      await fs.promises.writeFile(AD_CACHE_FILE, payload);
      await fs.promises.rm(tmp, { force: true });
    }
  } catch (err) {
    console.warn(`[idlepay] ad cache write failed: ${(err as Error).message}`);
  }
}

/** True when the statusline recently proved a live, active Claude session. */
async function hasFreshStatuslineHeartbeat(): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.promises.stat(HEARTBEAT_FILE);
    return Date.now() - mtimeMs < STATUSLINE_HEARTBEAT_FRESH_MS;
  } catch {
    return false; // never written → no terminal session to vouch for
  }
}

// --- Claude activity gate -------------------------------------------------
// Claude Code (the CLI and the VS Code panel alike) appends every session's
// transcript under ~/.claude/projects/<project>/<session>.jsonl. A transcript
// modified in the last few minutes is the one signal that covers BOTH
// surfaces: someone is genuinely using Claude, not merely keeping a monetized
// editor window in the foreground.
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_ACTIVITY_WINDOW_MS = 5 * 60_000;
let lastActiveTranscript: string | null = null;

async function hasRecentClaudeActivity(): Promise<boolean> {
  const cutoff = Date.now() - CLAUDE_ACTIVITY_WINDOW_MS;

  // Fast path: the transcript that was active last tick usually still is,
  // so steady state costs one stat instead of a directory sweep.
  if (lastActiveTranscript) {
    try {
      if ((await fs.promises.stat(lastActiveTranscript)).mtimeMs >= cutoff) return true;
    } catch {
      /* deleted/rotated — fall through to the sweep */
    }
    lastActiveTranscript = null;
  }

  let projects: fs.Dirent[];
  try {
    projects = await fs.promises.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return false; // no Claude Code transcripts on this machine → nothing to credit
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(CLAUDE_PROJECTS_DIR, project.name);
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      try {
        if ((await fs.promises.stat(full)).mtimeMs >= cutoff) {
          lastActiveTranscript = full;
          return true;
        }
      } catch {
        /* raced a deletion — keep scanning */
      }
    }
  }
  return false;
}

/**
 * Publish the device identity for the statusLine process to read. With a token
 * it credits (/ad/<deviceId>); without one the statusLine shows ads anonymously.
 */
function writeIdentity(
  developerId: string,
  token: string | undefined,
  apiUrl: string | undefined,
): void {
  try {
    const dir = path.join(os.homedir(), '.idlepay');
    fs.mkdirSync(dir, { recursive: true });
    const payload: Record<string, string> = { deviceId: developerId };
    if (token) payload.token = token;
    if (apiUrl) payload.apiUrl = apiUrl;
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(payload));
  } catch {
    /* best effort — statusLine falls back to anonymous display */
  }
}

async function updateAccount(
  item: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  developerId: string,
  state: State,
): Promise<void> {
  try {
    const [profile, e] = await Promise.all([
      fetchProfile(developerId),
      fetchEarnings(developerId),
    ]);
    state.connected = profile.connected;
    const today = microToUsd(e.todayMicroUsd);
    const lifetime = microToUsd(e.lifetimeMicroUsd);
    // Earning needs BOTH a server-side account link AND the local device token
    // (cleared by Sign out). Without the token the statusLine can't credit, so
    // surface the sign-in prompt even when the account is still linked server-side.
    const hasToken = !!context.globalState.get<string>(DEVICE_TOKEN_KEY);

    if (profile.connected && hasToken) {
      const who = profile.login ? `@${profile.login}` : 'your account';
      item.text = `$(credit-card) ${today} today · ${lifetime} total`;
      item.tooltip = `Signed in as ${who}\nToday: ${today}\nThis month: ${microToUsd(e.monthMicroUsd)}\nLifetime: ${lifetime}\n${e.impressionCount} impressions\n\nClick for account options (dashboard · sign out)`;
      item.color = new vscode.ThemeColor('charts.green');
      item.command = ACCOUNT_MENU_COMMAND;
    } else if (profile.connected && !hasToken) {
      // Account is linked, but signed out on this device → not earning here.
      item.text = '$(sign-in) Sign in to idlepay';
      item.tooltip = 'Signed out on this device — sign in to resume earning. You keep 50%.';
      item.color = new vscode.ThemeColor('charts.yellow');
      item.command = SIGNIN_COMMAND;
    } else if (e.lifetimeMicroUsd > 0) {
      // Pending earnings — entice the claim in money-green.
      item.text = `$(sparkle) Claim ${lifetime}`;
      item.tooltip = `You've earned ${lifetime} so far — sign in to claim it. You keep 50%.`;
      item.color = new vscode.ThemeColor('charts.green');
      item.command = SIGNIN_COMMAND;
    } else {
      item.text = '$(sign-in) Sign in to idlepay';
      item.tooltip = 'Sign in to start tracking your earnings — you keep 50%';
      item.color = new vscode.ThemeColor('charts.yellow');
      item.command = SIGNIN_COMMAND;
    }
  } catch {
    // silently keep previous value
  }
}

function microToUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

// --- helpers ------------------------------------------------------------------

/**
 * Bake current ad labels into the Claude Code spinner. OPT-IN via the
 * `idlepay.patchSpinner` setting (see ensureSpinnerConsent for how it gets
 * set). Best-effort: failures are logged, never thrown.
 */
async function refreshSpinner(context: vscode.ExtensionContext): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('idlepay')
    .get<boolean>('patchSpinner', false);
  if (!enabled) return;

  try {
    // Native CLI binary patch (terminal / Homebrew claude) — plain text labels.
    // Fall back to the last-known labels when the fetch comes back empty (cold
    // API at boot), so a pristine binary is still re-baked instead of blanked.
    let labels = await fetchAdLabels();
    if (labels.length > 0) await context.globalState.update(SPINNER_LABELS_CACHE_KEY, labels);
    else labels = context.globalState.get<string[]>(SPINNER_LABELS_CACHE_KEY) ?? [];
    const r = applySpinnerPatch(labels);
    console.log(
      `[idlepay] binary spinner: patched ${r.patched.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`,
    );
    for (const f of r.failed) console.warn(`[idlepay] binary spinner failed ${f.binary}: ${f.reason}`);

    // VS Code spinner — rich ads (logo + brand colour + clickable link).
    // 1. Each ad enters the rotation via claudeCode.spinnerVerbs as a verb packed
    //    with its own styling ("TEXT␟{c,l,u}"), read live by Claude Code — so a new
    //    ad updates colour/logo/link WITHOUT a reload once the parser is live.
    // 2. applyWebviewPatch installs that parser. It's ad-independent (no data baked
    //    in), so it re-patches only when Claude Code ships a pristine bundle.
    // Claude Code restores a PRISTINE webview on every launch, so the cache
    // fallback below still matters: it keeps pushing the last-good verbs after a
    // cold/empty fetch instead of blanking the rotation.
    let ads = await fetchSpinnerAds();
    if (ads.length > 0) await context.globalState.update(SPINNER_ADS_CACHE_KEY, ads);
    else ads = context.globalState.get<SpinnerAd[]>(SPINNER_ADS_CACHE_KEY) ?? [];
    if (ads.length === 0) {
      console.warn('[idlepay] no spinner ads (live or cached) — keeping current spinner state');
      return;
    }

    // Independent: a failure setting the verbs must NOT block the webview patch
    // (and vice-versa). updateVSCodeSpinnerVerbs used to throw
    // ("claudeCode.spinnerVerbs is not a registered configuration") and abort the
    // whole refresh, so the webview never updated. The key is now declared in our
    // package.json so config.update is accepted; the try/catch is belt-and-braces.
    // Push packed (rich) verbs only when the live panel already carries our parser;
    // otherwise push plain text so a pristine/old render never shows raw JSON.
    try {
      await updateVSCodeSpinnerVerbs(ads, webviewParserLiveAtLoad);
    } catch (e) {
      console.warn(`[idlepay] spinnerVerbs update failed: ${(e as Error).message}`);
    }
    const wv = applyWebviewPatch(ads);
    console.log(
      `[idlepay] webview spinner: patched ${wv.patched.length}, skipped ${wv.skipped.length}, failed ${wv.failed.length}`,
    );
    for (const f of wv.failed) console.warn(`[idlepay] webview spinner failed ${f.binary}: ${f.reason}`);
  } catch (err) {
    console.warn(`[idlepay] spinner patch error: ${(err as Error).message}`);
  }
}

async function updateVSCodeSpinnerVerbs(ads: SpinnerAd[], rich: boolean): Promise<void> {
  // rich=true → pack each verb with its colour/logo/link ("TEXT␟{c,l,u}") so the
  // styling travels live and the patched render unpacks it with no reload. rich=
  // false → the running render is plain/pristine and would show the packed JSON as
  // garbage, so push plain text this session; the freshly-installed parser goes
  // live on the next window reload, and verbs are packed from then on.
  const verbs = rich
    ? ads.filter((a) => a.text).map(packSpinnerVerb)
    : ads.map((a) => a.text).filter(Boolean);
  const config = vscode.workspace.getConfiguration('claudeCode');
  if (verbs.length === 0) {
    await config.update('spinnerVerbs', undefined, vscode.ConfigurationTarget.Global);
    return;
  }
  // 'replace' = every spinner line is an ad (max exposure, matches the product
  // pitch). Switch to 'append' to mix ads in with Claude Code's default verbs.
  await config.update(
    'spinnerVerbs',
    { mode: 'replace', verbs },
    vscode.ConfigurationTarget.Global,
  );
  // Log the ad texts, not the packed verbs — a packed verb can carry a multi-KB
  // logo data URI and would flood the console.
  console.log(
    `[idlepay] claudeCode.spinnerVerbs updated (${rich ? 'rich' : 'plain'}): ${ads
      .map((a) => a.text)
      .join(', ')}`,
  );
}

/**
 * Resolve the spinner-patch consent state, once:
 *  - an explicit `idlepay.patchSpinner` setting always wins (never re-prompt);
 *  - installs upgrading from ≤0.0.16 ran with the patch on by default — keep
 *    their surface on by writing the setting explicitly, instead of silently
 *    turning their earnings off when the default flips to false;
 *  - fresh installs get a one-time prompt; a dismissed toast (no button
 *    clicked) asks again next activation, an answer is final.
 * Detection of "existing install" uses state only a prior version could have
 * written (spinner caches / device token) — NOT the welcome flag, which
 * maybeWelcome sets during this very activation for fresh installs too.
 */
async function ensureSpinnerConsent(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('idlepay');
  const explicit = config.inspect<boolean>('patchSpinner');
  if (explicit?.globalValue !== undefined || explicit?.workspaceValue !== undefined) return;
  if (context.globalState.get<string>(SPINNER_CONSENT_KEY)) return;

  const isExistingInstall =
    context.globalState.get(SPINNER_ADS_CACHE_KEY) !== undefined ||
    context.globalState.get(SPINNER_LABELS_CACHE_KEY) !== undefined ||
    context.globalState.get(DEVICE_TOKEN_KEY) !== undefined;
  if (isExistingInstall) {
    await config.update('patchSpinner', true, vscode.ConfigurationTarget.Global);
    await context.globalState.update(SPINNER_CONSENT_KEY, 'granted');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'idlepay: also show sponsored lines inside the Claude Code spinner? This patches your local Claude Code binary — reversible anytime ("idlepay: Restore Claude Code spinner to default").',
    'Enable spinner ads',
    'No thanks',
  );
  if (choice === 'Enable spinner ads') {
    await config.update('patchSpinner', true, vscode.ConfigurationTarget.Global);
    await context.globalState.update(SPINNER_CONSENT_KEY, 'granted');
  } else if (choice === 'No thanks') {
    await context.globalState.update(SPINNER_CONSENT_KEY, 'declined');
  }
}

async function maybeWelcome(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(WELCOMED_KEY)) return;
  await context.globalState.update(WELCOMED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'idlepay is installed — sign in to claim the earnings from your AI wait-time. You keep 50%.',
    'Sign in',
    'Later',
  );
  if (choice === 'Sign in') {
    void vscode.commands.executeCommand(SIGNIN_COMMAND);
  }
}

async function openCurrentAd(ad: Ad | null, developerId: string): Promise<void> {
  if (!ad?.url) {
    void vscode.window.showInformationMessage('idlepay: no link for this ad.');
    return;
  }
  // Open through the API's /r redirect (surface=extension): it counts the click
  // (reporting only) AND appends idlepay attribution — UTM params + a unique
  // idlepay_click_id + the served variant — to the landing URL, matching the
  // statusline. Falls back to the raw url for the fallback ad.
  const target = clickThroughUrl(ad, developerId, 'extension') ?? ad.url;
  if (!isSafeHttpUrl(target)) return;
  await vscode.env.openExternal(vscode.Uri.parse(target));
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function ensureDeveloperId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(DEVELOPER_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  void context.globalState.update(DEVELOPER_ID_KEY, id);
  return id;
}
