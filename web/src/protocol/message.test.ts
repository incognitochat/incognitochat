import { describe, expect, it } from 'vitest';
import { concat, toBase64Url, utf8 } from '../crypto/encoding';
import { exportPublicKey, generateCopyableAgreementKey } from '../crypto/keys';
import { keyId, sealEnvelope, sendTokensFor } from './envelope';
import { checkMessage, fileName, MAX_TEXT_BYTES, MessageError, newId, openMessage, passiveType, sealMessage, shownAs, type ConversationKey, type Draft } from './message';

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
