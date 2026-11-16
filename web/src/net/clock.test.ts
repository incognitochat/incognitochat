import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createClock, MAX_OFFSET_MS, withServerTime } from './clock';

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
