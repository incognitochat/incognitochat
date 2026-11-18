import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import { createBackoff, isServerTrouble } from './backoff';

const BASE = 20_000;
const MAX = 300_000;

function clock(random = () => 0.5) {
  const time = { now: 1_000_000 };
  const backoff = createBackoff({ baseMs: BASE, maxMs: MAX, now: () => time.now, random });
  return { time, backoff };
}

describe('backoff', () => {
  it('counts no answer, server errors and refusals for load, not the rest', () => {
    for (const err of [new NetworkError('request failed'), new ApiError(503, 'unavailable'), new ApiError(500, 'internal'), new ApiError(502, 'unknown'), new ApiError(429, 'rate_limited')]) {
      expect(isServerTrouble(err)).toBe(true);
    }
    for (const err of [new ApiError(400, 'bad_request'), new ApiError(401, 'session_expired'), new ApiError(404, 'not_found'), new Error('bug'), undefined]) {
      expect(isServerTrouble(err)).toBe(false);
    }
    const { backoff } = clock();
    expect(backoff.failed(new ApiError(401, 'session_expired'))).toBe(false);
    expect(backoff.remaining()).toBe(0);
  });

  it('waits longer after each failure in a row, jittered, up to the cap', () => {
    for (const [r, low] of [
      [0, true],
      [0.999999, false],
    ] as const) {
      const { time, backoff } = clock(() => r);
      let ceiling = BASE;
      for (let i = 0; i < 8; i++) {
        expect(backoff.failed(new ApiError(503, 'unavailable'))).toBe(true);
        const wait = backoff.remaining();
        // Half to all of the ceiling.
        if (low) expect(wait).toBe(ceiling / 2);
        else expect(wait).toBeCloseTo(ceiling, -1);
        expect(wait).toBeLessThanOrEqual(MAX);
        time.now += wait;
        expect(backoff.remaining()).toBe(0);
        ceiling = Math.min(ceiling * 2, MAX);
      }
    }
  });

  it('waits at least what the server asks, up to the cap', () => {
    const { time, backoff } = clock(() => 0);
    backoff.failed(new ApiError(503, 'unavailable', undefined, undefined, 60));
    expect(backoff.remaining()).toBe(60_000);
    // Less than its own wait: its own.
    time.now += 60_000;
    backoff.failed(new ApiError(503, 'unavailable', undefined, undefined, 2));
    expect(backoff.remaining()).toBe(BASE);
    // A day: no longer than the cap.
    backoff.failed(new ApiError(429, 'daily_limit', undefined, undefined, 86_400));
    expect(backoff.remaining()).toBe(MAX);
  });

  it('starts over after a success', () => {
    const { time, backoff } = clock(() => 0);
    for (let i = 0; i < 5; i++) backoff.failed(new NetworkError('request failed'));
    expect(backoff.remaining()).toBe(Math.min(BASE * 2 ** 4, MAX) / 2);
    backoff.succeeded();
    expect(backoff.remaining()).toBe(0);
    backoff.failed(new NetworkError('request failed'));
    expect(backoff.remaining()).toBe(BASE / 2);
    time.now += BASE;
    expect(backoff.remaining()).toBe(0);
  });

  it('ends a wait the clock was set back past', () => {
    const { time, backoff } = clock(() => 0);
    backoff.failed(new NetworkError('request failed'));
    time.now -= 2 * MAX;
    expect(backoff.remaining()).toBe(0);
  });
});
