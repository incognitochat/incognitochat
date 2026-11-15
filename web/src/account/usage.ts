// Today's usage of the limits a person can run into (GET /usage), for the
// Usage screen. The server counts what it has handed out today; the app
// adds what it holds but hasn't used yet (tokens fetched ahead, spare
// mailboxes), so what's left is exact.

import { checkObject } from '../net/api';

/** One limit: how much of it is used. */
export interface UsageItem {
  used: number;
  limit: number;
}

/** GET /usage. The daily items reset at resetsAt (Unix seconds, 00:00 UTC). */
export interface UsageInfo {
  resetsAt: number;
  send: UsageItem;
  media: UsageItem;
  mailboxes: UsageItem;
  linkChanges: UsageItem;
  /** Mailboxes the account owns (spares included), of the most it may. */
  owned: UsageItem;
}

function checkItem(v: unknown): UsageItem {
  const o = checkObject(v);
  const { used, limit } = o;
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(limit) || (used as number) < 0 || (limit as number) < 1) throw new Error('bad usage');
  return { used: used as number, limit: limit as number };
}

export function checkUsage(v: unknown): UsageInfo {
  const o = checkObject(v);
  if (!Number.isSafeInteger(o.resetsAt)) throw new Error('bad usage');
  return {
    resetsAt: o.resetsAt as number,
    send: checkItem(o.send),
    media: checkItem(o.media),
    mailboxes: checkItem(o.mailboxes),
    linkChanges: checkItem(o.linkChanges),
    owned: checkItem(o.owned),
  };
}

/** What's left of a limit. */
export interface Left {
  left: number;
  limit: number;
}

/** The Usage screen's numbers. */
export interface UsageView {
  /** Unix ms. */
  resetsAt: number;
  messages: Left;
  /** In bytes: one media token pays for a MiB. */
  files: Left;
  newChats: Left;
  linkChanges: Left;
  /** Mailboxes in use by chats (spares not counted), of the most allowed. */
  chats: UsageItem;
}

const MiB = 1024 * 1024;

/** What's left: the server's part, plus what's held here unused, never more than the limit. */
function left(item: UsageItem, held: number): Left {
  return { left: Math.max(0, Math.min(item.limit, item.limit - item.used + held)), limit: item.limit };
}

/** The screen's numbers, from the server's counts and what this device holds. */
export function usageView(info: UsageInfo, held: { sendTokens: number; mediaTokens: number; spareMailboxes: number }): UsageView {
  const files = left(info.media, held.mediaTokens);
  return {
    resetsAt: info.resetsAt * 1000,
    messages: left(info.send, held.sendTokens),
    files: { left: files.left * MiB, limit: files.limit * MiB },
    newChats: left(info.mailboxes, held.spareMailboxes),
    linkChanges: left(info.linkChanges, 0),
    chats: { used: Math.max(0, info.owned.used - held.spareMailboxes), limit: info.owned.limit },
  };
}
