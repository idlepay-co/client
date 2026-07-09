import type { Ad } from './types';

const DEFAULT_ORIGIN = 'https://qrqt933izf.eu-west-1.awsapprunner.com';
const REQUEST_TIMEOUT_MS = 5_000;
// /ads returns the full active set with logo data URIs (larger payload); give it
// more headroom than the small endpoints so a cold API instance doesn't time out.
const ADS_REQUEST_TIMEOUT_MS = 12_000;

let apiOrigin = DEFAULT_ORIGIN;

/** Set from extension.ts using the `idlepay.apiUrl` VS Code setting. */
export function setApiOrigin(origin: string): void {
  if (origin) apiOrigin = origin.replace(/\/$/, '');
}

export interface DeveloperEarnings {
  developerId: string;
  todayMicroUsd: number;
  monthMicroUsd: number;
  lifetimeMicroUsd: number;
  impressionCount: number;
}

export interface DeveloperProfile {
  developerId: string;
  connected: boolean;
  login: string | null;
}

function endpoint(path: string): string {
  const url = new URL(path, apiOrigin);
  if (url.origin !== apiOrigin) {
    throw new Error(`blocked outbound request to ${url.origin}`);
  }
  return url.toString();
}

/**
 * Display-only ad for the VS Code status bar and the statusline's ad cache.
 * Uses the anonymous endpoint on purpose: crediting is owned solely by
 * pingImpression (the gated heartbeat), so this rotation must NOT record
 * impressions or touch the device's cooldown bucket.
 */
export async function fetchDisplayAd(): Promise<Ad> {
  const res = await fetch(endpoint('/ad'), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /ad -> ${res.status}`);
  const data: unknown = await res.json();
  if (!isAd(data)) throw new Error('GET /ad returned unexpected payload');
  return data;
}

/**
 * Credited impression beacon — the extension-side equivalent of the statusLine.
 * Hits the per-device endpoint WITH the server-issued token so the server records
 * an impression (still subject to its per-account cooldown + daily cap). This
 * exists because Claude Code does NOT run the `statusLine` command inside the VS
 * Code panel, so the statusLine-only path never fires there. Best-effort and
 * fire-and-forget: never throws. Only call while a Claude session is genuinely
 * active (e.g. window focused) — crediting on "editor merely open" is what the
 * server-side anti-fraud caps guard against.
 */
export async function pingImpression(developerId: string, token: string): Promise<void> {
  try {
    await fetch(endpoint(`/ad/${encodeURIComponent(developerId)}`), {
      method: 'GET',
      // x-idlepay-active: the server only credits with this activity assertion.
      // Safe to send unconditionally here because the heartbeat's caller is
      // already gated on real Claude activity (focus or statusline heartbeat).
      // x-idlepay-surface: recorded on the impression row (0019) so beacon
      // sources can be told apart in the data — legacy clients send nothing.
      headers: {
        accept: 'application/json',
        'x-idlepay-token': token,
        'x-idlepay-active': '1',
        'x-idlepay-surface': 'extension',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    /* best-effort beacon — the next tick retries */
  }
}

/**
 * Click-through URL routed through the API's /r/<campaignId> redirect, which
 * counts the click (reporting only) and 302s to the landing page with idlepay
 * attribution appended (UTM params + a unique idlepay_click_id). `d` attaches
 * the developer id, `v` the served creative variant (per-variant stats), and
 * `s` the surface. Used both for the statusline (baked into
 * ~/.idlepay/ad-cache.json) and the status-bar ad. Falls back to the raw
 * landing URL for the fallback ad.
 */
export function clickThroughUrl(
  // Minimal shape so both a full Ad and a SpinnerAd (spinner/Codex rosters) qualify.
  ad: { campaignId?: string; variantId?: string; url?: string },
  developerId: string,
  surface: 'statusline' | 'extension' | 'spinner' | 'codex' = 'statusline',
): string | undefined {
  if (ad.campaignId && ad.campaignId !== 'fallback') {
    const params = new URLSearchParams({ d: developerId, s: surface });
    if (ad.variantId) params.set('v', ad.variantId);
    return endpoint(`/r/${encodeURIComponent(ad.campaignId)}?${params.toString()}`);
  }
  return ad.url;
}

/**
 * First-party click beacon for the status-bar ad. Reporting only — never bills
 * or credits — and best-effort: a failed beacon must never block opening the ad.
 */
export async function postClick(campaignId: string, developerId?: string): Promise<void> {
  try {
    await fetch(endpoint('/click'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId, developer_id: developerId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    /* swallow — clicks are best-effort */
  }
}

export async function fetchEarnings(developerId: string): Promise<DeveloperEarnings> {
  const res = await fetch(
    endpoint(`/developer/${encodeURIComponent(developerId)}/earnings`),
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`GET /developer/earnings -> ${res.status}`);
  return res.json() as Promise<DeveloperEarnings>;
}

export async function fetchProfile(developerId: string): Promise<DeveloperProfile> {
  const res = await fetch(
    endpoint(`/developer/${encodeURIComponent(developerId)}/profile`),
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`GET /developer/profile -> ${res.status}`);
  return res.json() as Promise<DeveloperProfile>;
}

/**
 * Active ad labels to bake into the spinner. Read-only endpoint — records no
 * impressions (real impressions come from the statusLine hitting /ad/<id>).
 */
export async function fetchAdLabels(): Promise<string[]> {
  try {
    const res = await fetch(endpoint('/ad-labels'), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface SpinnerAd {
  text: string;
  url?: string;
  color?: string;
  logo?: string;
  // Carried so the render surfaces (Claude spinner webview, Codex bar) can route
  // clicks through /r for counting + attribution — see clickThroughUrl.
  campaignId?: string;
  variantId?: string;
}

function toSpinnerAd(ad: Ad): SpinnerAd {
  return {
    text: ad.text,
    url: ad.url,
    color: ad.style?.textColorHex,
    logo: ad.logoUrl,
    campaignId: ad.campaignId,
    variantId: ad.variantId,
  };
}

/**
 * The full active-campaign set as rich ads for the VS Code spinner, in ONE
 * deterministic call (`GET /ads`, records no impressions) — every active
 * campaign, so the panel never silently drops one. Returns [] on any error;
 * the caller (refreshSpinner) then keeps the last-good full set from its cache
 * rather than degrading. `/ads` carries logo data URIs, so allow a longer
 * timeout than the small endpoints to tolerate a cold API instance.
 */
export async function fetchSpinnerAds(): Promise<SpinnerAd[]> {
  try {
    const res = await fetch(endpoint('/ads'), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(ADS_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isAd).map(toSpinnerAd);
  } catch {
    // Never sample /ad as a fallback: one weighted-random campaign per call
    // yields a partial, non-deterministic subset that silently drops ads.
    // Empty lets refreshSpinner reuse the cached full set instead.
    return [];
  }
}

function isAd(value: unknown): value is Ad {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.text === 'string';
}
