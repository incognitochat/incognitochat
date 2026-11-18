import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utf8 } from '../crypto/encoding';
import type { Message } from '../protocol/message';
import {
  capEdits,
  EDITS_LEDGER,
  LEDGER_ENTRY_COST,
  MAX_PENDING_EDIT_BYTES,
  MAX_PENDING_EDITS,
  MAX_UNANSWERED_EDIT_BYTES,
  openDatabase,
  type ConversationRecord,
  type Database,
  type PendingEdit,
} from '../storage/db';
import {
  addMessage,
  deleteMessage,
  dropEmptyConversation,
  dropPendingEdits,
  earlyFor,
  forgetEarly,
  getConversation,
  getPendingEdits,
  keepEarly,
  lastShown,
  listMessages,
  MAX_EARLY,
  MAX_EARLY_BYTES,
  MAX_EARLY_DELETE_BYTES,
  noteSeenBefore,
  PAGE,
  pageMessages,
  putConversation,
  saveConversation,
  setStatuses,
  unread,
  unreadIds,
  withPreview,
} from './store';

let n = 0;
const fresh = () => openDatabase(`store-test-${n++}`);

afterEach(() => {
  vi.restoreAllMocks();
});

function conversation(id: string, extra: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    wire: id,
    role: 'owner',
    link: { id: 'L', fingerprint: 'F' },
    label: 'x',
    peerKey: 'k',
    myKey: null,
    sendTo: 'm',
    myMailbox: null,
    lastAt: 1,
    unread: 0,
    status: 'active',
    lastReceived: null,
    ...extra,
  };
}

/** A conversation with `count` messages, theirs and ours by turns, at 1, 2, 3, ... */
async function chat(db: Database, id: string, count: number): Promise<void> {
  await putConversation(db, conversation(id));
  for (let i = 1; i <= count; i++) {
    const out = i % 2 === 0;
    await addMessage(db, { id: `m${i}`, conv: id, at: i, out, status: out ? 'sent' : 'received' }, { text: `message ${i}`, ...(i % 7 === 0 ? { replyTo: 'm1' } : {}) });
  }
}

/** Counts what's opened (decrypted) under the storage key while fn runs. */
async function opened<T>(fn: () => Promise<T>): Promise<{ value: T; opened: number }> {
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  const before = decrypt.mock.calls.length;
  const value = await fn();
  const count = decrypt.mock.calls.length - before;
  decrypt.mockRestore();
  return { value, opened: count };
}

describe('a page of messages', () => {
  it('is the newest ones, oldest first, and says whether there are older', async () => {
    const db = await fresh();
    await chat(db, 'c', 120);
    const first = await pageMessages(db, 'c');
    expect(first.messages.map((m) => m.text)).toEqual(Array.from({ length: PAGE }, (_, i) => `message ${71 + i}`));
    expect(first.more).toBe(true);
    // PAGE more.
    const next = await pageMessages(db, 'c', { count: 2 * PAGE });
    expect([next.messages[0]!.id, next.messages.length, next.more]).toEqual(['m21', 100, true]);
    // All from a time on.
    const since = await pageMessages(db, 'c', { since: 10 });
    expect([since.messages[0]!.id, since.messages.length, since.more]).toEqual(['m10', 111, true]);
    expect((await pageMessages(db, 'c', { since: 1 })).more).toBe(false);
    expect((await pageMessages(db, 'c', { count: 120 })).more).toBe(false);
    // Another conversation's messages never come in.
    await chat(db, 'd', 3);
    expect((await pageMessages(db, 'd')).messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(await pageMessages(db, 'none')).toEqual({ messages: [], more: false });
  });

  it('orders those of the same second as they were taken in, not by ID', async () => {
    const db = await fresh();
    await putConversation(db, conversation('s'));
    // Stored in this order, all in one second: their IDs sort the other way.
    for (const id of ['e', 'd', 'c', 'b', 'a']) await addMessage(db, { id, conv: 's', at: 5000, out: false, status: 'received' }, { text: id });
    await addMessage(db, { id: 'z', conv: 's', at: 4000, out: false, status: 'received' }, { text: 'z' });
    expect((await pageMessages(db, 's', { count: 2 })).messages.map((m) => m.id)).toEqual(['b', 'a']);
    expect((await pageMessages(db, 's', { since: 5000, most: 3 })).messages.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect((await pageMessages(db, 's')).messages.map((m) => m.id)).toEqual(['z', 'e', 'd', 'c', 'b', 'a']);
    expect((await withPreview(db, (await getConversation(db, 's'))!)).preview?.id).toBe('a');
    expect((await unread(db, 's', 2)).newest).toEqual(['b', 'a']);
    expect((await unread(db, 's', 10)).newest).toEqual(['z', 'e', 'd', 'c', 'b', 'a']);
  });

  it('opens only the messages it shows, however many the chat has', async () => {
    const db = await fresh();
    await chat(db, 'flooded', 1000);
    const page = await opened(() => pageMessages(db, 'flooded'));
    expect(page.value.messages).toHaveLength(PAGE);
    expect(page.opened).toBe(PAGE);
    // As the list shows it: its preview, made once, then one small item.
    const c = (await getConversation(db, 'flooded'))!;
    const first = await opened(() => lastShown(db, c));
    expect(first.value).toMatchObject({ out: true, text: 'message 1000', status: 'sent' });
    expect(first.opened).toBe(2);
    const again = await opened(async () => lastShown(db, (await getConversation(db, 'flooded'))!));
    expect(again.value).toEqual(first.value);
    expect(again.opened).toBe(1);
    // Their unread ones, without opening any.
    const unread = await opened(() => unreadIds(db, 'flooded'));
    expect([unread.value.length, unread.opened]).toEqual([500, 0]);
  });
});

describe("a conversation's preview", () => {
  it('is of its newest message, sealed, and made again when that changes', async () => {
    const db = await fresh();
    await chat(db, 'c', 3);
    let c = await withPreview(db, (await getConversation(db, 'c'))!);
    expect(c.preview?.id).toBe('m3');
    // Sealed at rest, like message text: the record never holds it in clear.
    expect(new TextDecoder().decode(c.preview!.sealed)).not.toContain('message 3');
    await putConversation(db, c);
    expect(await lastShown(db, c)).toEqual({ out: false, text: 'message 3' });
    // The same one: nothing to do, unless its text changed.
    expect(await withPreview(db, c)).toBe(c);
    expect(await withPreview(db, c, 'm3')).not.toBe(c);
    // A newer one.
    await addMessage(db, { id: 'm4', conv: 'c', at: 4, out: true, status: 'sending' }, { text: '', sticker: { id: 'pack/cat', e: '🐱' } });
    c = await withPreview(db, c);
    expect(await lastShown(db, c)).toEqual({ out: true, text: '', sticker: { id: 'pack/cat', e: '🐱' }, status: 'sending' });
    // Its status comes from the message, as it is now.
    await setStatuses(db, 'c', ['m4'], 'seen');
    expect((await lastShown(db, c))?.status).toBe('seen');
    // Deleted: the one before. All gone: none.
    await deleteMessage(db, 'c', 'm4');
    c = await withPreview(db, c);
    expect((await lastShown(db, c))?.text).toBe('message 3');
    for (const id of ['m1', 'm2', 'm3']) await deleteMessage(db, 'c', id);
    c = await withPreview(db, c);
    expect(c.preview).toBeNull();
    expect(await lastShown(db, c)).toBeNull();
  });

  it('keeps only the start of a long text, and what an attachment is', async () => {
    const db = await fresh();
    await putConversation(db, conversation('c'));
    const long = '🙂'.repeat(500);
    await addMessage(db, { id: 'm1', conv: 'c', at: 1, out: false, status: 'received', file: 'remote' }, {
      text: long,
      media: { t: 'photo', s: 10, n: 'cat.jpg', m: 'image/jpeg', w: 1, h: 1, p: 'x'.repeat(2000) },
    });
    const shown = await lastShown(db, (await getConversation(db, 'c'))!);
    expect(shown).toEqual({ out: false, text: '🙂'.repeat(200), media: { t: 'photo', n: 'cat.jpg', m: 'image/jpeg' } });
  });

  it('is made once for a conversation from before previews were kept, and again if its message of ours is gone', async () => {
    const db = await fresh();
    await chat(db, 'c', 2);
    expect((await getConversation(db, 'c'))!.preview).toBeUndefined();
    expect(await lastShown(db, (await getConversation(db, 'c'))!)).toMatchObject({ out: true, text: 'message 2' });
    const kept = (await getConversation(db, 'c'))!.preview;
    expect(kept?.id).toBe('m2');
    // One that went without the preview hearing of it: ours, then theirs.
    await deleteMessage(db, 'c', 'm2');
    expect(await lastShown(db, (await getConversation(db, 'c'))!)).toEqual({ out: false, text: 'message 1' });
    expect((await getConversation(db, 'c'))!.preview?.id).toBe('m1');
    await deleteMessage(db, 'c', 'm1');
    expect(await lastShown(db, (await getConversation(db, 'c'))!)).toBeNull();
    expect((await getConversation(db, 'c'))!.preview).toBeNull();
    // An empty one is kept as empty.
    await putConversation(db, conversation('e'));
    expect(await lastShown(db, (await getConversation(db, 'e'))!)).toBeNull();
    expect((await getConversation(db, 'e'))!.preview).toBeNull();
  });

  it('made for the list never undoes a newer one stored meanwhile', async () => {
    const db = await fresh();
    await chat(db, 'c', 2);
    const old = (await getConversation(db, 'c'))!;
    // Meanwhile a message comes, and its preview is stored with it.
    await addMessage(db, { id: 'm3', conv: 'c', at: 3, out: false, status: 'received' }, { text: 'newer' });
    await putConversation(db, await withPreview(db, old));
    // The list, from the record it read before.
    await lastShown(db, old);
    expect((await getConversation(db, 'c'))!.preview?.id).toBe('m3');
  });
});

describe('seen', () => {
  it('marks theirs read in one go, and, for a receipt that says so, ours sent up to a time as seen', async () => {
    const db = await fresh();
    await chat(db, 'c', 10);
    expect(await unreadIds(db, 'c')).toEqual(['m1', 'm3', 'm5', 'm7', 'm9']);
    await setStatuses(db, 'c', ['m1', 'm3', 'm2'], 'read', 'received');
    expect(await unreadIds(db, 'c')).toEqual(['m5', 'm7', 'm9']);
    expect((await listMessages(db, 'c')).find((m) => m.id === 'm2')!.status).toBe('sent');
    // Ours written up to 6, that one included, that show as sent: m2, m6 (m4 failed).
    await setStatuses(db, 'c', ['m4'], 'failed');
    expect(await noteSeenBefore(db, 'c', 6)).toBe(2);
    expect((await listMessages(db, 'c')).filter((m) => m.out).map((m) => [m.id, m.status])).toEqual([
      ['m2', 'seen'],
      ['m4', 'failed'],
      ['m6', 'seen'],
      ['m8', 'sent'],
      ['m10', 'sent'],
    ]);
  });
});

describe('edits waiting for their messages', () => {
  const edit = (i: number, size = 10): PendingEdit => ({ id: `e${i}`, at: i, sealed: new Uint8Array(size) });

  it('are kept up to a number and a size: the newest', () => {
    const many = Array.from({ length: 30 }, (_, i) => edit(i));
    expect(capEdits(many).map((e) => e.id)).toEqual(many.slice(-MAX_PENDING_EDITS).map((e) => e.id));
    const few = many.slice(0, 5);
    expect(capEdits(few)).toBe(few);
    const big = Array.from({ length: 10 }, (_, i) => edit(i, 12_100));
    const kept = capEdits(big);
    expect(kept.map((e) => e.id)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
    expect(kept.reduce((a, e) => a + e.sealed.length, 0)).toBeLessThanOrEqual(MAX_PENDING_EDIT_BYTES);
  });
});

describe('edits waiting in conversations we never answered', () => {
  /** An edit sent at `sent` by their clock, which came at `came` by ours. */
  const save = async (db: Database, id: string, came: number, size: number, { answered = false, sent = came } = {}) => {
    const c = conversation(id, answered ? { myMailbox: 'mine' } : {});
    await saveConversation(db, c, {}, {}, { now: [{ id: `e${id}`, at: sent, sealed: new Uint8Array(size) }], before: [], at: came });
  };
  /** So big that three such chats don't fit in the budget, and two do. */
  const third = Math.floor(MAX_UNANSWERED_EDIT_BYTES / 3) - LEDGER_ENTRY_COST + 1;

  it('share one budget: those an edit came to longest ago (our clock) make room', async () => {
    const db = await fresh();
    // Dated far ahead by their clock: what counts is when it came.
    await save(db, 'a', 1, third, { sent: 1e15 });
    await save(db, 'b', 3, third);
    await save(db, 'answered', 0, MAX_PENDING_EDIT_BYTES - 100, { answered: true });
    expect(await db.get('meta', EDITS_LEDGER)).toEqual([
      { conv: 'a', bytes: third + LEDGER_ENTRY_COST, at: 1 },
      { conv: 'b', bytes: third + LEDGER_ENTRY_COST, at: 3 },
    ]);
    // A third doesn't fit with them: the one an edit came to first goes.
    await save(db, 'c', 2, third);
    expect([(await getPendingEdits(db, 'a')).length, (await getPendingEdits(db, 'b')).length, (await getPendingEdits(db, 'c')).length]).toEqual([0, 1, 1]);
    // An answered one keeps its own, and doesn't count.
    expect(await getPendingEdits(db, 'answered')).toHaveLength(1);
    expect(((await db.get('meta', EDITS_LEDGER)) as { conv: string }[]).map((e) => e.conv).sort()).toEqual(['b', 'c']);
    // Dropped, or the chat gone: out of the ledger.
    await dropPendingEdits(db, 'b');
    await putConversation(db, conversation('c'));
    expect(await dropEmptyConversation(db, 'c')).toBe(true);
    expect(await db.get('meta', EDITS_LEDGER)).toBeUndefined();
    expect(await getPendingEdits(db, 'c')).toEqual([]);
  });

  it('a chat answered since keeps its edits, and no longer counts', async () => {
    const db = await fresh();
    await save(db, 'a', 1, third);
    await save(db, 'b', 2, third);
    // Our first reply in 'a' takes a mailbox, and doesn't write its edits (transmit).
    await putConversation(db, conversation('a', { myMailbox: 'mine' }));
    await save(db, 'c', 3, third);
    expect([(await getPendingEdits(db, 'a')).length, (await getPendingEdits(db, 'b')).length, (await getPendingEdits(db, 'c')).length]).toEqual([1, 1, 1]);
    expect(((await db.get('meta', EDITS_LEDGER)) as { conv: string }[]).map((e) => e.conv)).toEqual(['b', 'c']);
    // Nor one moved off its mailbox (unblocking, say) without being answered anew.
    await putConversation(db, conversation('b', { formerMailboxes: [{ id: 'old' }] }));
    await save(db, 'd', 4, third);
    await save(db, 'e', 5, third);
    expect([(await getPendingEdits(db, 'b')).length, (await getPendingEdits(db, 'c')).length]).toEqual([1, 0]);
  });
});

describe('envelopes that came before the message starting their conversation', () => {
  const message = (conv: string, i: number, text = 'x', from = 'K'): Message => ({
    v: 1,
    kind: 'edit',
    conv,
    id: `id${i}`,
    at: 1000 + i,
    from,
    to: 'T',
    edit: { to: 'first', text },
  });

  it('are kept for their conversation only, and forgotten once taken in', async () => {
    const db = await fresh();
    await keepEarly(db, 'L', message('a', 2), 0);
    await keepEarly(db, 'L', message('a', 1), 0);
    await keepEarly(db, 'L', message('a', 1), 0);
    await keepEarly(db, 'L', message('b', 3), 0);
    await keepEarly(db, 'L2', message('a', 4), 0);
    await keepEarly(db, 'L', message('a', 5, 'x', 'other key'), 0);
    // Oldest first, each once; another conversation, link or key doesn't count.
    expect((await earlyFor(db, 'L', 'a', 'K', 0)).map((m) => m.id)).toEqual(['id1', 'id2']);
    // Sealed at rest.
    expect(new TextDecoder().decode((await db.get('meta', 'early-envelopes')) as Uint8Array)).not.toContain('id1');
    await forgetEarly(db, 0, { link: 'L', wire: 'a', from: 'K' });
    expect(await earlyFor(db, 'L', 'a', 'K', 0)).toEqual([]);
    expect(await earlyFor(db, 'L', 'b', 'K', 0)).toHaveLength(1);
    // Too old: their message can no longer come.
    expect(await earlyFor(db, 'L', 'b', 'K', 1004)).toEqual([]);
    await forgetEarly(db, 1005);
    expect(await earlyFor(db, 'L2', 'a', 'K', 0)).toEqual([]);
    expect(await earlyFor(db, 'L', 'a', 'other key', 0)).toHaveLength(1);
  });

  it("deletes have a budget of their own: a flood of big edits can't push one out", async () => {
    const db = await fresh();
    const deletion: Message = { v: 1, kind: 'delete', conv: 'a', id: 'del', at: 1000, from: 'K', to: 'T', delete: ['first'] };
    await keepEarly(db, 'L', deletion, 0);
    for (let i = 0; i < 20; i++) await keepEarly(db, 'L', message('b', i, 'y'.repeat(12_000), 'flooder'), 0);
    expect(await earlyFor(db, 'L', 'a', 'K', 0)).toEqual([deletion]);
    // Deletes push out only deletes, past their own budget.
    for (let i = 0; i < 30; i++) await keepEarly(db, 'L', { ...deletion, conv: 'c', id: `d${i}`, delete: Array.from({ length: 100 }, (_, j) => `x${j}`) }, 0);
    const kept = await earlyFor(db, 'L', 'c', 'K', 0);
    expect(utf8(JSON.stringify(kept)).length).toBeLessThanOrEqual(MAX_EARLY_DELETE_BYTES);
    expect(kept.at(-1)!.id).toBe('d29');
    expect(await earlyFor(db, 'L', 'b', 'flooder', 0)).not.toEqual([]);
  });

  it('are few and small: past either cap, the oldest go', async () => {
    const db = await fresh();
    for (let i = 0; i < MAX_EARLY + 20; i++) await keepEarly(db, 'L', message('a', i), 0);
    const kept = await earlyFor(db, 'L', 'a', 'K', 0);
    expect(kept.map((m) => m.id)).toEqual(Array.from({ length: MAX_EARLY }, (_, i) => `id${i + 20}`));
    for (let i = 100; i < 120; i++) await keepEarly(db, 'L', message('b', i, 'y'.repeat(12_000)), 0);
    const all = [...(await earlyFor(db, 'L', 'a', 'K', 0)), ...(await earlyFor(db, 'L', 'b', 'K', 0))];
    expect(utf8(JSON.stringify(all)).length).toBeLessThanOrEqual(MAX_EARLY_BYTES);
    // The newest stayed.
    expect(all.at(-1)!.id).toBe('id119');
    expect(all.length).toBeLessThan(10);
  });
});
