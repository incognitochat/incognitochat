import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat, toBase64Url, utf8 } from '../crypto/encoding';
import { exportPublicKey, generateCopyableAgreementKey } from '../crypto/keys';
import { fixedKeys, seedCrypto } from '../testing/crypto';
import { Random } from '../testing/random';
import { EnvelopeError, keyId, MAX_INNER, openEnvelope, sealEnvelope, sendTokensFor } from './envelope';
import {
  checkMessage,
  fileName,
  isReactionEmoji,
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  mediaName,
  MessageError,
  newId,
  openMessage,
  passiveType,
  sealMessage,
  shownAs,
  type ConversationKey,
  type Draft,
  type Media,
  type Message,
} from './message';

async function conversationKey(): Promise<ConversationKey & { id: Uint8Array }> {
  const pair = await generateCopyableAgreementKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  return { privateKey: pair.privateKey, publicKey, id: await keyId(publicKey) };
}

const finder = (...keys: (ConversationKey & { id: Uint8Array })[]) => async (id: Uint8Array) =>
  keys.find((k) => k.id.every((b, i) => b === id[i]));

const draft = (extra: Partial<Draft> = {}): Draft => ({ kind: 'message', conv: newId(), id: newId(), at: 1_800_000_000_000, text: 'سلام 👋', ...extra });

describe('messages', () => {
  it('round-trip, carrying who wrote them and for which key', async () => {
    const sender = await conversationKey();
    const linkKey = await conversationKey();
    const reply = newId();
    const tag = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const envelope = await sealMessage(draft({ reply, tag }), sender, linkKey.publicKey);
    const { message, keyId: opened } = await openMessage(envelope, finder(linkKey));
    expect(message).toMatchObject({ v: 1, kind: 'message', text: 'سلام 👋', reply, tag, from: toBase64Url(sender.publicKey) });
    expect(opened).toEqual(linkKey.id);
  });

  it('reject a claimed sender who did not write it', async () => {
    const victim = await conversationKey();
    const attacker = await conversationKey();
    const recipient = await conversationKey();
    // The attacker puts the victim's key in "from" but can only tag with their own.
    const forged = await sealMessage(draft(), { privateKey: attacker.privateKey, publicKey: victim.publicKey }, recipient.publicKey);
    await expect(openMessage(forged, finder(recipient))).rejects.toThrow('bad tag');
  });

  it('reject a message re-addressed to another key', async () => {
    const sender = await conversationKey();
    const meant = await conversationKey();
    const other = await conversationKey();
    // A genuine message for "meant", re-wrapped (by someone holding both) to "other".
    const json = utf8(
      JSON.stringify({ v: 1, ...draft(), from: toBase64Url(sender.publicKey), to: toBase64Url(meant.id) }),
    );
    const envelope = await sealEnvelope([other.publicKey], concat(new Uint8Array(32), json));
    await expect(openMessage(envelope, finder(other))).rejects.toThrow('written for another key');
  });

  it('carry seen receipts and key updates without text', async () => {
    const a = await conversationKey();
    const b = await conversationKey();
    const seen = [newId(), newId()];
    const receipt: Draft = { kind: 'seen', conv: newId(), id: newId(), at: 1, seen };
    const { message } = await openMessage(await sealMessage(receipt, a, b.publicKey), finder(b));
    expect(message.seen).toEqual(seen);
    // One that says the earlier ones were read too.
    const all = await openMessage(await sealMessage({ ...receipt, earlier: true }, a, b.publicKey), finder(b));
    expect(all.message).toMatchObject({ seen, earlier: true });
    const update = await sealMessage({ kind: 'key_update', conv: newId(), id: newId(), at: 1 }, a, b.publicKey);
    expect((await openMessage(update, finder(b))).message.kind).toBe('key_update');
  });

  it('limit text length', async () => {
    const a = await conversationKey();
    const b = await conversationKey();
    await expect(sealMessage(draft({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) }), a, b.publicKey)).rejects.toThrow(MessageError);
    const longest = await sealMessage(draft({ text: 'x'.repeat(MAX_TEXT_BYTES) }), a, b.publicKey);
    expect((await openMessage(longest, finder(b))).message.text).toHaveLength(MAX_TEXT_BYTES);
  });
});

describe('checkMessage', () => {
  const valid = {
    v: 1,
    kind: 'message',
    conv: 'AAAAAAAAAAAAAAAAAAAAAA',
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    at: 1,
    from: toBase64Url(new Uint8Array(65)),
    to: 'AAAAAAAAAAA',
    text: 'hi',
  };

  const media = {
    t: 'photo',
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    k: toBase64Url(new Uint8Array(32)),
    d: 'AAAAAAAAAAAAAAAAAAAAAA',
    s: 1234,
    m: 'image/jpeg',
    w: 800,
    h: 600,
    p: 'abcd',
  };

  it('accepts a well-formed message and ignores unknown fields', () => {
    expect(checkMessage({ ...valid, future: true }).text).toBe('hi');
  });

  it.each([
    ['version', { v: 2 }],
    ['kind', { kind: 'other' }],
    ['short conv', { conv: 'AAAA' }],
    ['non-canonical id', { id: 'AAAAAAAAAAAAAAAAAAAAAB' }],
    ['time', { at: -1 }],
    ['to', { to: 'AAAAAAAAAAAAAAAA' }],
    ['empty text', { text: '  ' }],
    ['text on seen', { kind: 'seen', seen: ['AAAAAAAAAAAAAAAAAAAAAA'] }],
    ['seen without ids', { kind: 'seen', text: undefined }],
    ['text on end', { kind: 'end' }],
    ['bad reply', { reply: 'x' }],
    ['media kind', { media: { ...media, t: 'Hologram!' } }],
    ['media length', { media: { ...media, t: 'video', l: 1.5 } }],
    ['media waveform', { media: { ...media, t: 'voice', v: toBase64Url(new Uint8Array(101)) } }],
    ['empty waveform', { media: { ...media, t: 'voice', v: '' } }],
    ['media key', { media: { ...media, k: 'AAAA' } }],
    ['media size', { media: { ...media, s: 50 * 1024 * 1024 + 1 } }],
    ['media type', { media: { ...media, m: 'not a type' } }],
    ['media preview', { media: { ...media, p: 'x'.repeat(3001) } }],
    ['media on seen', { kind: 'seen', text: undefined, seen: ['AAAAAAAAAAAAAAAAAAAAAA'], media }],
    ['media on end', { kind: 'end', text: undefined, media }],
    ['earlier on a message', { earlier: true }],
    ['earlier as anything but true', { kind: 'seen', text: undefined, seen: ['AAAAAAAAAAAAAAAAAAAAAA'], earlier: 1 }],
  ])('rejects bad %s', (_, change) => {
    expect(() => checkMessage({ ...valid, ...change })).toThrow(MessageError);
  });

  it('accepts an attachment, with or without a caption', () => {
    expect(checkMessage({ ...valid, media }).media).toEqual(media);
    expect(checkMessage({ ...valid, text: undefined, media }).media?.t).toBe('photo');
    const video = { ...media, t: 'video', m: 'video/mp4', l: 42 };
    expect(checkMessage({ ...valid, media: video }).media).toEqual(video);
    const voice = { t: 'voice', id: media.id, k: media.k, d: media.d, s: 900, m: 'audio/mp4', l: 7, v: toBase64Url(new Uint8Array([0, 128, 255])) };
    expect(checkMessage({ ...valid, text: undefined, media: voice }).media).toEqual(voice);
    const round = { t: 'round', id: media.id, k: media.k, d: media.d, s: 4_000_000, m: 'video/mp4', w: 384, h: 384, l: 12 };
    expect(shownAs(checkMessage({ ...valid, text: undefined, media: round }).media!)).toBe('round');
  });

  it('takes in any name and sticker emoji, to be cleaned where shown: refusing would lose the message', () => {
    for (const n of ['photo_\u202Egpj.exe', '../../a\nb\\c', '\u202E', 'x'.repeat(255)]) {
      expect(checkMessage({ ...valid, media: { ...media, t: 'file', n } }).media?.n).toBe(n);
    }
    for (const e of ['ok', '\u202Eab', 'a\u0301\u0301\u0301']) {
      expect(checkMessage({ ...valid, text: undefined, sticker: { id: 'new_pack/cat', e } }).sticker?.e).toBe(e);
    }
  });

  it('takes in `end`, reserved, with nothing on it', () => {
    expect(checkMessage({ ...valid, kind: 'end', text: undefined }).kind).toBe('end');
  });

  it('accepts a sticker on its own', () => {
    const sticker = { id: 'faces/winking_face', e: '😉' };
    expect(checkMessage({ ...valid, text: undefined, sticker }).sticker).toEqual(sticker);
    expect(checkMessage({ ...valid, text: undefined, sticker: { id: 'new_pack/cat' } }).sticker?.id).toBe('new_pack/cat');
    for (const bad of [
      { ...valid, sticker },
      { ...valid, text: undefined, media, sticker },
      { ...valid, text: undefined, sticker: { id: 'Faces/Wink' } },
      { ...valid, text: undefined, sticker: { id: 'faces' } },
      { ...valid, text: undefined, sticker: { id: '../x/y' } },
      { ...valid, text: undefined, sticker: { id: 'faces/x', e: '' } },
      { ...valid, text: undefined, sticker: 'faces/x' },
      { ...valid, kind: 'end', text: undefined, sticker },
    ]) {
      expect(() => checkMessage(bad)).toThrow(MessageError);
    }
  });

  it('accepts a reaction: one emoji, or empty to take it back', () => {
    const reaction = { ...valid, kind: 'reaction', text: undefined };
    for (const e of ['👍', '❤️', '👨‍👩‍👧', '🇮🇷', '1️⃣', '']) {
      expect(checkMessage({ ...reaction, reaction: { to: valid.id, e } }).reaction).toEqual({ to: valid.id, e });
    }
    for (const bad of [
      reaction,
      { ...reaction, reaction: { to: valid.id, e: '👍\u0301\u0301\u0301' } },
      { ...reaction, reaction: { to: valid.id, e: 'ok' } },
      { ...reaction, reaction: { to: valid.id, e: '👍👍' } },
      { ...reaction, reaction: { to: valid.id, e: 'a' } },
      { ...reaction, reaction: { to: 'short', e: '👍' } },
      { ...reaction, reaction: { to: valid.id } },
      { ...reaction, reaction: '👍' },
      { ...reaction, text: 'hi', reaction: { to: valid.id, e: '👍' } },
      { ...valid, reaction: { to: valid.id, e: '👍' } },
      { ...valid, kind: 'seen', text: undefined, seen: [valid.id], reaction: { to: valid.id, e: '👍' } },
    ]) {
      expect(() => checkMessage(bad)).toThrow(MessageError);
    }
  });

  it('accepts a delete naming 1 to 100 messages, and nothing else', () => {
    const del = { ...valid, kind: 'delete', text: undefined };
    expect(checkMessage({ ...del, delete: [valid.id] }).delete).toEqual([valid.id]);
    // Or the whole conversation.
    expect(checkMessage({ ...del, all: true }).all).toBe(true);
    for (const bad of [
      del,
      { ...del, delete: [] },
      { ...del, delete: Array.from({ length: 101 }, () => valid.id) },
      { ...del, delete: ['short'] },
      { ...del, delete: valid.id },
      { ...del, delete: [valid.id], text: 'hi' },
      { ...valid, delete: [valid.id] },
      { ...valid, kind: 'reaction', text: undefined, reaction: { to: valid.id, e: '👍' }, delete: [valid.id] },
      { ...del, delete: [valid.id], all: true },
      { ...del, all: false },
      { ...del, all: 'yes' },
      { ...valid, all: true },
    ]) {
      expect(() => checkMessage(bad)).toThrow(MessageError);
    }
  });

  it('accepts an edit: one message and its new text', () => {
    const edit = { ...valid, kind: 'edit', text: undefined };
    expect(checkMessage({ ...edit, edit: { to: valid.id, text: 'fixed' } }).edit).toEqual({ to: valid.id, text: 'fixed' });
    expect(checkMessage({ ...edit, edit: { to: valid.id, text: '' } }).edit?.text).toBe('');
    for (const bad of [
      edit,
      { ...edit, edit: { to: valid.id } },
      { ...edit, edit: { to: 'short', text: 'x' } },
      { ...edit, edit: { to: valid.id, text: 'x'.repeat(12_001) } },
      { ...edit, edit: 'fixed' },
      { ...edit, edit: { to: valid.id, text: 'x' }, text: 'x' },
      { ...valid, edit: { to: valid.id, text: 'x' } },
    ]) {
      expect(() => checkMessage(bad)).toThrow(MessageError);
    }
  });

  it('accepts kinds from newer versions and shows them as files', () => {
    const voice = checkMessage({ ...valid, media: { ...media, t: 'voice_note' } }).media!;
    expect(shownAs(voice)).toBe('file');
    expect(shownAs({ t: 'gif', m: 'image/gif' })).toBe('gif');
  });

  it('shows only raster images in the chat: anything else called a photo or GIF is a file', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(shownAs({ t: 'photo', m })).toBe('photo');
      expect(shownAs({ t: 'gif', m })).toBe('gif');
    }
    for (const m of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'image/bmp', undefined]) {
      expect(shownAs({ t: 'photo', ...(m ? { m } : {}) })).toBe('file');
      expect(shownAs({ t: 'gif', ...(m ? { m } : {}) })).toBe('file');
    }
    // Checked as a received message would be.
    expect(shownAs(checkMessage({ ...valid, media: { ...media, t: 'photo', m: 'image/svg+xml' } }).media!)).toBe('file');
  });

  it('hands the browser only passive types: images, audio and video', () => {
    expect(passiveType(undefined)).toBeUndefined();
    for (const m of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'audio/ogg', 'audio/mp4']) expect(passiveType(m)).toBe(m);
    for (const m of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/pdf', 'text/plain']) expect(passiveType(m)).toBe('application/octet-stream');
  });

  it('takes one emoji as a reaction, with only the marks emoji use', () => {
    for (const e of [
      '👍',
      '👍🏿',
      '\u2764\uFE0F',
      '\u263A\uFE0E',
      '1\uFE0F\u20E3',
      '#\uFE0F\u20E3',
      '🇮🇷',
      // A flag with tags (Scotland).
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
      '👨\u200D👩\u200D👧',
      '👩🏽\u200D\u2764\uFE0F\u200D💋\u200D👨🏻',
      '\u{1F3F3}\uFE0F\u200D\u{1F308}',
    ]) {
      expect(isReactionEmoji(e)).toBe(true);
    }
    for (const e of ['', 'a', 'ok', '👍👍', '👍\u0301', '👍' + '\u0336'.repeat(10), '\u2764\u20DD', '1\u20E3\u0308', '\u202E👍']) {
      expect(isReactionEmoji(e)).toBe(false);
    }
  });

  it('names attachments for saving', () => {
    expect(fileName({ t: 'file', n: 'report.pdf' })).toBe('report.pdf');
    expect(fileName({ t: 'photo', m: 'image/jpeg' })).toBe('photo.jpg');
    expect(fileName({ t: 'video', m: 'video/quicktime' })).toBe('video.mov');
    expect(fileName({ t: 'gif', m: 'image/gif' })).toBe('animation.gif');
    expect(fileName({ t: 'voice_note' })).toBe('file');
    expect(fileName({ t: 'voice', m: 'audio/mp4' })).toBe('voice.m4a');
    expect(fileName({ t: 'round', m: 'video/mp4' })).toBe('video.mp4');
    expect(fileName({ t: 'audio', n: 'song.mp3', m: 'audio/mpeg' })).toBe('song.mp3');
  });

  it("cleans a sender's file name for showing, sharing and saving", () => {
    // The bidi override would show "photoexe.jpg"; the file is an .exe.
    expect(fileName({ t: 'file', n: 'photo\u202Egpj.exe' })).toBe('photogpj.exe');
    expect(fileName({ t: 'file', n: 'a\u2066b\u2069.pdf\u200F' })).toBe('ab.pdf');
    expect(fileName({ t: 'file', n: '../../etc/passwd' })).toBe('.._.._etc_passwd');
    expect(fileName({ t: 'file', n: 'C:\\Windows\\x.bat' })).toBe('C:_Windows_x.bat');
    expect(fileName({ t: 'file', n: 'two\nlines.txt' })).toBe('two lines.txt');
    expect(fileName({ t: 'file', n: '\uFEFFdoc\u0000.txt' })).toBe('doc.txt');
    expect(fileName({ t: 'file', n: 'x'.repeat(255) })).toBe('x'.repeat(255));
    // Nothing left: a name of its own, as with none.
    expect(fileName({ t: 'photo', n: '\u202E\u202C', m: 'image/jpeg' })).toBe('photo.jpg');
    expect(mediaName({ n: '\u202E\u202C' })).toBeUndefined();
    expect(mediaName({})).toBeUndefined();
    // Persian and emoji names are as they were.
    for (const n of ['نامه\u200Cها.pdf', '👨\u200D👩\u200D👧 🇮🇷 1\uFE0F\u20E3.jpg']) {
      expect(fileName({ t: 'file', n })).toBe(n);
      expect(mediaName({ n })).toBe(n);
    }
  });
});

describe('what messages cost', () => {
  // As the app sends them: with a reply mailbox, the last envelope taken
  // in, and (from the side that wrote through a link) a sender tag.
  const sent = (extra: Partial<Draft>): Draft => ({
    kind: 'message',
    conv: newId(),
    id: newId(),
    at: 1_800_000_000_000,
    reply: newId(),
    last: newId(),
    tag: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    ...extra,
  });
  const ids = (n: number) => Array.from({ length: n }, newId);
  const rand = (n: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));
  const photo = { t: 'photo', id: newId(), k: rand(32), d: rand(16), s: 245_123, m: 'image/jpeg', w: 1280, h: 960, p: 'A'.repeat(1300) };

  it('is one send token for every quiet kind and ordinary message', async () => {
    const sender = await conversationKey();
    const recipient = await conversationKey();
    const tokens = async (d: Draft) => sendTokensFor((await sealMessage(d, sender, recipient.publicKey)).length);
    const one: [string, Draft][] = [
      ['short text', sent({ text: 'hi' })],
      ['reply, 1,600 Latin letters', sent({ text: 'a'.repeat(1600), replyTo: newId() })],
      ['reply, 800 Persian letters', sent({ text: 'س'.repeat(800), replyTo: newId() })],
      ['sticker', sent({ sticker: { id: 'fluent/grinning_face', e: '😀' } })],
      ['photo with a preview and a caption', sent({ text: 'c'.repeat(100), replyTo: newId(), media: photo })],
      ['voice message', sent({ media: { t: 'voice', id: newId(), k: rand(32), d: rand(16), s: 145_123, m: 'audio/mp4', l: 33, v: rand(100) } })],
      ['receipt for 50', sent({ kind: 'seen', seen: ids(50) })],
      ['receipt for 50 and the earlier ones', sent({ kind: 'seen', seen: ids(50), earlier: true })],
      ['reaction', sent({ kind: 'reaction', reaction: { to: newId(), e: '👩🏽‍❤️‍💋‍👨🏻' } })],
      ['delete', sent({ kind: 'delete', delete: [newId()] })],
      ['delete all', sent({ kind: 'delete', all: true })],
      ['short edit', sent({ kind: 'edit', edit: { to: newId(), text: 'fixed a typo' } })],
      ['key update', sent({ kind: 'key_update' })],
      ['end', sent({ kind: 'end' })],
    ];
    for (const [what, d] of one) expect([what, await tokens(d)]).toEqual([what, 1]);
    // Only long texts cost more.
    expect(await tokens(sent({ text: 'a'.repeat(5000) }))).toBe(4);
    expect(await tokens(sent({ text: 'a'.repeat(MAX_TEXT_BYTES) }))).toBe(7);
    expect(await tokens(sent({ kind: 'edit', edit: { to: newId(), text: 'س'.repeat(MAX_TEXT_BYTES / 2) } }))).toBe(7);
  });
});

describe('messages, on random input', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LETTERS = [...'abc xyz 019 .,!?\n"\\', ...'سلام دنیا', '\u200c', 'é', '👋', '👨‍👩‍👧', '\ud83d'];
  const words = (r: Random, max = 200) => Array.from({ length: 1 + r.int(max) }, () => r.pick(LETTERS)).join('');
  const id = (r: Random) => toBase64Url(r.bytes(16));
  const ids = (r: Random) => Array.from({ length: 1 + r.int(100) }, () => id(r));

  function randomMedia(r: Random): Media {
    const media: Media = {
      t: r.pick(['photo', 'video', 'gif', 'voice', 'audio', 'round', 'file', 'voice_note']),
      id: id(r),
      k: toBase64Url(r.bytes(32)),
      d: id(r),
      s: 1 + r.int(MAX_FILE_BYTES),
    };
    if (r.oneIn(2)) media.n = words(r, 255).slice(0, 255);
    if (r.oneIn(2)) media.m = r.pick(['image/jpeg', 'image/svg+xml', 'video/mp4', 'audio/mp4', 'application/vnd.oasis.opendocument.text']);
    if (r.oneIn(2)) {
      media.w = 1 + r.int(20_000);
      media.h = 1 + r.int(20_000);
    }
    if (r.oneIn(2)) media.l = r.int(24 * 60 * 60 + 1);
    if (r.oneIn(3)) media.v = toBase64Url(r.bytes(1 + r.int(100)));
    if (r.oneIn(2)) media.p = toBase64Url(r.bytes(1 + r.int(2250)));
    return media;
  }

  /** A random well-formed draft of any kind. */
  function randomDraft(r: Random): Draft {
    const base = { conv: id(r), id: id(r), at: 1 + r.int(2 ** 47) };
    const extra: Partial<Draft> = {};
    if (r.oneIn(3)) extra.reply = id(r);
    if (r.oneIn(4)) extra.tag = toBase64Url(r.bytes(32));
    if (r.oneIn(3)) extra.last = id(r);
    switch (r.int(10)) {
      case 0:
        return { kind: 'seen', ...base, ...extra, seen: ids(r), ...(r.oneIn(2) ? { earlier: true as const } : {}) };
      case 1:
        return { kind: 'reaction', ...base, ...extra, reaction: { to: id(r), e: r.pick(['👍', '❤️', '👨‍👩‍👧', '🇮🇷', '1️⃣', '']) } };
      case 2:
        return { kind: 'delete', ...base, ...extra, ...(r.oneIn(4) ? { all: true as const } : { delete: ids(r) }) };
      case 3:
        return { kind: 'edit', ...base, ...extra, edit: { to: id(r), text: r.oneIn(5) ? '' : words(r) } };
      case 4:
        return { kind: r.pick(['key_update', 'end'] as const), ...base, ...extra };
      default: {
        const draft: Draft = { kind: 'message', ...base, ...extra };
        if (r.oneIn(2)) draft.replyTo = id(r);
        const what = r.pick([0, 1, 1, 2]);
        if (what === 0) draft.sticker = { id: r.pick(['faces/winking_face', 'new_pack/cat_2']), ...(r.oneIn(2) ? { e: '😉' } : {}) };
        if (what === 1) draft.media = randomMedia(r);
        if (what === 2 || (what === 1 && r.oneIn(2))) draft.text = `x${words(r)}`;
        return draft;
      }
    }
  }

  /** As sealMessage fills it in, with made-up keys. */
  const complete = (r: Random, draft: Draft): Message => ({ v: 1, ...draft, from: toBase64Url(r.bytes(65)), to: toBase64Url(r.bytes(8)) });

  const FIELDS = ['v', 'kind', 'conv', 'id', 'at', 'from', 'to', 'reply', 'tag', 'last', 'text', 'replyTo', 'seen', 'earlier', 'media', 'sticker', 'reaction', 'delete', 'all', 'edit'];
  const INNER = ['t', 'id', 'k', 'd', 's', 'n', 'm', 'w', 'h', 'l', 'v', 'p', 'e', 'to', 'text'];

  /** Any JSON value, leaning to ones near what the fields take. */
  function randomValue(r: Random, depth = 2): unknown {
    switch (r.int(depth > 0 ? 9 : 7)) {
      case 0:
        return r.pick([null, true, false]);
      case 1:
        return r.pick([0, -1, 1, 1.5, 1e300, 2 ** 53, 20_000, 20_001, MAX_FILE_BYTES + 1, 24 * 60 * 60 + 1, r.int(2 ** 32)]);
      case 2:
        return r.pick(['', ' ', '👍', '👍👍', 'message', 'seen', 'delete', 'photo', 'image/jpeg', 'a/b', 'pack/name', words(r, 20)]);
      case 3:
        return toBase64Url(r.bytes(r.pick([0, 8, 15, 16, 17, 32, 65, 101])));
      case 4:
        return `${toBase64Url(r.bytes(16))}=`;
      case 5:
        return 'A'.repeat(r.pick([3001, 12_001]));
      case 6:
        return r.int(2 ** 40);
      case 7:
        return Array.from({ length: r.int(4) }, () => randomValue(r, depth - 1));
      default:
        return Object.fromEntries(Array.from({ length: r.int(5) }, () => [r.pick([...FIELDS, ...INNER, '__proto__']), randomValue(r, depth - 1)]));
    }
  }

  /** One to three fields deleted or set to something else, at the top or (mostly) one level in. */
  function change(r: Random, message: Record<string, unknown>): void {
    for (let n = 1 + r.int(3); n > 0; n--) {
      const nested = Object.values(message).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
      const target = nested.length && !r.oneIn(3) ? r.pick(nested) : message;
      const keys = Object.keys(target);
      const key = keys.length && !r.oneIn(4) ? r.pick(keys) : r.pick(target === message ? FIELDS : INNER);
      if (r.oneIn(4)) delete target[key];
      else target[key] = randomValue(r);
    }
  }

  // The type each known field must have in an accepted message.
  const str = (v: unknown) => typeof v === 'string';
  const int = (v: unknown) => Number.isSafeInteger(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every(str);
  const shape =
    (fields: Record<string, (v: unknown) => boolean>, required: string[]) =>
    (v: unknown): boolean => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      return required.every((f) => f in o) && Object.entries(fields).every(([f, ok]) => o[f] === undefined || ok(o[f]));
    };
  const wellTyped = shape(
    {
      v: (v) => v === 1,
      kind: str,
      conv: str,
      id: str,
      at: int,
      from: str,
      to: str,
      reply: str,
      tag: str,
      last: str,
      text: str,
      replyTo: str,
      seen: strings,
      earlier: (v) => v === true,
      media: shape({ t: str, id: str, k: str, d: str, s: int, n: str, m: str, w: int, h: int, l: int, v: str, p: str }, ['t', 'id', 'k', 'd', 's']),
      sticker: shape({ id: str, e: str }, ['id']),
      reaction: shape({ to: str, e: str }, ['to', 'e']),
      delete: strings,
      all: (v) => v === true,
      edit: shape({ to: str, text: str }, ['to', 'text']),
    },
    ['v', 'kind', 'conv', 'id', 'at', 'from', 'to'],
  );

  /** Checks it as a received message would be: either accepted, well typed and the same again after a JSON round trip, or refused with a MessageError. */
  function checkOrRefuse(value: unknown, round: number): void {
    let message: Message;
    try {
      message = checkMessage(value);
    } catch (err) {
      expect(err, `round ${round}`).toBeInstanceOf(MessageError);
      return;
    }
    expect(wellTyped(message), `round ${round}: ${JSON.stringify(message)}`).toBe(true);
    expect(checkMessage(JSON.parse(JSON.stringify(message))), `round ${round}`).toEqual(message);
  }

  it('accept every well-formed message, unchanged by a JSON round trip', () => {
    const r = new Random(0x6d736701);
    for (let round = 0; round < 500; round++) {
      const message = complete(r, randomDraft(r));
      expect(wellTyped(message)).toBe(true);
      expect(checkMessage(JSON.parse(JSON.stringify(message))), `round ${round}`).toEqual(message);
    }
  });

  it('refuse changed fields and random values with a MessageError only', () => {
    const r = new Random(0x6d736702);
    for (let round = 0; round < 3000; round++) {
      if (r.oneIn(5)) {
        checkOrRefuse(randomValue(r, 3), round);
        continue;
      }
      const message = JSON.parse(JSON.stringify(complete(r, randomDraft(r)))) as Record<string, unknown>;
      change(r, message);
      checkOrRefuse(message, round);
    }
  });

  it('refuse changed JSON text with a MessageError only', () => {
    const r = new Random(0x6d736703);
    for (let round = 0; round < 500; round++) {
      const json = r.mutate(utf8(JSON.stringify(complete(r, randomDraft(r)))));
      let value: unknown;
      try {
        // As openMessage reads it; what doesn't parse is refused there ("not JSON").
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
      } catch {
        continue;
      }
      checkOrRefuse(value, round);
    }
  });

  it('open to exactly what was sealed, and never once anything is changed', async () => {
    // Fixed keys and seeded randomness: a failing round fails the same way every run.
    const r = new Random(0x6d736704);
    const [sender, other, , ephemeral] = await fixedKeys();
    const recipient = { ...other!, id: await keyId(other!.publicKey) };
    const find = finder(recipient);
    seedCrypto(r, ephemeral!.pair);
    for (let round = 0; round < 150; round++) {
      const draft = randomDraft(r);
      const envelope = await sealMessage(draft, sender!, recipient.publicKey);
      const { message } = await openMessage(envelope, find);
      expect(message, `round ${round}`).toEqual({ v: 1, ...draft, from: toBase64Url(sender!.publicKey), to: toBase64Url(recipient.id) });
      // The envelope changed; the inner message (tag and JSON) changed and sealed again; or made-up JSON with a made-up tag.
      let changed: Uint8Array;
      const way = r.int(3);
      if (way === 0) {
        changed = r.mutate(envelope);
        if (changed.length === envelope.length && changed.every((b, i) => b === envelope[i])) continue;
      } else {
        const { inner } = await openEnvelope(envelope, find);
        const mutated = way === 1 ? r.mutate(inner) : concat(r.bytes(32), utf8(JSON.stringify(r.oneIn(2) ? randomValue(r, 3) : complete(r, randomDraft(r)))));
        if (mutated.length > MAX_INNER || (mutated.length === inner.length && mutated.every((b, i) => b === inner[i]))) continue;
        changed = await sealEnvelope([recipient.publicKey], mutated);
      }
      const result = await openMessage(changed, find).catch((err: unknown) => err);
      expect(result instanceof EnvelopeError || result instanceof MessageError, `round ${round}: ${String(result)}`).toBe(true);
    }
  });
});
