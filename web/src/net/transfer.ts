// Uploads and downloads of encrypted attachments, straight to and from the
// media bucket with presigned URLs (docs/protocol.md, Media). Uploads use
// XMLHttpRequest, for upload progress; downloads use fetch, to read the
// answer as it arrives and stop it as soon as it's the wrong size, or stalls.

import { NetworkError, type Fetch } from './api';

/** The bucket refused a transfer, or never answered (status 0). */
export class TransferError extends NetworkError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

/** A download wasn't the size the message says: not the upload it should be. */
export class WrongSize extends Error {
  constructor() {
    super('media: wrong size');
    this.name = 'WrongSize';
  }
}

/**
 * A download that gets no answer, or no more bytes, for this long is given
 * up as unreachable: long enough for a slow connection, short enough that a
 * dead one doesn't hold a download (and its place in the queue) for minutes.
 */
export const DOWNLOAD_IDLE_MS = 30_000;

/**
 * The same for an upload: given up when no more of it goes, or no answer
 * comes after the last of it, for this long. Longer than a download's
 * wait, since bytes count as sent when they leave the app, and on a slow
 * uplink the last of them may still take a while to arrive.
 */
export const UPLOAD_IDLE_MS = 60_000;

export interface Transfer {
  /**
   * PUTs the bytes to a presigned upload URL. Rejects with a TransferError;
   * 412 means the upload is already there (an earlier try wrote it). Gives
   * up (TransferError, status 0) when no more bytes go for UPLOAD_IDLE_MS.
   */
  put(url: string, body: Uint8Array<ArrayBuffer>, onProgress?: (fraction: number) => void): Promise<void>;
  /**
   * GETs exactly size bytes from a presigned download URL, and stops (with
   * WrongSize) as soon as the answer says or turns out otherwise. Gives up
   * (TransferError, status 0) when nothing arrives for DOWNLOAD_IDLE_MS.
   */
  get(url: string, size: number, onProgress?: (fraction: number) => void): Promise<Uint8Array<ArrayBuffer>>;
}

/** p, or a TransferError (unreachable) if it doesn't settle within ms. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransferError(0, 'media GET stalled')), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createTransfer(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  newXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
  idleMs = DOWNLOAD_IDLE_MS,
  uploadIdleMs = UPLOAD_IDLE_MS,
): Transfer {
  return {
    put: (url, body, onProgress) =>
      new Promise((resolve, reject) => {
        const xhr = newXhr();
        // An XHR has no idle timeout (xhr.timeout limits the whole upload,
        // and a large one on a slow link may need minutes): it's stopped
        // when no progress comes for UPLOAD_IDLE_MS, so a dead connection
        // fails, and is tried again, instead of hanging.
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const watch = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            reject(new TransferError(0, 'media PUT stalled'));
            xhr.abort();
          }, uploadIdleMs);
        };
        xhr.open('PUT', url);
        // Both are part of the URL's signature. If-None-Match: * has S3
        // write the upload only if it isn't there yet.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('If-None-Match', '*');
        xhr.upload.onprogress = (e) => {
          watch();
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onload = () => {
          clearTimeout(watchdog);
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new TransferError(xhr.status, `media PUT failed (${xhr.status})`));
        };
        xhr.onerror = () => {
          clearTimeout(watchdog);
          reject(new TransferError(0, 'media PUT failed'));
        };
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = xhr.onerror;
        watch();
        xhr.send(body);
      }),

    async get(url, size, onProgress) {
      const stop = new AbortController();
      let response: Response;
      try {
        // no-store: the browser keeps no copy of the ciphertext in its cache;
        // the bucket answers Cache-Control: no-store as well.
        response = await within(
          fetchImpl(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', redirect: 'error', signal: stop.signal }),
          idleMs,
        );
      } catch (err) {
        stop.abort();
        throw err instanceof TransferError ? err : new TransferError(0, 'media GET failed');
      }
      if (!response.ok) {
        stop.abort();
        throw new TransferError(response.status, `media GET failed (${response.status})`);
      }
      // The download URL has S3 answer uncompressed, so the length on the
      // wire is the upload's. Any other means it isn't the upload, or the
      // browser would unpack it into something else.
      const length = response.headers.get('Content-Length');
      if ((length !== null && Number(length) !== size) || !response.body) {
        stop.abort();
        throw new WrongSize();
      }
      const out = new Uint8Array(size);
      const reader = response.body.getReader();
      let got = 0;
      try {
        for (;;) {
          const { done, value } = await within(reader.read(), idleMs);
          if (done) break;
          // Stopped at once if more arrives than the upload can hold.
          if (got + value.length > size) throw new WrongSize();
          out.set(value, got);
          got += value.length;
          onProgress?.(got / size);
        }
      } catch (err) {
        stop.abort();
        void reader.cancel().catch(() => {});
        if (err instanceof WrongSize || err instanceof TransferError) throw err;
        throw new TransferError(0, 'media GET failed');
      }
      if (got !== size) throw new WrongSize();
      return out;
    },
  };
}

export const httpTransfer: Transfer = createTransfer();
