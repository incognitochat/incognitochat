import { describe, expect, it } from 'vitest';
import { cleanFileName, cleanLine, MAX_NAME } from './clean';

const ZWNJ = '\u200C';
const ZWJ = '\u200D';

describe('cleaning names', () => {
  it('drops bidi controls', () => {
    for (const c of ['\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u061C']) {
      expect(cleanLine(`a${c}b`)).toBe('ab');
    }
  });

  it('drops the byte-order mark and control characters', () => {
    expect(cleanLine('\uFEFFname')).toBe('name');
    for (let c = 0; c < 0x20; c++) {
      if ([0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(c)) continue;
      expect(cleanLine(`a${String.fromCharCode(c)}b`)).toBe('ab');
    }
    for (let c = 0x7f; c <= 0x9f; c++) {
      if (c === 0x85) continue;
      expect(cleanLine(`a${String.fromCharCode(c)}b`)).toBe('ab');
    }
  });

  it('makes line breaks and tabs a space: a name is one line', () => {
    for (const c of ['\t', '\n', '\v', '\f', '\r', '\u0085', '\u2028', '\u2029']) expect(cleanLine(`a${c}b`)).toBe('a b');
    expect(cleanLine('a\r\nb')).toBe('a  b');
  });

  it('leaves names people write as they are', () => {
    for (const name of [
      'report.pdf',
      'notes ✓.txt',
      'Résumé (final) [2].docx',
      // Persian, with ZWNJ inside words (the half-space).
      `می${ZWNJ}خواهم نامه${ZWNJ}ها.pdf`,
      'گزارش ۱۴۰۳.xlsx',
      '日本語のファイル.txt',
      // Emoji: ZWJ sequences, skin tones, flags (regional indicators and tags), keycaps, variation selectors.
      `family 👨${ZWJ}👩${ZWJ}👧.jpg`,
      `👩🏽${ZWJ}❤️${ZWJ}💋${ZWJ}👨🏻.png`,
      '👍🏿 ok.txt',
      '🇮🇷🇩🇪.txt',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} scotland.txt',
      '1\uFE0F\u20E3 #\uFE0F\u20E3 \u263A\uFE0E \u2764\uFE0F.txt',
      `\u{1F3F3}\uFE0F${ZWJ}\u{1F308}.gif`,
    ]) {
      expect(cleanLine(name)).toBe(name);
      expect(cleanFileName(name)).toBe(name);
    }
  });

  it('keeps ZWNJ and ZWJ but drops the bidi controls around them', () => {
    expect(cleanLine(`\u202Bمی${ZWNJ}خواهم\u202C`)).toBe(`می${ZWNJ}خواهم`);
    expect(cleanLine(`👨\u200E${ZWJ}👩`)).toBe(`👨${ZWJ}👩`);
  });
});

describe('cleaning file names', () => {
  it("can't hide the real extension", () => {
    // Shown as "photo_exe.jpg" with U+202E left in; saved as .exe.
    expect(cleanFileName('photo_\u202Egpj.exe')).toBe('photo_gpj.exe');
    expect(cleanFileName('invoice\u2067fdp.exe\u2069')).toBe('invoicefdp.exe');
    expect(cleanFileName('report.p\u200Fdf')).toBe('report.pdf');
  });

  it('names no folder', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(cleanFileName('..\\Windows\\a.bat')).toBe('.._Windows_a.bat');
    expect(cleanFileName('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('is one line', () => {
    expect(cleanFileName('a\nb.txt')).toBe('a b.txt');
  });

  it(`is at most ${MAX_NAME} long, never cutting a character in two`, () => {
    expect(cleanFileName('a'.repeat(1000) + '.exe')).toBe('a'.repeat(MAX_NAME));
    // 255 units would end in half of the 128th.
    expect(cleanFileName('😀'.repeat(200))).toBe('😀'.repeat(127));
    expect(cleanFileName('a' + '😀'.repeat(200))).toBe('a' + '😀'.repeat(127));
    expect(cleanFileName('\u202E'.repeat(300) + 'ok.txt')).toBe('ok.txt');
    expect(cleanFileName('x'.repeat(MAX_NAME))).toBe('x'.repeat(MAX_NAME));
  });

  it('is empty when nothing but spaces is left', () => {
    for (const name of ['\u202E', '\uFEFF\u200E', '\n\t', '   ', '\u0000']) expect(cleanFileName(name)).toBe('');
    expect(cleanFileName(' a ')).toBe(' a ');
  });
});
