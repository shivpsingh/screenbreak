import type { FontChoice } from "../types/settings";

/**
 * Pure theme derivation.
 *
 * The user picks any background colour they like; the readable text colour is
 * computed from it rather than being a second setting they could get wrong.
 * That is what lets the colour picker stay unrestricted without risking a
 * break screen nobody can read.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The two candidates text can be drawn in. */
const LIGHT_TEXT: Rgb = { r: 244, g: 244, b: 246 };
const DARK_TEXT: Rgb = { r: 16, g: 16, b: 20 };

export const FALLBACK_BACKGROUND = "#101014";

/** Parses `#rrggbb`, returning `null` for anything else. */
export function parseHex(hex: string): Rgb | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const pair = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * WCAG relative luminance.
 *
 * Uses the proper sRGB gamma expansion rather than averaging the channels,
 * which would badly misjudge saturated colours — pure blue and pure yellow
 * average identically but differ enormously in perceived brightness.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The more readable of light or dark text on `background`.
 *
 * Chosen by comparing actual contrast ratios rather than thresholding the
 * luminance, which picks the wrong one for mid-tone backgrounds where the two
 * are close.
 */
export function foregroundFor(background: string): string {
  const bg = parseHex(background) ?? parseHex(FALLBACK_BACKGROUND)!;
  const light = contrastRatio(bg, LIGHT_TEXT);
  const dark = contrastRatio(bg, DARK_TEXT);
  return toHex(light >= dark ? LIGHT_TEXT : DARK_TEXT);
}

/**
 * A dimmer foreground for the sub-message and the Esc hint.
 *
 * Blended toward the background rather than given a fixed opacity so it stays
 * proportionally legible on both very dark and very light backgrounds. The
 * ratio keeps it clearly secondary while remaining readable.
 */
export function mutedForegroundFor(background: string, weight = 0.65): string {
  const bg = parseHex(background) ?? parseHex(FALLBACK_BACKGROUND)!;
  const fg = parseHex(foregroundFor(background))!;
  return toHex({
    r: bg.r + (fg.r - bg.r) * weight,
    g: bg.g + (fg.g - bg.g) * weight,
    b: bg.b + (fg.b - bg.b) * weight,
  });
}

/**
 * The CSS `font-family` stack for a font choice.
 *
 * "Ubuntu Mono" is bundled via `@font-face`, so it is listed first and still
 * falls back to a generic monospace stack if the file ever fails to load.
 */
export function fontStackFor(choice: FontChoice): string {
  switch (choice) {
    case "ubuntuMono":
      return '"Ubuntu Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    case "serif":
      return 'Georgia, "Times New Roman", "Noto Serif", serif';
    case "monospace":
      return 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
    case "system":
      return 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
  }
}

/** The custom properties the break screen's stylesheet reads. */
export function breakThemeVariables(
  background: string,
  font: FontChoice,
): Record<string, string> {
  // An unparseable colour should still produce a usable screen; Rust validates
  // on save, so this only guards against a hand-edited settings file.
  const safeBackground = parseHex(background) ? background.toLowerCase() : FALLBACK_BACKGROUND;
  return {
    "--break-bg": safeBackground,
    "--break-fg": foregroundFor(safeBackground),
    "--break-fg-muted": mutedForegroundFor(safeBackground),
    "--break-font": fontStackFor(font),
  };
}
