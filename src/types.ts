/**
 * Ad types shared with the idlepay API (vendored — the server-side repo is
 * private, these are the only types the client needs).
 */

/**
 * Where/how an ad is rendered. For now idlepay only supports a single
 * sponsored line injected into the extension's spinner.
 */
export type AdFormat = 'spinner-line';

/**
 * Advertiser-controlled presentation. These are intentionally STRUCTURED
 * (colours as hex, flags) — never raw ANSI — so the renderer can
 * sanitise them and generate the escape codes itself. This prevents an
 * advertiser from injecting terminal escape sequences via ad content.
 */
export interface AdStyle {
  /** Ad text colour (hex, e.g. "#A5B4FC"). Invalid values are ignored. */
  textColorHex?: string;

  /** Badge background colour (hex). Invalid values fall back to a default. */
  badgeColorHex?: string;

  /** Render the ad text bold (default true). */
  bold?: boolean;
}

/**
 * A sponsored creative served to the extension and shown in the spinner.
 */
export interface Ad {
  /** Stable ad identifier. */
  id: string;

  /** Campaign this ad belongs to (an advertiser may run several). */
  campaignId: string;

  /** The sponsored text shown in the spinner. Kept short on purpose. */
  text: string;

  /** Optional landing URL recorded on click. */
  url?: string;

  /** Rendering format. */
  format: AdFormat;

  /**
   * Price the advertiser pays per thousand impressions (CPM), in micro-USD.
   */
  cpmMicroUsd: number;

  /** Advertiser-controlled presentation (colours). Sanitised before render. */
  style?: AdStyle;

  /** Advertiser logo URL — for rich surfaces (extension tooltip/webview), not the terminal. */
  logoUrl?: string;
}
