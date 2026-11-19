import { afterEach, describe, expect, it, vi } from 'vitest';
import { openChannel, pendingLocks, useProfile, withLock, withLockIfFree, type LockManagerLike, type SyncEvent } from './locks';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every test runs twice: with the device's Web Locks (undefined: the
// default), and as on an engine without them (null), where the lock is held
// in this copy of the app only.
describe.each([
  ['with Web Locks', undefined],
  ['without Web Locks', null],
] as [string, LockManagerLike | null | undefined][])('%s', (_, locks) => {
  describe('withLock', () => {
    it('never lets two holders of the same lock interleave', async () => {
      const order: string[] = [];
      const task = (id: string) =>
        withLock(
          'test-interleave',
          async () => {
            order.push(`${id}:start`);
            await sleep(10);
            order.push(`${id}:end`);
            return id;
          },
          locks,
        );
      const results = await Promise.all([task('a'), task('b'), task('c')]);
      expect(results).toEqual(['a', 'b', 'c']);
      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    });

    it('lets different locks run at the same time, one inside another', async () => {
      let concurrent = 0;
      let peak = 0;
      const task = (name: string) =>
        withLock(
          name,
          async () => {
            concurrent++;
            peak = Math.max(peak, concurrent);
            await sleep(10);
            concurrent--;
          },
          locks,
        );
      await Promise.all([task('x'), task('y')]);
      expect(peak).toBe(2);
      expect(await withLock('outer', () => withLock('inner', async () => 'both', locks), locks)).toBe('both');
    });

    it('releases the lock when the task fails, and the next holder runs', async () => {
      const failing = withLock('fails', async () => {
        await sleep(5);
        throw new Error('boom');
      }, locks);
      const next = withLock('fails', async () => 'ok', locks);
      await expect(failing).rejects.toThrow('boom');
      expect(await next).toBe('ok');
      expect(await withLock('fails', async () => 'again', locks)).toBe('again');
    });
  });

  describe('withLockIfFree', () => {
    it('runs holding the lock when nobody has it, and gives up at once when somebody does', async () => {
      expect(await withLockIfFree('test-free', async () => 1, locks)).toEqual({ value: 1 });
      let release!: () => void;
      const holding = withLock('test-free', () => new Promise<void>((r) => (release = r)), locks);
      let ran = false;
      expect(
        await withLockIfFree(
          'test-free',
          async () => {
            ran = true;
          },
          locks,
        ),
      ).toBeNull();
      expect(ran).toBe(false);
      release();
      await holding;
      expect(await withLockIfFree('test-free', async () => 2, locks)).toEqual({ value: 2 });
    });

    it('holds the lock while it runs: others wait their turn', async () => {
      const order: string[] = [];
      const free = withLockIfFree(
        'test-held',
        async () => {
          await sleep(10);
          order.push('free');
        },
        locks,
      );
      const after = withLock('test-held', async () => void order.push('after'), locks);
      expect(await free).toEqual({ value: undefined });
      await after;
      expect(order).toEqual(['free', 'after']);
    });
  });
});

describe('without Web Locks on the device', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('locks in this copy of the app, by default', async () => {
    vi.stubGlobal('navigator', {});
    expect(navigator.locks).toBeUndefined();
    const order: string[] = [];
    const task = (id: string) =>
      withLock('test-default', async () => {
        order.push(`${id}:start`);
        await sleep(5);
        order.push(`${id}:end`);
      });
    let release!: () => void;
    const holding = withLock('test-default-free', () => new Promise<void>((r) => (release = r)));
    expect(await withLockIfFree('test-default-free', async () => 1)).toBeNull();
    await Promise.all([task('a'), task('b')]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    release();
    await holding;
    expect(await withLockIfFree('test-default-free', async () => 1)).toEqual({ value: 1 });
  });

  it('keeps profiles apart', async () => {
    let release!: () => void;
    useProfile('p1');
    const holding = withLock('test-profile', () => new Promise<void>((r) => (release = r)), null);
    useProfile('p2');
    expect(await withLockIfFree('test-profile', async () => 1, null)).toEqual({ value: 1 });
    useProfile('p1');
    expect(await withLockIfFree('test-profile', async () => 1, null)).toBeNull();
    useProfile('');
    release();
    await holding;
  });

  it('lists the locks requests wait for, for tests', async () => {
    let release!: () => void;
    const holding = withLock('test-pending', () => new Promise<void>((r) => (release = r)), null);
    expect(pendingLocks()).toEqual([]);
    const next = withLock('test-pending', async () => 'next', null);
    const after = withLock('test-pending', async () => 'after', null);
    expect(pendingLocks()).toEqual(['incognitochat:test-pending']);
    await sleep(5);
    expect(pendingLocks()).toEqual(['incognitochat:test-pending']);
    release();
    await holding;
    expect(await next).toBe('next');
    expect(await after).toBe('after');
    expect(pendingLocks()).toEqual([]);
  });
});

describe('openChannel', () => {
  it('delivers known events between copies and ignores anything else', async () => {
    const received: SyncEvent[] = [];
    const a = openChannel(() => {});
    const b = openChannel((e) => received.push(e));
    expect(a && b).toBeTruthy();
    a!.send({ type: 'keys-changed' });
    new BroadcastChannel('incognitochat:sync').postMessage({ type: 'evil', payload: 'x' });
    await sleep(20);
    expect(received).toEqual([{ type: 'keys-changed' }]);
    a!.close();
    b!.close();
  });
});

describe('profiles', () => {
  it('keep channels apart', async () => {
    const received: SyncEvent[] = [];
    useProfile('p1');
    const a = openChannel(() => {});
    useProfile('p2');
    const b = openChannel((e) => received.push(e));
    a!.send({ type: 'account-changed' });
    await sleep(20);
    expect(received).toEqual([]);
    a!.close();
    b!.close();
    useProfile('');
  });
});
