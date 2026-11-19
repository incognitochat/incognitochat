// The mailbox pool (design §9): mailboxes created ahead of time, so taking
// one for a new conversation rarely comes right after creating it. A take
// that leaves the pool low has it topped up at a random moment after (the
// engine's refillSoon); only a take that finds the pool empty creates
// mailboxes first: more chats started in one burst than it holds, or a
// top-up that failed or didn't run.

import { checkObject } from '../net/api';
import type { Session } from '../net/session';
import { getMeta, putMeta, type Database } from '../storage/db';
import { withLock } from '../sync/locks';

const META_POOL = 'mailbox-pool';
/** Held briefly, to take from the pool or add to it; never across a request. */
const LOCK = 'mailbox-pool';
/**
 * Held while mailboxes are created, one batch at a time, so copies of the
 * app that find the pool low at once create one batch, not one each. A take
 * never waits for it unless the pool is empty: an anonymous send would
 * otherwise go out right after the account's request answered.
 */
const REFILL_LOCK = 'mailbox-pool-refill';
export const POOL_LOW = 3;
export const POOL_REFILL = 5;
const ID = /^[A-Za-z0-9_-]{22}$/;

async function pool(db: Database): Promise<string[]> {
  const value = await getMeta<unknown>(db, META_POOL);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && ID.test(v)) : [];
}

export async function poolSize(db: Database): Promise<number> {
  return (await pool(db)).length;
}

/** Creates `count` mailboxes and adds them to the pool. Only while holding REFILL_LOCK. */
async function create(db: Database, session: Session, count: number): Promise<number> {
  const created = await session.call('POST', '/mailboxes', { count }, (v) => {
    const m = checkObject(v).mailboxes;
    if (!Array.isArray(m) || m.length !== count || !m.every((x) => typeof x === 'string' && ID.test(x))) throw new Error('bad mailboxes');
    return m as string[];
  });
  return withLock(LOCK, async () => {
    const next = [...(await pool(db)), ...created];
    await putMeta(db, META_POOL, next);
    return next.length;
  });
}

/**
 * Adds mailboxes to the pool; with `below`, only if it holds fewer than
 * that once this holds the refill lock (another copy of the app may just
 * have topped it up). Returns how many it holds.
 */
export function refillPool(db: Database, session: Session, count = POOL_REFILL, below = Infinity): Promise<number> {
  return withLock(REFILL_LOCK, async () => {
    const held = (await pool(db)).length;
    if (held >= below) return held;
    return create(db, session, count);
  });
}

/** Drops mailboxes from the pool (the server no longer has them as ours). */
export function dropFromPool(db: Database, ids: Set<string>): Promise<void> {
  return withLock(LOCK, async () => {
    await putMeta(db, META_POOL, (await pool(db)).filter((id) => !ids.has(id)));
  });
}

/** The pool's mailboxes. */
export function pooled(db: Database): Promise<string[]> {
  return pool(db);
}

/** Takes the pool's first mailbox, if it has one. */
function takeFirst(db: Database): Promise<string | undefined> {
  return withLock(LOCK, async () => {
    const [first, ...rest] = await pool(db);
    if (first) await putMeta(db, META_POOL, rest);
    return first;
  });
}

/**
 * Takes a mailbox from the pool. Only if it's empty are mailboxes created
 * first (after any refill under way), right before the send that takes one.
 */
export async function takeMailbox(db: Database, session: Session): Promise<string> {
  const taken = await takeFirst(db);
  if (taken) return taken;
  return withLock(REFILL_LOCK, async () => {
    if ((await pool(db)).length === 0) await create(db, session, POOL_REFILL);
    const first = await takeFirst(db);
    if (!first) throw new Error('no mailbox');
    return first;
  });
}
