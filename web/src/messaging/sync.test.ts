import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenIssuer } from '../account/wallet';
import { toBase64Url } from '../crypto/encoding';
import { generateVaultKey } from '../crypto/vault';
import { ApiError, type Api } from '../net/api';
import type { Session } from '../net/session';
import { openDatabase, putKey } from '../storage/db';
import { createMessaging, type MessagingDeps } from './engine';

let n = 0;
/** An envelope nobody can open: confirmed and dropped. */
const junk = toBase64Url(new Uint8Array(663));
const key = (c: string) => c.repeat(22);

type Answer = { items: { id: string; mailbox: string; envelope: string }[]; more: boolean; next?: string } | ApiError;

/** A server that answers GET /inbox and POST /ack from a script, and records the calls. */
async function scripted(inbox: Answer[], acks: (object | ApiError)[] = [], extra: Partial<MessagingDeps> = {}) {
  const calls: string[] = [];
  const session: Session = {
    async call<T>(method: string, path: string, body: unknown, check: (value: unknown) => T): Promise<T> {
      calls.push(method === 'POST' ? `${method} ${path} ${(body as { ids: string[] }).ids.join(',')}` : `${method} ${path}`);
      const answer = method === 'GET' ? inbox.shift() : (acks.shift() ?? {});
      if (!answer) throw new Error(`unexpected ${method} ${path}`);
      if (answer instanceof ApiError) throw answer;
      return check(answer);
    },
  } as Session;
  const db = await openDatabase(`sync-test-${n++}`);
  await putKey(db, 'vault-key', await generateVaultKey());
  let clock = 1_800_000_000_000;
  const messaging = createMessaging({ db, api: {} as Api, session, issuer: {} as TokenIssuer, now: () => clock, ...extra });
  return { calls, messaging, wait: (ms: number) => (clock += ms) };
}

const item = (id: string) => ({ id, mailbox: key('m'), envelope: junk });

describe('inbox sync', () => {
  it('pages on past an empty page that has more after it', async () => {
    const { calls, messaging } = await scripted([
      { items: [], more: true, next: key('a') },
      { items: [item('one')], more: true, next: key('b') },
      { items: [item('two')], more: false },
    ]);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', `GET /inbox?after=${key('a')}`, 'POST /ack one', `GET /inbox?after=${key('b')}`, 'POST /ack two']);
  });

  it('pauses after the server limits fetching or confirming, then carries on', async () => {
    const limited = new ApiError(429, 'rate_limited');
    const { calls, messaging, wait } = await scripted([{ items: [item('one')], more: false }, limited, { items: [item('one')], more: false }], [limited]);
    // Confirming refused: no error for the app, and it's confirmed later.
    expect(await messaging.sync()).toBe(0);
    expect(calls).toEqual(['GET /inbox', 'POST /ack one']);
    // The next sync confirms it first, then fetches, until that's refused.
    await messaging.sync();
    expect(calls.slice(2)).toEqual(['POST /ack one', 'GET /inbox']);
    wait(20_000);
    await messaging.sync();
    expect(calls).toHaveLength(4);
    wait(45_000);
    await messaging.sync();
    // Listed again, it's not confirmed twice.
    expect(calls.slice(4)).toEqual(['GET /inbox']);
  });

  it('keeps fetching while confirming is limited, and confirms later', async () => {
    const limited = new ApiError(429, 'rate_limited');
    const { calls, messaging, wait } = await scripted(
      [{ items: [item('one')], more: true, next: key('b') }, { items: [item('two')], more: false }, { items: [], more: false }],
      [limited],
    );
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', `GET /inbox?after=${key('b')}`]);
    wait(61_000);
    await messaging.sync();
    expect(calls.slice(3)).toEqual(['POST /ack one', 'POST /ack two', 'GET /inbox']);
  });

  it('sends again only the IDs the server could not delete', async () => {
    const { calls, messaging } = await scripted([{ items: [item('one'), item('two')], more: false }, { items: [item('two')], more: false }], [{ retry: ['two'] }]);
    await messaging.sync();
    await messaging.sync();
    // Listed again meanwhile: not confirmed twice.
    expect(calls).toEqual(['GET /inbox', 'POST /ack one,two', 'POST /ack two', 'GET /inbox']);
  });

  it('starts from the start after an error where it was', async () => {
    const answers: Answer[] = [...'abcdefghij'].map((c) => ({ items: [], more: true, next: key(c) }));
    answers.push(new ApiError(500, 'internal'), { items: [], more: false });
    const { calls, messaging } = await scripted(answers);
    await messaging.sync();
    await expect(messaging.sync()).rejects.toThrow(ApiError);
    await messaging.sync();
    expect(calls.slice(10)).toEqual([`GET /inbox?after=${key('j')}`, 'GET /inbox']);
  });

  it('keeps what it could not confirm, whatever went wrong, until it is confirmed', async () => {
    const limited = new ApiError(429, 'rate_limited');
    const { calls, messaging } = await scripted(
      [{ items: [item('one')], more: false }, { items: [], more: false }],
      [limited, new ApiError(500, 'internal'), {}],
    );
    await messaging.sync();
    // Sent again, and failing: kept still.
    await expect(messaging.sync()).rejects.toThrow(ApiError);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', 'POST /ack one', 'POST /ack one', 'GET /inbox']);
  });

  it('keeps the IDs of a confirmation that failed outright', async () => {
    const { calls, messaging } = await scripted([{ items: [item('one')], more: false }, { items: [], more: false }], [new ApiError(500, 'internal')]);
    await expect(messaging.sync()).rejects.toThrow(ApiError);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', 'POST /ack one', 'GET /inbox']);
  });

  it('stops reading once three pages wait to be confirmed', async () => {
    const page = (p: string) => ({ items: Array.from({ length: 50 }, (_, i) => item(`${p}${i}`)), more: true, next: key(p) });
    const { calls, messaging } = await scripted([page('a'), page('b'), page('c'), page('d')], [new ApiError(429, 'rate_limited')]);
    await messaging.sync();
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('waits until the next day once the day is used up', async () => {
    // 08:00 UTC: the day ends in 16 hours.
    const { calls, messaging, wait } = await scripted([new ApiError(429, 'daily_limit'), { items: [], more: false }]);
    await messaging.sync();
    wait(2 * 3600_000);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox']);
    wait(14 * 3600_000 + 61_000);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'GET /inbox']);
  });

  it('after a pause while going round, still stops where the walk began', async () => {
    const limited = new ApiError(429, 'rate_limited');
    const answers: Answer[] = [...'abcdefghij'].map((c) => ({ items: [], more: true, next: key(c) }));
    // Resumed at j: the end, then round from the start, refused at b.
    answers.push({ items: [], more: false }, { items: [], more: true, next: key('b') }, limited);
    // After the pause: from b, past j, so done.
    answers.push({ items: [], more: true, next: key('k') });
    const { calls, messaging, wait } = await scripted(answers);
    await messaging.sync();
    await messaging.sync();
    expect(calls.slice(10)).toEqual([`GET /inbox?after=${key('j')}`, 'GET /inbox', `GET /inbox?after=${key('b')}`]);
    wait(61_000);
    await messaging.sync();
    expect(calls.slice(13)).toEqual([`GET /inbox?after=${key('b')}`]);
  });

  it('ignores a pause the clock was set back past', async () => {
    const { calls, messaging, wait } = await scripted([new ApiError(429, 'rate_limited'), { items: [], more: false }]);
    await messaging.sync();
    wait(-3600_000);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'GET /inbox']);
  });

  it('works with a server that gives no cursor', async () => {
    const { calls, messaging } = await scripted([
      { items: [item('one')], more: true },
      { items: [], more: true },
    ]);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', 'GET /inbox']);
  });

  it('refuses a cursor that is not an item key', async () => {
    const { messaging } = await scripted([{ items: [], more: true, next: '../account' }]);
    await expect(messaging.sync()).rejects.toThrow();
  });

  it('still fails on other errors', async () => {
    const { messaging } = await scripted([new ApiError(401, 'login_refused')]);
    await expect(messaging.sync()).rejects.toThrow(ApiError);
  });

  it('carries on where the last sync stopped, past many old envelopes', async () => {
    // 12 pages the server skips, then a live envelope: the first sync stops after 10 pages, the next carries on there.
    const letters = 'abcdefghijkl';
    const answers: Answer[] = [...letters].map((c) => ({ items: [], more: true, next: key(c) }));
    answers.push({ items: [item('one')], more: false }, { items: [], more: true, next: key('k') });
    const { calls, messaging } = await scripted(answers);
    await messaging.sync();
    expect(calls).toHaveLength(10);
    await messaging.sync();
    // Then round to the start once, for what came before where it started, until back there.
    expect(calls.slice(10)).toEqual([`GET /inbox?after=${key('j')}`, `GET /inbox?after=${key('k')}`, `GET /inbox?after=${key('l')}`, 'POST /ack one', 'GET /inbox']);
  });

  it('after a pause, starts at the page that was refused', async () => {
    const limited = new ApiError(429, 'rate_limited');
    const { calls, messaging, wait } = await scripted(
      [{ items: [item('one')], more: true, next: key('b') }, limited, { items: [item('two')], more: false }, { items: [], more: false }],
    );
    await messaging.sync();
    wait(61_000);
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', `GET /inbox?after=${key('b')}`, `GET /inbox?after=${key('b')}`, 'POST /ack two', 'GET /inbox']);
  });

  it('neither opens nor confirms again what it just confirmed', async () => {
    // The server's reads lag: an item confirmed a moment ago can be listed again, under the same ID.
    const { calls, messaging } = await scripted([
      { items: [item('one')], more: false },
      { items: [item('one'), item('two')], more: false },
      { items: [item('one')], more: false },
    ]);
    await messaging.sync();
    await messaging.sync();
    await messaging.sync();
    expect(calls).toEqual(['GET /inbox', 'POST /ack one', 'GET /inbox', 'POST /ack two', 'GET /inbox']);
  });

  describe('with timers', () => {
    afterEach(() => vi.useRealTimers());

    it('syncs when a pause ends, for pushes that came during it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const limited = new ApiError(429, 'rate_limited');
      let resumed = 0;
      const { calls, messaging, wait } = await scripted([limited, { items: [item('one')], more: false }], [], { onResume: () => resumed++ });
      await messaging.sync();
      // A push meanwhile: nothing now.
      await messaging.sync();
      expect(calls).toEqual(['GET /inbox']);
      wait(29_000);
      vi.advanceTimersByTime(29_000);
      expect(resumed).toBe(0);
      wait(31_000);
      vi.advanceTimersByTime(31_000);
      expect(resumed).toBe(1);
      await messaging.sync();
      expect(calls).toEqual(['GET /inbox', 'GET /inbox', 'POST /ack one']);
    });

    it('stops waiting when stopped', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let resumed = 0;
      const { messaging } = await scripted([new ApiError(429, 'rate_limited')], [], { onResume: () => resumed++ });
      await messaging.sync();
      messaging.stop();
      vi.advanceTimersByTime(120_000);
      expect(resumed).toBe(0);
    });
  });
});
