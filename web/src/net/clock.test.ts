import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createClock, MAX_OFFSET_MS, MAX_SKEW_MS, stamper, TOKEN_TTL_MS, withServerTime } from './clock';

const LOCAL = 1_800_000_000_000;
const skew = (serverSeconds: number) => new ApiError(401, 'clock_skew', serverSeconds);

describe('clock', () => {
  it("starts as the device's own, and learns the server's from clock_skew", () => {
    const clock = createClock(() => LOCAL);
    expect(clock.now()).toBe(LOCAL);
    expect(clock.learn(skew(LOCAL / 1000 - 300))).toBe(true);
    expect(clock.offset()).toBe(-299_500);
    expect(clock.seconds()).toBe(LOCAL / 1000 - 300);
  });

  it('learns nothing from other answers', () => {
    const clock = createClock(() => LOCAL);
    expect(clock.learn(new ApiError(401, 'login_refused'))).toBe(false);
    expect(clock.learn(new ApiError(401, 'clock_skew'))).toBe(false);
    expect(clock.learn(new Error('clock_skew'))).toBe(false);
    expect(clock.offset()).toBe(0);
  });

  it("doesn't believe a server more than two days away, either way", () => {
    const clock = createClock(() => LOCAL);
    expect(clock.learn(skew(LOCAL / 1000 + 47 * 3600))).toBe(true);
    const near = clock.offset();
    for (const far of [LOCAL / 1000 + MAX_OFFSET_MS / 1000 + 1, LOCAL / 1000 - MAX_OFFSET_MS / 1000 - 1, LOCAL / 1000 + 10 * 365 * 86_400]) {
      expect(clock.learn(skew(far))).toBe(false);
      expect(clock.tooFar(skew(far))).toBe(true);
      // What it knew stays.
      expect(clock.offset()).toBe(near);
    }
    expect(clock.tooFar(skew(LOCAL / 1000 + 3600))).toBe(false);
    expect(clock.tooFar(new ApiError(401, 'login_refused'))).toBe(false);
  });

  it('retries once by a clock it believes, and not at all by one it doesn\'t', async () => {
    let sends = 0;
    const clock = createClock(() => LOCAL);
    await expect(
      withServerTime(clock, async () => {
        sends++;
        if (sends === 1) throw skew(LOCAL / 1000 + 3 * 86_400);
        return 'sent';
      }),
    ).rejects.toMatchObject({ code: 'clock_skew' });
    expect(sends).toBe(1);
  });
});

describe('the clock messages are dated by', () => {
  /** A session token the server issued at serverMs (its clock), as it says: expiring TOKEN_TTL_MS later, in whole seconds. */
  const tokenAt = (serverMs: number) => ({ expires: Math.floor((serverMs + TOKEN_TTL_MS) / 1000) });

  it("learns the server's from a session token's expiry, to about a second", async () => {
    let local = LOCAL;
    // This device's clock runs 23.4 seconds fast; the request takes 300 ms each way.
    const clock = createClock(() => local);
    expect(clock.messageNow()).toBe(LOCAL);
    const token = await clock.timed(async () => {
      local += 300;
      const issued = local - 23_400;
      local += 300;
      return tokenAt(issued);
    });
    expect(token.expires).toBe(Math.floor((LOCAL + 300 - 23_400 + TOKEN_TTL_MS) / 1000));
    const server = local - 23_400;
    expect(Math.abs(clock.messageNow() - server)).toBeLessThanOrEqual(1000);
    // Logins and signatures keep the device's own time unless the server says it's off (clock_skew).
    expect(clock.now()).toBe(local);
    expect(clock.offset()).toBe(0);
  });

  it('believes a token only within a minute of the device, as far as a login may be off', async () => {
    const local = LOCAL;
    const clock = createClock(() => local);
    await clock.timed(async () => tokenAt(local - 50_000));
    expect(Math.abs(clock.messageNow() - (local - 50_000))).toBeLessThanOrEqual(1000);
    // Further off: the device's own clock again, not the old correction.
    await clock.timed(async () => tokenAt(local + MAX_SKEW_MS + 2000));
    expect(clock.messageNow()).toBe(local);
    await clock.timed(async () => tokenAt(local - 3 * 3600_000));
    expect(clock.messageNow()).toBe(local);
    // A request that fails teaches nothing.
    await clock.timed(async () => tokenAt(local + 20_000));
    await expect(clock.timed(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(Math.abs(clock.messageNow() - (local + 20_000))).toBeLessThanOrEqual(1000);
  });

  it('stamps whole seconds, never going back by less than a minute', () => {
    let t = LOCAL + 999;
    const stamp = stamper(() => t);
    expect(stamp()).toBe(LOCAL);
    t = LOCAL + 1_000;
    expect(stamp()).toBe(LOCAL + 1_000);
    // A new token puts the clock 1.5 s back: what's sent stays where it was.
    t = LOCAL - 500;
    expect(stamp()).toBe(LOCAL + 1_000);
    t = LOCAL + 2_345;
    expect(stamp()).toBe(LOCAL + 2_000);
    // Set back by hours: it goes back with it.
    t = LOCAL - 3 * 3600_000 + 1;
    expect(stamp()).toBe(LOCAL - 3 * 3600_000);
  });
});
