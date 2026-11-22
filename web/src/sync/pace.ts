// How often the copies of the app on one device sync by themselves.
//
// Each message delivered to this account pushes a hint to every open copy,
// and each hint asks for a sync: a fetch of the inbox, and a confirmation if
// it read anything. Every one of those is a request with the device's
// session, which the server limits per device (docs/protocol.md, Limits per
// device). Unpaced, whoever writes to someone would decide how many of
// their requests they make: a flood of messages, more so with several
// copies open, could use up the device's limits and hold up its inbox,
// blocking and deleting.
//
// So the syncs the app asks for by itself (pushes, the poll, a chat free
// again, the end of a pause) run at most one every SYNC_GAP_MS on the whole
// device, whichever copy runs it, from a budget of SYNC_BURST that refills
// one every SYNC_REFILL_MS: under a sustained flood, one every
// SYNC_REFILL_MS once the budget is spent, after about half an hour. A sync
// that started after one was asked for answers it. A copy decides and runs
// its sync holding a lock across copies (Web Locks), and tells the others
// when it started (the broadcast channel), so each knows the device's last
// sync and budget, and the next to decide waits out the rest of the gap.
// What the user does (opening the app, showing it, coming back online)
// syncs at once, costs nothing here, and answers what was asked before it.
//
// A flood then costs a device at most 2 requests a sync (a page of the
// inbox and its confirmation, state/app.ts BACKGROUND_PAGES): about 24 a
// minute, 360 a quarter of an hour and 12,000 a day at most, well under
// half of each of its limits. Each message waits at most about SYNC_GAP_MS
// more than it would, SYNC_REFILL_MS once a flood has lasted half an hour.
// Without Web Locks (rare engines), each copy keeps the pace on its own.

/** The least time between two syncs the app asks for by itself, on the whole device. */
export const SYNC_GAP_MS = 5_000;
/** How many such syncs can run SYNC_GAP_MS apart before they slow to one every SYNC_REFILL_MS. */
export const SYNC_BURST = 240;
/** Under a sustained flood, one sync every this long. */
export const SYNC_REFILL_MS = 15_000;

/** The device's syncs as one copy knows them: its own, and those other copies said they started. */
export interface Pace {
  /** A sync started at `at` (Unix ms), here or in another copy; paced: the app asked for it by itself, and it spends from the budget. */
  started(at: number, paced: boolean): void;
  /** When the last sync started, as far as this copy knows (Unix ms, 0 if none). */
  last(): number;
  /** How long a sync the app asks for by itself must wait at `now` (0: it may start). */
  wait(now: number): number;
}

export function createPace(): Pace {
  let last = 0;
  let tokens = SYNC_BURST;
  let at = 0;
  /** The budget at `now`, refilled since `at`; a clock set back since starts it over. */
  const refill = (now: number) => {
    if (now < at || now < last) {
      last = 0;
      tokens = SYNC_BURST;
    } else if (at > 0) {
      tokens = Math.min(SYNC_BURST, tokens + (now - at) / SYNC_REFILL_MS);
    }
    at = now;
  };
  return {
    started(when, paced) {
      refill(Math.max(when, at));
      last = Math.max(last, when);
      if (paced) tokens = Math.max(0, tokens - 1);
    },
    last: () => last,
    wait(now) {
      refill(now);
      return Math.max(last > 0 ? last + SYNC_GAP_MS - now : 0, tokens >= 1 ? 0 : Math.ceil((1 - tokens) * SYNC_REFILL_MS));
    },
  };
}
