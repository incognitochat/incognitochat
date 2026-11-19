import { describe, expect, it } from 'vitest';
import { concat } from '../crypto/encoding';
import { Random } from '../testing/random';
import { MAX_BOXES, MAX_DEPTH, stripVideoMetadata } from './mp4';

const text = (s: string) => new TextEncoder().encode(s);
const types = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
/** A box type's 4 bytes ("©xyz" is 0xA9 then "xyz"). */
const fourcc = (type: string) => Uint8Array.from(type, (c) => c.charCodeAt(0));

function box(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...children);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(fourcc(type), 4);
  out.set(body, 8);
  return out;
}

/** A box with a 64-bit size. */
function large(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...children);
  const out = new Uint8Array(16 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  out.set(fourcc(type), 4);
  view.setUint32(12, out.length);
  out.set(body, 16);
  return out;
}

/** A header box: version, flags, then the two times filled with 0xAA, then 4 more bytes. */
function header(type: string, version: 0 | 1): Uint8Array {
  const times = new Uint8Array(version === 1 ? 16 : 8).fill(0xaa);
  return box(type, new Uint8Array([version, 0, 0, 0]), times, new Uint8Array([1, 2, 3, 4]));
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
/** "uuid" types: Adobe's XMP, Sony's dates (USMT), Canon's EXIF and GPS, Garmin's GPS, and Google's 360° video (which players read). */
const XMP = hex('be7acfcb97a942e89c71999491e3afac');
const USMT = hex('55534d5421d24fcebb88695cfac9c740');
const CANON = hex('85c0b687820f11e08111f4ce462b6a48');
const GARMIN = hex('9b630f8d637440ec8204bc5ff5091728');
const SPHERICAL = hex('ffcc8263f8554a938814587a02521fdd');
const MAKERS = [XMP, USMT, CANON, GARMIN];
const GPS = '+52.3676+004.9041/';

/** A chunk offset table (stco, or co64 with 64-bit offsets). */
function chunkTable(type: 'stco' | 'co64', ...offsets: number[]): Uint8Array<ArrayBuffer> {
  const step = type === 'co64' ? 8 : 4;
  const body = new Uint8Array(8 + offsets.length * step);
  const view = new DataView(body.buffer);
  view.setUint32(4, offsets.length);
  offsets.forEach((offset, i) => {
    if (step === 8) view.setUint32(8 + i * 8, Math.floor(offset / 2 ** 32));
    view.setUint32(8 + i * step + step - 4, offset % 2 ** 32);
  });
  return box(type, body);
}

function movie(): Uint8Array {
  return concat(
    box('ftyp', text('qt  ')),
    box('mdat', text('frames')),
    box(
      'moov',
      header('mvhd', 0),
      box('trak', header('tkhd', 1), box('mdia', header('mdhd', 0), box('hdlr', text('vide'))), box('udta', text('name'))),
      box('udta', box('©xyz', text(GPS))),
      box('meta', box('keys', text('com.apple.quicktime.location.ISO6709')), box('ilst', text(GPS))),
    ),
  );
}

/** `depth` boxes of this type, each inside the one before, around inner. */
function nested(type: string, depth: number, inner: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(depth * 8 + inner.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < depth; i++) {
    view.setUint32(i * 8, out.length - i * 8);
    out.set(fourcc(type), i * 8 + 4);
  }
  out.set(inner, depth * 8);
  return out;
}

describe('stripVideoMetadata', () => {
  it('drops location and device metadata and recording times, keeping the length', () => {
    const bytes = movie();
    const before = bytes.slice();
    expect(stripVideoMetadata(bytes)).toBe(true);
    expect(bytes.length).toBe(before.length);
    const after = types(bytes);
    expect(after).not.toContain('udta');
    expect(after).not.toContain('meta');
    expect(after).toContain('free');
    expect(after).not.toContain('52.3676');
    expect(after).not.toContain('com.apple');
    expect(after).not.toContain('name');
    expect(after).toContain('frames');
    expect(after).toContain('vide');
    expect(bytes.includes(0xaa)).toBe(false);
    // Everything outside the metadata boxes and the times is as it was.
    expect(types(bytes.subarray(0, 30))).toBe(types(before.subarray(0, 30)));
  });

  it('reads 64-bit and to-the-end sizes', () => {
    const last = box('free', text('end'));
    new DataView(last.buffer).setUint32(0, 0);
    const bytes = concat(box('ftyp', text('isom')), large('mdat', text('frames')), large('moov', box('udta', text('where'))), last);
    expect(stripVideoMetadata(bytes)).toBe(true);
    expect(types(bytes)).not.toContain('udta');
    expect(types(bytes)).not.toContain('where');
    expect(types(bytes)).toContain('frames');
    // A to-the-end size inside a box runs to the end of that box.
    const open = box('udta', text(GPS));
    new DataView(open.buffer).setUint32(0, 0);
    const inside = concat(box('ftyp', text('isom')), box('moov', header('mvhd', 0), open), box('mdat', text('frames')));
    expect(stripVideoMetadata(inside)).toBe(true);
    expect(types(inside)).not.toContain(GPS);
    expect(types(inside)).toContain('frames');
  });

  it('looks into edit lists, media information and sample tables, leaving chunk offsets right', () => {
    // One track whose chunk table points at the frames in mdat; metadata in
    // every box walked, and free boxes with data in them. moov first is what
    // phones and "faststart" write: then everything stripped is before the
    // frames, so nothing may move.
    const frames = text('frames');
    const file = (order: 'moov first' | 'mdat first', table: 'stco' | 'co64', offset: number) => {
      const chunks = chunkTable(table, offset);
      const stbl = box('stbl', box('stsd', text('avc1')), chunks, box('meta', text('stbl note')), box('skip', text('stbl padding')));
      const minf = box('minf', box('vmhd', text('vmhd')), box('udta', box('©xyz', text(GPS))), stbl);
      const trak = box('trak', header('tkhd', 0), box('edts', box('elst', text('edit list')), box('udta', text('edts note'))), box('mdia', header('mdhd', 1), box('hdlr', text('vide')), minf));
      const moov = box('moov', header('mvhd', 1), box('udta', text('moov note')), box('free', text('moov padding')), trak);
      const head = box('ftyp', text('isom'));
      const free = box('free', text('camera serial 1234'));
      const mdat = box('mdat', frames);
      return { bytes: order === 'moov first' ? concat(head, moov, free, mdat) : concat(head, free, mdat, moov), chunks };
    };
    for (const order of ['moov first', 'mdat first'] as const) {
      for (const table of ['stco', 'co64'] as const) {
        const offset = types(file(order, table, 0).bytes).indexOf('frames');
        const { bytes, chunks } = file(order, table, offset);
        const before = bytes.slice();
        expect(stripVideoMetadata(bytes), order).toBe(true);
        expect(bytes.length).toBe(before.length);
        const after = types(bytes);
        for (const gone of [GPS, 'moov note', 'edts note', 'stbl note', 'udta', 'meta', 'padding', 'serial']) expect(after, `${order}, ${table}`).not.toContain(gone);
        for (const kept of ['edit list', 'vmhd', 'avc1', 'stsd', 'skip']) expect(after).toContain(kept);
        expect(bytes.includes(0xaa)).toBe(false);
        // The chunk table is as it was, and still points at the frames.
        const at = after.indexOf(table) - 4;
        expect(bytes.subarray(at, at + chunks.length)).toEqual(chunks);
        expect(types(bytes.subarray(offset, offset + frames.length)), `${order}, ${table}`).toBe('frames');
      }
    }
  });

  it('drops known metadata uuid boxes wherever they are, and every top-level one', () => {
    const bytes = concat(
      box('ftyp', text('iso6')),
      box(
        'moov',
        header('mvhd', 0),
        // Where cameras put them: Sony's in the movie and in tracks, Canon's and Garmin's in the movie.
        box('uuid', USMT, text('<ProductionDate>2026')),
        box('uuid', CANON, box('CMT4', text('GPSLatitude 52,22N'))),
        box('uuid', GARMIN, text('GPS track')),
        box('uuid', XMP, text('<exif:GPSLatitude>52,22N')),
        box('uuid', new Uint8Array(16).fill(7), text('unknown in moov')),
        box('trak', header('tkhd', 0), box('uuid', USMT, text('<ModifyDate>2026')), box('uuid', SPHERICAL, text('<Spherical>true</Spherical>'))),
      ),
      box('moof', text('fragment')),
      box('mdat', text('frames')),
      box('uuid', XMP, text('<xmp:CreateDate>2026')),
      box('uuid', text('PROF'), new Uint8Array(12).fill(7), text('<Profile>')),
    );
    expect(stripVideoMetadata(bytes)).toBe(true);
    const after = types(bytes);
    for (const gone of ['GPS', 'Date', 'Profile', 'PROF']) expect(after).not.toContain(gone);
    expect(after.match(/uuid/g)).toHaveLength(2);
    // Unknown uuid boxes inside the movie may be something players read (here, 360° video): kept.
    expect(after).toContain('<Spherical>true</Spherical>');
    expect(after).toContain('unknown in moov');
    expect(after).toContain('fragment');
  });

  it('empties free and skip boxes, except one a chunk offset points into', () => {
    // The frames sit in a free box (no muxer does that, but players follow
    // the chunk offsets): that one keeps its contents.
    const head = concat(box('ftyp', text('isom')), box('skip', text('CNTH thumbnail')));
    const offset = head.length + 8;
    const bytes = concat(head, box('free', text('frames')), box('moov', header('mvhd', 0), box('trak', box('mdia', box('minf', box('stbl', chunkTable('stco', offset)))))), box('free', text('DJI')));
    expect(stripVideoMetadata(bytes)).toBe(true);
    const after = types(bytes);
    expect(after).toContain('freeframes');
    expect(after).not.toContain('CNTH');
    expect(after).not.toContain('DJI');
    expect(after.match(/free|skip/g)).toHaveLength(3);
  });

  it('leaves free and skip boxes as they are where it can not tell where the samples are', () => {
    const head = box('ftyp', text('isom'));
    const free = box('free', text('kept'));
    const stbl = (...children: Uint8Array[]) => box('moov', header('mvhd', 0), box('trak', box('mdia', box('minf', box('stbl', ...children)))));
    // A chunk table that says it has more chunks than it holds.
    const short = chunkTable('stco', 1, 2);
    new DataView(short.buffer).setUint32(12, 3);
    for (const bytes of [
      // Fragmented: its samples are found from each moof.
      concat(head, box('moov', header('mvhd', 0)), free, box('moof', text('fragment')), box('mdat', text('frames'))),
      // A sample table that can't be read, or a chunk table.
      concat(head, stbl(chunkTable('stco', 1), new Uint8Array(3)), free),
      concat(head, stbl(short), free),
      concat(head, stbl(box('co64', new Uint8Array(6))), free),
    ]) {
      expect(stripVideoMetadata(bytes)).toBe(true);
      expect(types(bytes)).toContain('freekept');
      expect(bytes.includes(0xaa)).toBe(false);
    }
  });

  it('zeroes the dates in pnot and prft, keeping the rest', () => {
    // pnot: modification date, version, the preview's type and index.
    const pnot = box('pnot', new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa, 0, 0]), text('PICT'), new Uint8Array([0, 1]));
    // prft (version 1): version and flags, track ID, NTP time, media time.
    const prft = box('prft', new Uint8Array([1, 0, 0, 0x18, 0, 0, 0, 1]), new Uint8Array(16).fill(0xaa));
    const short = box('prft', new Uint8Array([0, 0, 0, 0, 0, 0]));
    const bytes = concat(pnot, box('PICT', text('preview')), box('moov', header('mvhd', 0)), prft, box('moof', text('fragment')), box('mdat', text('frames')), short);
    const before = bytes.slice();
    expect(stripVideoMetadata(bytes)).toBe(true);
    expect(bytes.includes(0xaa)).toBe(false);
    expect(bytes.subarray(8, 12)).toEqual(new Uint8Array(4));
    expect(bytes.subarray(12, pnot.length)).toEqual(before.subarray(12, pnot.length));
    const at = types(bytes).indexOf('prft') + 4;
    expect(bytes.subarray(at, at + 8)).toEqual(new Uint8Array([1, 0, 0, 0x18, 0, 0, 0, 1]));
    expect(bytes.subarray(at + 8, at + 24)).toEqual(new Uint8Array(16));
    expect(bytes.subarray(-short.length)).toEqual(short);
  });

  it('leaves a sample table it can not read as it is, and strips the rest', () => {
    // An stbl whose contents don't add up (3 bytes too many), with a udta in it.
    const stbl = box('stbl', box('udta', text('kept')), new Uint8Array([1, 2, 3]));
    const bytes = concat(box('ftyp', text('isom')), box('moov', header('mvhd', 0), box('trak', box('mdia', box('minf', stbl))), box('udta', text(GPS))), box('mdat', text('frames')));
    expect(stripVideoMetadata(bytes)).toBe(true);
    const after = types(bytes);
    expect(after).not.toContain(GPS);
    expect(after).toContain('udtakept');
    expect(bytes.includes(0xaa)).toBe(false);
  });

  it('leaves anything else untouched', () => {
    for (const bytes of [
      text('not a video at all'),
      new Uint8Array(0),
      box('ftyp', text('isom')),
      concat(box('ftyp', text('isom')), box('moov', box('udta')).subarray(0, 12)),
      concat(box('uuid', XMP), box('moov', box('udta', text(GPS)))),
    ]) {
      const before = bytes.slice();
      expect(stripVideoMetadata(bytes)).toBe(false);
      expect(bytes).toEqual(before);
    }
  });

  it('refuses boxes that do not add up, changing nothing', () => {
    const head = box('ftyp', text('isom'));
    const meta = box('udta', text(GPS));
    const past = box('moov', meta);
    new DataView(past.buffer).setUint32(0, past.length + 1);
    const childPast = box('moov', meta);
    new DataView(childPast.buffer).setUint32(8, meta.length + 1);
    const tooSmall = box('moov', meta);
    new DataView(tooSmall.buffer).setUint32(8, 7);
    // 64-bit sizes: past the end (by 4 GiB), smaller than their own header, and cut short.
    const huge = large('moov', meta);
    new DataView(huge.buffer).setUint32(8, 1);
    const tiny = large('moov', meta);
    new DataView(tiny.buffer).setUint32(12, 15);
    const cut = large('free').subarray(0, 12);
    // A to-the-end size takes in the rest of the file, the moov after it too.
    const mdat = box('mdat');
    new DataView(mdat.buffer).setUint32(0, 0);
    for (const tail of [past, childPast, tooSmall, huge, tiny, concat(box('moov', meta), cut), concat(mdat, box('moov', meta))]) {
      const bytes = concat(head, tail);
      const before = bytes.slice();
      expect(stripVideoMetadata(bytes)).toBe(false);
      expect(bytes).toEqual(before);
    }
  });

  it('refuses boxes nested too deep, without overflowing the stack', () => {
    const head = box('ftyp', text('isom'));
    // MAX_DEPTH boxes down is as deep as it reads: moov inside moov, a udta at the bottom.
    const deepest = concat(head, nested('moov', MAX_DEPTH, box('udta', text(GPS))));
    expect(stripVideoMetadata(deepest)).toBe(true);
    expect(types(deepest)).not.toContain(GPS);
    for (const depth of [MAX_DEPTH + 1, 10_000, 100_000]) {
      const bytes = concat(head, box('moov', header('mvhd', 0)), nested('moov', depth, box('udta', text(GPS))));
      const before = bytes.slice();
      expect(stripVideoMetadata(bytes)).toBe(false);
      expect(bytes).toEqual(before);
    }
    // Deep in a sample table too, which is otherwise left alone when it can't be read.
    const stbl = concat(head, box('moov', nested('stbl', 10_000, box('udta', text(GPS)))));
    expect(stripVideoMetadata(stbl)).toBe(false);
  });

  it('refuses a file of too many boxes, changing nothing', () => {
    // ftyp, moov, then 8-byte boxes: MAX_BOXES in all is still read, one more isn't.
    const head = concat(box('ftyp', text('isom')), box('moov'));
    const bytes = new Uint8Array(head.length + (MAX_BOXES - 1) * 8);
    bytes.set(head);
    for (let at = head.length; at < bytes.length; at += 8) {
      bytes[at + 3] = 8;
      bytes.set([0x75, 0x64, 0x74, 0x61], at + 4); // "udta"
    }
    const before = bytes.slice();
    expect(stripVideoMetadata(bytes)).toBe(false);
    // (Compared by hand: toEqual is slow on 8 MB.)
    expect(bytes.every((b, i) => b === before[i])).toBe(true);
    const fewer = bytes.subarray(0, bytes.length - 8);
    expect(stripVideoMetadata(fewer)).toBe(true);
    expect(types(fewer.subarray(-8))).toBe('\0\0\0\x08free');
  });
});

/**
 * A made-up movie for the property tests, as a tree: write turns it into
 * bytes, and strippedFile into what stripVideoMetadata should make of them.
 */
interface Node {
  type: string;
  /** For a uuid box: its 16-byte type. */
  uuid?: Uint8Array;
  body?: Uint8Array;
  children?: Node[];
  /** For a chunk table (stco, co64): its offsets, which make its body. */
  offsets?: number[];
  /** Bytes after the children that don't make a box: the container can't be read. */
  junk?: Uint8Array;
  /** A 64-bit size, or (for the last box in the file) a to-the-end size of 0. */
  size?: 'large' | 'open';
}

function write(node: Node): Uint8Array<ArrayBuffer> {
  if (node.offsets) return chunkTable(node.type as 'stco' | 'co64', ...node.offsets);
  const body = concat(node.uuid ?? new Uint8Array(0), node.body ?? new Uint8Array(0), ...(node.children ?? []).map(write), node.junk ?? new Uint8Array(0));
  return node.size === 'large' ? large(node.type, body) : box(node.type, body);
}

function writeFile(top: Node[]): Uint8Array<ArrayBuffer> {
  const bytes = concat(...top.map(write));
  const last = top.at(-1)!;
  if (last.size === 'open') new DataView(bytes.buffer).setUint32(bytes.length - write(last).length, 0);
  return bytes;
}

/** Where each box starts and ends in the written file. */
function place(nodes: Node[], at = 0, out = new Map<Node, [number, number]>()): Map<Node, [number, number]> {
  for (const node of nodes) {
    const length = write(node).length;
    out.set(node, [at, at + length]);
    if (node.children) place(node.children, at + (node.size === 'large' ? 16 : 8) + (node.uuid?.length ?? 0) + (node.body?.length ?? 0), out);
    at += length;
  }
  return out;
}

const CONTAINERS = ['moov', 'trak', 'mdia', 'edts', 'minf', 'stbl'];

/** The boxes stripVideoMetadata reads: the top level, and inside the containers it can read. */
function walked(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...(CONTAINERS.includes(node.type) && !node.junk ? walked(node.children!) : [])]);
}

/** The file as stripVideoMetadata should leave it. */
function strippedFile(top: Node[]): Uint8Array<ArrayBuffer> {
  const boxes = walked(top);
  // Free and skip boxes are emptied, unless a chunk offset points into one,
  // or where the samples are isn't known (a fragmented file, a sample table
  // that can't be read).
  const where = place(top);
  const offsets = boxes.flatMap((node) => node.offsets ?? []);
  const unsure = top.some((node) => node.type === 'moof') || boxes.some((node) => CONTAINERS.includes(node.type) && node.junk);
  const empty = (node: Node) => {
    const [start, end] = where.get(node)!;
    return !unsure && !offsets.some((offset) => offset >= start && offset < end);
  };
  return writeFile(top.map((node) => stripped(node, 0, empty)));
}

function stripped(node: Node, depth: number, empty: (node: Node) => boolean): Node {
  const zero = (bytes: Uint8Array, from: number, to = bytes.length) => {
    const out = bytes.slice();
    out.fill(0, Math.min(from, out.length), to);
    return out;
  };
  const known = (uuid: Uint8Array) => MAKERS.some((maker) => maker.every((b, i) => b === uuid[i]));
  if (node.type === 'udta' || node.type === 'meta' || (node.type === 'uuid' && (depth === 0 || known(node.uuid!)))) {
    return { type: 'free', body: new Uint8Array(write(node).length - (node.size === 'large' ? 16 : 8)), ...(node.size ? { size: node.size } : {}) };
  }
  if ((node.type === 'free' || node.type === 'skip') && empty(node)) return { ...node, body: zero(node.body!, 0) };
  if (['mvhd', 'tkhd', 'mdhd'].includes(node.type)) return { ...node, body: zero(node.body!, 4, node.body![0] === 1 ? 20 : 12) };
  if (node.type === 'pnot') return { ...node, body: zero(node.body!, 0, 4) };
  if (node.type === 'prft') return { ...node, body: zero(node.body!, 8) };
  if (CONTAINERS.includes(node.type) && !node.junk) return { ...node, children: node.children!.map((child) => stripped(child, depth + 1, empty)) };
  return node;
}

/** A random, well-formed movie with metadata in all the places it can be. */
function randomMovie(r: Random): Node[] {
  const leaf = (type: string, length = r.int(24)): Node => ({ type, body: r.bytes(length) });
  const timed = (type: string): Node => {
    const version = r.int(2);
    return { type, body: concat(new Uint8Array([version, 0, 0, 0]), r.bytes(version ? 16 : 8), r.bytes(r.int(20))) };
  };
  const uuid = (): Node => ({ type: 'uuid', uuid: r.oneIn(2) ? r.pick(MAKERS) : r.pick([SPHERICAL, r.bytes(16)]), body: r.bytes(r.int(30)) });
  const metadata = (): Node[] => {
    const out: Node[] = [];
    for (let n = r.int(3); n > 0; n--) {
      const type = r.pick(['udta', 'meta', 'uuid', 'free', 'skip']);
      if (type === 'uuid') out.push(uuid());
      else if (type === 'free' || type === 'skip') out.push(leaf(type, 1 + r.int(30)));
      else out.push({ type, children: [leaf(r.pick(['©xyz', '©day', 'keys', 'ilst']))] });
    }
    return out;
  };
  const mix = (...nodes: Node[]): Node[] => {
    const out = [...nodes];
    for (const extra of metadata()) out.splice(r.int(out.length + 1), 0, extra);
    for (const node of out) if (r.oneIn(8) && !node.offsets) node.size = 'large';
    return out;
  };
  const container = (type: string, ...children: Node[]): Node => {
    const node: Node = { type, children: mix(...children) };
    if (['edts', 'minf', 'stbl'].includes(type) && r.oneIn(10)) node.junk = r.bytes(1 + r.int(7));
    return node;
  };
  const tables: Node[] = [];
  const tracks: Node[] = [];
  for (let n = r.int(3); n > 0; n--) {
    const table: Node = { type: r.pick(['stco', 'co64']), offsets: new Array<number>(r.int(4)).fill(0) };
    tables.push(table);
    const stbl = container('stbl', leaf('stsd'), leaf('stts'), leaf('stsc'), leaf('stsz'), table);
    const minf = container('minf', leaf(r.pick(['vmhd', 'smhd'])), { type: 'dinf', children: [leaf('dref')] }, stbl);
    const mdia = container('mdia', timed('mdhd'), leaf('hdlr'), minf);
    tracks.push(container('trak', timed('tkhd'), ...(r.oneIn(2) ? [container('edts', leaf('elst'))] : []), mdia));
  }
  const top: Node[] = [
    r.oneIn(4) ? { type: 'pnot', body: r.bytes(12) } : leaf('ftyp', 4 + r.int(12)),
    container('moov', timed('mvhd'), ...tracks),
    leaf('mdat', r.int(64)),
  ];
  if (r.oneIn(4)) top.push({ type: 'prft', body: r.bytes(r.pick([20, 24])) }, leaf('moof', 16), leaf('mdat', 32));
  if (r.oneIn(3)) top.splice(1 + r.int(top.length), 0, uuid());
  if (r.oneIn(2)) top.splice(1 + r.int(top.length), 0, ...metadata());
  if (r.oneIn(4)) top.push(leaf(r.pick(['free', 'skip']), r.int(16)));
  if (r.oneIn(4)) top.at(-1)!.size = 'open';
  else if (r.oneIn(8)) top.at(-1)!.size = 'large';
  // The chunks: in mdat mostly, now and then in a free or skip box, or anywhere.
  const where = place(top);
  const unused = [...where.keys()].filter((node) => node.type === 'free' || node.type === 'skip');
  const into = (node: Node) => {
    const [start, end] = where.get(node)!;
    return start + r.int(end - start);
  };
  for (const table of tables) {
    table.offsets = table.offsets!.map(() => (unused.length && r.oneIn(4) ? into(r.pick(unused)) : r.oneIn(3) ? r.int(2 ** 32) : into(top[2]!)));
  }
  return top;
}

/** The boxes at the top level and in the containers, in order, as far as they can be read: [type, start, end]. */
function layout(bytes: Uint8Array, start = 0, end = bytes.length, out: [string, number, number][] = []): [string, number, number][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    const type = types(bytes.subarray(at + 4, at + 8));
    out.push([type, at, at + size]);
    if (CONTAINERS.includes(type)) layout(bytes, at + header, at + size, out);
    at += size;
  }
  return out;
}

describe('stripVideoMetadata, on random input', () => {
  it('strips random well-formed movies exactly as expected', () => {
    const r = new Random(0x6d703401);
    for (let round = 0; round < 300; round++) {
      const top = randomMovie(r);
      const bytes = writeFile(top);
      const expected = strippedFile(top);
      expect(stripVideoMetadata(bytes), `round ${round}`).toBe(true);
      expect(bytes, `round ${round}`).toEqual(expected);
      // Stripping again changes nothing more.
      expect(stripVideoMetadata(bytes)).toBe(true);
      expect(bytes).toEqual(expected);
    }
  });

  it('never throws on random or changed bytes, changes nothing when it refuses, and only what it should otherwise', () => {
    const r = new Random(0x6d703402);
    const CHANGEABLE = ['udta', 'meta', 'uuid', 'free', 'skip', 'mvhd', 'tkhd', 'mdhd', 'pnot', 'prft'];
    for (let round = 0; round < 600; round++) {
      const bytes = r.oneIn(4) ? r.bytes(r.int(200)) : r.mutate(writeFile(randomMovie(r)));
      const before = bytes.slice();
      let ok = false;
      expect(() => (ok = stripVideoMetadata(bytes)), `round ${round}`).not.toThrow();
      if (!ok) {
        expect(bytes, `round ${round}`).toEqual(before);
        continue;
      }
      // Every box is where it was and the same size; only metadata boxes became "free".
      const boxes = layout(before);
      const renamed = boxes.map(([type, start, end]) => [['udta', 'meta', 'uuid'].includes(type) && types(bytes.subarray(start + 4, start + 8)) === 'free' ? 'free' : type, start, end]);
      expect(layout(bytes), `round ${round}`).toEqual(renamed);
      // Every byte changed is in a metadata box, a free or skip box, or a box with times.
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === before[i]) continue;
        const inside = boxes.filter(([, start, end]) => start <= i && i < end).at(-1);
        expect(CHANGEABLE, `round ${round}: byte ${i} in ${inside?.[0]}`).toContain(inside?.[0]);
      }
      const once = bytes.slice();
      expect(stripVideoMetadata(bytes), `round ${round}`).toBe(true);
      expect(bytes, `round ${round}`).toEqual(once);
    }
  });
});
