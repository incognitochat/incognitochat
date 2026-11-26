import { describe, expect, it } from 'vitest';
import { applyInsets, applyTheme } from './theme';

function fakeRoot() {
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => (props[k] = v) }, dataset: {} as Record<string, string> };
  return { root: root as unknown as HTMLElement, props, dataset: root.dataset };
}

describe('applyTheme', () => {
  it('maps Telegram colours onto app tokens', () => {
    const { root, props, dataset } = fakeRoot();
    applyTheme({ bg_color: '#17212b', text_color: '#f5f5f5', button_color: '#5288c1', unknown_color: '#123456' }, root);
    expect(props).toEqual({ '--app-bg': '#17212b', '--app-text': '#f5f5f5', '--app-accent': '#5288c1' });
    expect(dataset.theme).toBe('telegram');
  });

  it("maps a newer client's section and bottom bar colours, which older ones don't send", () => {
    const { root, props } = fakeRoot();
    applyTheme({ section_bg_color: '#17212b', section_separator_color: '#111921', bottom_bar_bg_color: '#1d2733' }, root);
    expect(props).toEqual({ '--app-section': '#17212b', '--app-separator': '#111921', '--app-bar': '#1d2733' });
  });

  it('picks black or white text for the destructive colour, whichever reads better', () => {
    const light = fakeRoot();
    applyTheme({ destructive_text_color: '#ff595a' }, light.root);
    expect(light.props).toEqual({ '--app-danger': '#ff595a', '--app-on-danger': '#000000' });
    const dark = fakeRoot();
    applyTheme({ destructive_text_color: '#cc2929' }, dark.root);
    expect(dark.props).toEqual({ '--app-danger': '#cc2929', '--app-on-danger': '#ffffff' });
    const none = fakeRoot();
    applyTheme({ destructive_text_color: 'red', bg_color: '#ffffff' }, none.root);
    expect(none.props).toEqual({ '--app-bg': '#ffffff' });
  });

  it('ignores values that are not colours', () => {
    const { root, props, dataset } = fakeRoot();
    applyTheme({ bg_color: 'red; background: url(x)', text_color: 'expression(1)' }, root);
    expect(props).toEqual({});
    expect(dataset.theme).toBeUndefined();
  });
});

describe('applyInsets', () => {
  it('adds the safe area and the content safe area at the bottom, within reason', () => {
    const props: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => (props[k] = v) } } as unknown as HTMLElement;
    applyInsets({ safe: { top: 47, bottom: 34, left: 0, right: 0 } }, root);
    expect(props['--app-safe-bottom']).toBe('34px');
    applyInsets({ content: { top: 46, bottom: 10, left: 0, right: 0 } }, root);
    expect(props['--app-safe-bottom']).toBe('44px');
    applyInsets({ safe: { bottom: 'calc(9999px)' } }, root);
    expect(props['--app-safe-bottom']).toBe('44px');
    applyInsets({ safe: { top: 0, bottom: 5000, left: 0, right: 0 } }, root);
    expect(props['--app-safe-bottom']).toBe('200px');
  });
});
