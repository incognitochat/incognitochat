// Uploads and downloads of encrypted attachments, straight to and from the
// media bucket with presigned URLs (docs/protocol.md, Media). Uploads use
// XMLHttpRequest, for upload progress; downloads use fetch, to read the
// answer as it arrives and stop it as soon as it's the wrong size.

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

export interface Transfer {
  /**
   * PUTs the bytes to a presigned upload URL. Rejects with a TransferError;
   * 412 means the upload is already there (an earlier try wrote it).
   */
  put(url: string, body: Uint8Array<ArrayBuffer>, onProgress?: (fraction: number) => void): Promise<void>;
  /**
   * GETs exactly size bytes from a presigned download URL, and stops (with
   * WrongSize) as soon as the answer says or turns out otherwise.
   */
  get(url: string, size: number, onProgress?: (fraction: number) => void): Promise<Uint8Array<ArrayBuffer>>;
}

export function createTransfer(fetchImpl: Fetch = (input, init) => fetch(input, init), newXhr: () => XMLHttpRequest = () => new XMLHttpRequest()): Transfer {
  return {
    put: (url, body, onProgress) =>
      new Promise((resolve, reject) => {
        const xhr = newXhr();
        xhr.open('PUT', url);
        // Both are part of the URL's signature. If-None-Match: * has S3
        // write the upload only if it isn't there yet.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('If-None-Match', '*');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new TransferError(xhr.status, `media PUT failed (${xhr.status})`)));
        xhr.onerror = () => reject(new TransferError(0, 'media PUT failed'));
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = xhr.onerror;
        xhr.send(body);
      }),

    async get(url, size, onProgress) {
      const stop = new AbortController();
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', redirect: 'error', signal: stop.signal });
      } catch {
        throw new TransferError(0, 'media GET failed');
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
          const { done, value } = await reader.read();
          if (done) break;
          // Stopped at once if more arrives than the upload can hold.
          if (got + value.length > size) throw new WrongSize();
          out.set(value, got);
          got += value.length;
          onProgress?.(got / size);
        }
      } catch (err) {
        stop.abort();
        if (err instanceof WrongSize) throw err;
        throw new TransferError(0, 'media GET failed');
      }
      if (got !== size) throw new WrongSize();
      return out;
    },
  };
}

export const httpTransfer: Transfer = createTransfer();
