// Contrast between colours, as WCAG 2 measures it, so text stays readable on
// the colours Telegram's theme supplies. AA asks 4.5:1 for normal text.

/** A colour's red, green and blue (0–255) from #rgb, #rgba, #rrggbb or #rrggbbaa (any alpha is ignored); null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** Relative luminance: 0 for black, 1 for white. */
export function luminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, from 1 (the same) to 21 (black and white); null if either isn't a colour. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const DARK_TEXT = '#000000';
export const LIGHT_TEXT = '#ffffff';

/**
 * Black or white text, whichever reads better on a background: dark text on
 * light reds, white on dark ones. One of the two always reaches 4.58:1.
 */
export function textOn(background: string): string | null {
  const light = contrast(LIGHT_TEXT, background);
  const dark = contrast(DARK_TEXT, background);
  if (light === null || dark === null) return null;
  return light >= dark ? LIGHT_TEXT : DARK_TEXT;
}
