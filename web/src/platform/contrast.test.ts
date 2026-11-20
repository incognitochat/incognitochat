import { describe, expect, it } from 'vitest';
import css from '../app.css?raw';
import { contrast, DARK_TEXT, LIGHT_TEXT, luminance, parseHex, textOn } from './contrast';

/** The colour tokens of a CSS block, by name. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--app-[a-z-]+):\s*(#[0-9a-f]+);/gi)].map((m) => [m[1]!, m[2]!]));
}

const LIGHT = tokens(/^:root \{([^}]*)\}/m.exec(css)![1]!);
const DARK = tokens(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='telegram'\]\) \{([^}]*)\}/.exec(css)![1]!);
const AA = 4.5;

describe('contrast', () => {
  it('reads #rgb, #rgba, #rrggbb and #rrggbbaa', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#F80a')).toEqual([255, 136, 0]);
    expect(parseHex('#2481CC')).toEqual([36, 129, 204]);
    expect(parseHex('#2481cc80')).toEqual([36, 129, 204]);
    for (const bad of ['red', '#12345', '#ggg', '2481cc', '#2481cc8']) expect(parseHex(bad)).toBeNull();
  });

  it('measures as WCAG 2 does', () => {
    expect(luminance('#ffffff')).toBe(1);
    expect(luminance('#000000')).toBe(0);
    expect(contrast('#ffffff', '#000000')).toBe(21);
    expect(contrast('#000000', '#ffffff')).toBe(21);
    expect(contrast('#777777', '#777777')).toBe(1);
    // The old defaults from the audit: white on the light accent, and on the dark red.
    expect(contrast('#ffffff', '#2481cc')).toBeCloseTo(4.13, 2);
    expect(contrast('#ffffff', '#f87171')).toBeCloseTo(2.77, 2);
    expect(contrast('#ffffff', 'red')).toBeNull();
  });

  it('puts dark text on light reds and white on dark ones', () => {
    expect(textOn('#f87171')).toBe(DARK_TEXT);
    expect(textOn('#ff3b30')).toBe(DARK_TEXT);
    expect(textOn('#ff595a')).toBe(DARK_TEXT);
    expect(textOn('#dc2626')).toBe(LIGHT_TEXT);
    expect(textOn('#cc2929')).toBe(LIGHT_TEXT);
    expect(textOn('#7f1d1d')).toBe(LIGHT_TEXT);
    expect(textOn('not a colour')).toBeNull();
  });

  it('always finds text that passes AA', () => {
    const steps = [0x00, 0x33, 0x66, 0x80, 0x99, 0xb3, 0xcc, 0xe6, 0xff];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const background = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          expect(contrast(textOn(background)!, background)).toBeGreaterThanOrEqual(AA);
        }
      }
    }
  });
});

describe('the default colours (app.css)', () => {
  const pairs: [text: string, background: string][] = [
    ['--app-text', '--app-bg'],
    ['--app-text', '--app-surface'],
    ['--app-muted', '--app-bg'],
    ['--app-muted', '--app-surface'],
    ['--app-on-accent', '--app-accent'],
    ['--app-accent', '--app-bg'],
    ['--app-accent', '--app-surface'],
    ['--app-on-danger', '--app-danger'],
    ['--app-danger', '--app-bg'],
    ['--app-danger', '--app-surface'],
  ];

  for (const [theme, colours] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    it(`pass AA in the ${theme} theme`, () => {
      // Dark mode only overrides the tokens; the rest come from the light ones.
      const all = { ...LIGHT, ...colours };
      for (const [text, background] of pairs) {
        expect(contrast(all[text] ?? '', all[background] ?? '') ?? 0, `${text} on ${background}`).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`choose text on the red as Telegram's colours get it (${theme})`, () => {
      expect(colours['--app-on-danger']).toBe(textOn(colours['--app-danger']!));
    });
  }
});
