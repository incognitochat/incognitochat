import { describe, expect, it } from 'vitest';
import { createPace, SYNC_BURST, SYNC_GAP_MS, SYNC_REFILL_MS } from './pace';

const T = 1_800_000_000_000;

describe('the pace of syncs the app asks for by itself', () => {
  it('lets one start at once, then one every SYNC_GAP_MS, whichever copy started the last', () => {
    const pace = createPace();
    expect(pace.wait(T)).toBe(0);
    pace.started(T, true);
    expect(pace.last(T)).toBe(T);
    expect(pace.wait(T + 1000)).toBe(SYNC_GAP_MS - 1000);
    expect(pace.wait(T + SYNC_GAP_MS)).toBe(0);
    // Another copy started one: the gap counts from it.
    pace.started(T + SYNC_GAP_MS, true);
    expect(pace.wait(T + SYNC_GAP_MS + 1)).toBe(SYNC_GAP_MS - 1);
  });

  it('slows to one every SYNC_REFILL_MS once its budget is spent, and recovers', () => {
    const pace = createPace();
    let t = T;
    const starts: number[] = [];
    // A flood that asks all the time, for three hours.
    while (t < T + 3 * 3_600_000) {
      t += pace.wait(t);
      pace.started(t, true);
      starts.push(t);
    }
    // At the gap while the budget lasts (it refills meanwhile: about 40
    // minutes), then one every SYNC_REFILL_MS.
    const atGap = starts.filter((s, i) => i > 0 && s - starts[i - 1]! === SYNC_GAP_MS).length;
    expect(atGap).toBeGreaterThanOrEqual(SYNC_BURST);
    expect(starts.filter((s) => s < T + 30 * 60_000).length).toBeLessThanOrEqual(30 * 60_000 / SYNC_GAP_MS + 1);
    const last = starts.slice(-10);
    for (let i = 1; i < last.length; i++) expect(Math.abs(last[i]! - last[i - 1]! - SYNC_REFILL_MS)).toBeLessThanOrEqual(1);
    // At most SYNC_BURST and the refill over the time.
    expect(starts.length).toBeLessThanOrEqual(SYNC_BURST + (3 * 3_600_000) / SYNC_REFILL_MS + 1);
    // Quiet for a while: at the gap again.
    expect(pace.wait(t + SYNC_BURST * SYNC_REFILL_MS)).toBe(0);
  });

  it('keeps a whole day of flood under 60% of the day limit on requests (2 a sync, 30,000)', () => {
    const pace = createPace();
    let t = T;
    let syncs = 0;
    while (t < T + 24 * 3_600_000) {
      t += pace.wait(t);
      pace.started(t, true);
      syncs++;
    }
    expect(2 * syncs).toBeLessThan(0.6 * 30_000);
  });

  it("doesn't spend the budget for syncs the user's doing started", () => {
    const pace = createPace();
    let t = T;
    for (let i = 0; i < 2 * SYNC_BURST; i++) {
      t += SYNC_GAP_MS;
      pace.started(t, false);
    }
    expect(pace.wait(t + SYNC_GAP_MS)).toBe(0);
  });

  it('starts over after the clock was set back, so what is asked then is not taken as answered', () => {
    const pace = createPace();
    pace.started(T, true);
    expect(pace.last(T - 10 * 60_000)).toBe(0);
    expect(pace.wait(T - 10 * 60_000)).toBe(0);
    // A start another copy tells of a moment late is no clock set back.
    pace.started(T + 10_000, true);
    pace.started(T + 9_900, true);
    expect(pace.last(T + 10_050)).toBe(T + 10_000);
    expect(pace.wait(T + 10_050)).toBe(SYNC_GAP_MS - 50);
  });
});
