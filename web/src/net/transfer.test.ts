import { describe, expect, it } from 'vitest';
import { createTransfer, TransferError, WrongSize } from './transfer';
import type { Fetch } from './api';

const SIZE = 16 * 1024;

/** A fetch that answers with body, and remembers the request's abort signal. */
function answering(body: ReadableStream<Uint8Array<ArrayBuffer>> | null, headers: Record<string, string> = {}, status = 200) {
  const seen: { signal?: AbortSignal | null | undefined; init?: RequestInit } = {};
  const fetchImpl: Fetch = async (_url, init) => {
    seen.init = init;
    seen.signal = init.signal;
    return new Response(body, { status, headers });
  };
  return { fetchImpl, seen };
}

/** A body of chunk-sized pieces, without end unless total is given; counts what was read. */
function chunks(chunk: number, total = Infinity) {
  const read = { bytes: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(c) {
      if (read.bytes >= total) return c.close();
      const n = Math.min(chunk, total - read.bytes);
      read.bytes += n;
      c.enqueue(new Uint8Array(n).fill(7));
    },
    cancel() {
      read.cancelled = true;
    },
  });
  return { body, read };
}

describe('downloads', () => {
  it('reads exactly the expected size, with progress', async () => {
    const { body } = chunks(4096, SIZE);
    const { fetchImpl, seen } = answering(body, { 'Content-Length': String(SIZE) });
    const progress: number[] = [];
    const bytes = await createTransfer(fetchImpl).get('https://bucket.example/m/x', SIZE, (f) => progress.push(f));
    expect(bytes).toEqual(new Uint8Array(SIZE).fill(7));
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(seen.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' });
  });

  it('stops a compressed answer before reading it: its length is not the upload size', async () => {
    // What a browser hands over for "Content-Encoding: gzip": the length on
    // the wire, and the body unpacked (here 64 MiB from a few dozen KiB).
    const packed = new Uint8Array(
      await new Response(new Blob([new Uint8Array(64 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
    );
    expect(packed.length).toBeLessThan(SIZE * 8);
    const read = { bytes: 0 };
    const unpacked = new Blob([packed])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(
        new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
          transform(piece, c) {
            read.bytes += piece.length;
            c.enqueue(piece);
          },
        }),
      );
    const { fetchImpl, seen } = answering(unpacked, { 'Content-Length': String(packed.length) });
    await expect(createTransfer(fetchImpl).get('https://bucket.example/m/x', SIZE)).rejects.toBeInstanceOf(WrongSize);
    expect(seen.signal?.aborted).toBe(true);
    expect(read.bytes).toBeLessThan(1024 * 1024);
  });

  it('stops as soon as more arrives than the upload size, with no length given', async () => {
    // An answer that never ends, as an unpacked bomb would.
    const { body, read } = chunks(4096);
    const { fetchImpl, seen } = answering(body);
    await expect(createTransfer(fetchImpl).get('https://bucket.example/m/x', SIZE)).rejects.toBeInstanceOf(WrongSize);
    expect(seen.signal?.aborted).toBe(true);
    expect(read.bytes).toBeLessThanOrEqual(SIZE + 3 * 4096);
  });

  it('refuses a short answer, and one whose length is wrong', async () => {
    const short = answering(chunks(4096, SIZE - 1).body);
    await expect(createTransfer(short.fetchImpl).get('https://bucket.example/m/x', SIZE)).rejects.toBeInstanceOf(WrongSize);
    const { body, read } = chunks(4096, 2 * SIZE);
    const long = answering(body, { 'Content-Length': String(2 * SIZE) });
    await expect(createTransfer(long.fetchImpl).get('https://bucket.example/m/x', SIZE)).rejects.toBeInstanceOf(WrongSize);
    expect(long.seen.signal?.aborted).toBe(true);
    expect(read.bytes).toBeLessThanOrEqual(4096);
  });

  it('says how the bucket refused, or that it could not be reached', async () => {
    const refused = answering(null, {}, 403);
    await expect(createTransfer(refused.fetchImpl).get('https://bucket.example/m/x', SIZE)).rejects.toMatchObject({ name: 'TransferError', status: 403 });
    const unreachable: Fetch = async () => {
      throw new TypeError('failed to fetch');
    };
    await expect(createTransfer(unreachable).get('https://bucket.example/m/x', SIZE)).rejects.toMatchObject({ name: 'TransferError', status: 0 });
  });
});

/** Just enough of XMLHttpRequest for an upload. */
class FakeXhr {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly answer: number | 'unreachable') {}

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      if (this.answer === 'unreachable') return this.onerror?.();
      this.status = this.answer;
      this.onload?.();
    });
  }
}

describe('uploads', () => {
  const put = (answer: number | 'unreachable') => {
    const xhr = new FakeXhr(answer);
    const transfer = createTransfer(undefined, () => xhr as unknown as XMLHttpRequest);
    return { xhr, done: transfer.put('https://bucket.example/m/x?signed', new Uint8Array(SIZE)) };
  };

  it('sends the signed headers: the type, and If-None-Match so it writes only once', async () => {
    const { xhr, done } = put(200);
    await done;
    expect(xhr.method).toBe('PUT');
    expect(xhr.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' });
  });

  it('says how the bucket refused, or that it could not be reached', async () => {
    await expect(put(412).done).rejects.toMatchObject({ status: 412 });
    await expect(put(403).done).rejects.toMatchObject({ status: 403 });
    const failed = put('unreachable').done;
    await expect(failed).rejects.toBeInstanceOf(TransferError);
    await expect(failed).rejects.toMatchObject({ status: 0 });
  });
});
