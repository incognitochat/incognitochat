// Seeded randomness for the parsers' property tests: a fixed seed gives the
// same inputs on every run, so a failure names the seed and round that
// reproduce it. Tests only; nothing in the app imports this.

import { concat } from '../crypto/encoding';

/** A small seeded generator (mulberry32): not for keys, only for test inputs. */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    let t = (this.#state = (this.#state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** True one time in n. */
  oneIn(n: number): boolean {
    return this.int(n) === 0;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  bytes(length: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.int(256);
    return out;
  }

  /**
   * A copy with one to four random changes: a flipped bit, a byte or a
   * 32-bit word set to an edge value, bytes inserted, deleted or copied
   * elsewhere, or the end cut off. It may come out equal to the input.
   */
  mutate(input: Uint8Array): Uint8Array<ArrayBuffer> {
    let out: Uint8Array<ArrayBuffer> = Uint8Array.from(input);
    for (let n = 1 + this.int(4); n > 0; n--) {
      const at = this.int(out.length + 1);
      const run = 1 + this.int(16);
      switch (this.int(7)) {
        case 0:
          if (at < out.length) out[at]! ^= 1 << this.int(8);
          break;
        case 1:
          if (at < out.length) out[at] = this.pick([0, 1, 0x7f, 0x80, 0xff, this.int(256)]);
          break;
        case 2:
          if (at + 4 <= out.length) new DataView(out.buffer).setUint32(at, this.pick([0, 1, 7, 8, 16, out.length - at, 0x7fffffff, 0xffffffff, this.int(2 ** 32)]));
          break;
        case 3:
          out = concat(out.subarray(0, at), this.bytes(run), out.subarray(at));
          break;
        case 4:
          out = concat(out.subarray(0, at), out.subarray(at + run));
          break;
        case 5: {
          const from = this.int(out.length + 1);
          out = concat(out.subarray(0, at), out.subarray(from, from + run), out.subarray(at));
          break;
        }
        default:
          out = out.slice(0, at);
      }
    }
    return out;
  }
}
