import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushSocket, HEARTBEAT_MS, MAX_REOPEN_RETRY_MS, REOPEN_MS, REOPEN_RETRY_MS } from './socket';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  // Test controls.
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  receive(data: string) {
    this.onmessage?.({ data });
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('push socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    let hints = 0;
    let tokens = 0;
    const socket = createPushSocket({
      url: 'wss://ws.example/live',
      token: async () => `v1.token.${++tokens}`,
      onHint: () => hints++,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    return { socket, hints: () => hints };
  }

  it('connects with the token as a subprotocol, syncs on open and on hints', async () => {
    const { socket, hints } = make();
    socket.start();
    await flush();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe('wss://ws.example/live');
    expect(ws.protocols).toEqual(['v1', 'v1.token.1']);
    expect(socket.connected).toBe(false);
    ws.open();
    expect(socket.connected).toBe(true);
    expect(hints()).toBe(1);
    ws.receive('{"t":"sync"}');
    ws.receive('not json');
    ws.receive('{"t":"other"}');
    expect(hints()).toBe(2);
    // Heartbeats keep it from closing as idle.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(ws.sent).toEqual(['{"action":"ping"}', '{"action":"ping"}']);
  });

  it('says when a socket opens, apart from hints, if asked', async () => {
    let hints = 0;
    let opens = 0;
    const socket = createPushSocket({
      url: 'wss://ws.example/live',
      token: async () => 'v1.token',
      onHint: () => hints++,
      onOpen: () => opens++,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    socket.start();
    await flush();
    FakeSocket.all[0]!.open();
    expect([opens, hints]).toEqual([1, 0]);
    FakeSocket.all[0]!.receive('{"t":"sync"}');
    expect([opens, hints]).toEqual([1, 1]);
    socket.stop();
  });

  it('replaces an open socket about every half hour, opening the new one first', async () => {
    const { socket, hints } = make();
    socket.start();
    await flush();
    const first = FakeSocket.all[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 0.85);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 0.3);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1]!;
    expect(second.protocols).toEqual(['v1', 'v1.token.2']);
    // Until the new one is open, the old one stays, and its hints count.
    expect(first.readyState).toBe(FakeSocket.OPEN);
    expect(socket.connected).toBe(true);
    first.receive('{"t":"sync"}');
    expect(hints()).toBe(2);
    second.open();
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    // The new one syncs on opening; the old one's close starts no retry.
    expect(hints()).toBe(3);
    expect(socket.connected).toBe(true);
    second.receive('{"t":"sync"}');
    expect(hints()).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    // Hidden, it neither stays open nor reopens.
    socket.setVisible(false);
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 2);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('keeps the old socket if its replacement is refused, and tries again later', async () => {
    const { socket } = make();
    socket.start();
    await flush();
    const first = FakeSocket.all[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 1.15);
    const refused = FakeSocket.all[1]!;
    refused.drop(); // the server refused it (too many connects)
    expect(first.readyState).toBe(FakeSocket.OPEN);
    expect(socket.connected).toBe(true);
    // No retry storm: the next try comes about a minute later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REOPEN_RETRY_MS);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.connected).toBe(true);
  });

  it('tries a refused replacement again less often each time, and starts over once one opens', async () => {
    const { socket } = make();
    socket.start();
    await flush();
    FakeSocket.all[0]!.open();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 1.15);
    // Refused four times: tried again after about 1, 2, 4 and 4 minutes.
    for (const minutes of [1, 2, 4, 4]) {
      FakeSocket.all.at(-1)!.drop();
      const tries = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(minutes * REOPEN_RETRY_MS * 0.85);
      expect(FakeSocket.all).toHaveLength(tries);
      await vi.advanceTimersByTimeAsync(minutes * REOPEN_RETRY_MS * 0.3);
      expect(FakeSocket.all).toHaveLength(tries + 1);
    }
    expect(MAX_REOPEN_RETRY_MS).toBe(4 * REOPEN_RETRY_MS);
    // Through: the old one goes, and the next replacement's retry is a minute again.
    FakeSocket.all.at(-1)!.open();
    expect(FakeSocket.all[0]!.readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 1.15);
    FakeSocket.all.at(-1)!.drop();
    const tries = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(REOPEN_RETRY_MS * 1.15);
    expect(FakeSocket.all).toHaveLength(tries + 1);
    expect(socket.connected).toBe(true);
    socket.stop();
  });

  it('drops a replacement still opening when hidden', async () => {
    const { socket } = make();
    socket.start();
    await flush();
    FakeSocket.all[0]!.open();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 1.15);
    const next = FakeSocket.all[1]!;
    socket.setVisible(false);
    expect(next.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.all[0]!.readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 2);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('reconnects with backoff, and closes while hidden', async () => {
    const { socket } = make();
    socket.start();
    await flush();
    FakeSocket.all[0]!.drop();
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.all).toHaveLength(2);
    // A fresh token each time.
    expect(FakeSocket.all[1]!.protocols[1]).toBe('v1.token.2');
    FakeSocket.all[1]!.drop();
    // The second retry waits longer.
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();

    // Hidden: closed, and not reopened; shown: open again at once.
    socket.setVisible(false);
    expect(FakeSocket.all[2]!.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all).toHaveLength(3);
    socket.setVisible(true);
    await flush();
    expect(FakeSocket.all).toHaveLength(4);

    socket.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("doesn't connect while hidden", async () => {
    const { socket } = make();
    socket.setVisible(false);
    socket.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(0);
  });
});
