// Removes where and when a video was recorded, before it's sent "as video"
// (photos are redrawn instead, which drops their metadata). Phones keep the
// location in MP4/QuickTime metadata boxes: moov/udta ("©xyz", Android and
// others) and moov/meta ("com.apple.quicktime.location.ISO6709", iPhone),
// next to the make, model and software; QuickTime allows them deeper too,
// in a track's media information. Editing apps add XMP in a "uuid" box,
// and some cameras their own "uuid" boxes. The recording time is also in
// the movie, track and media headers (mvhd, tkhd, mdhd), a QuickTime
// preview's date (pnot) and a fragmented file's wall-clock times (prft).
//
// Metadata boxes become "free" boxes full of zeros and the times are
// zeroed, all in place: the file keeps its exact length, so every offset in
// it (the sample tables' chunk offsets, stco and co64) stays right, and
// players skip "free" boxes. "As file" sends the original bytes, as
// Telegram does. Timed metadata tracks (a camera's GPS track, its samples
// in mdat) are kept.

/** How an MP4 (ftyp) or an older QuickTime file starts. */
const FIRST = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot']);
/** The "uuid" box type Adobe's XMP metadata uses. */
const XMP = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
/** Boxes to look inside: the movie, its tracks, their media, edit lists, media information and sample tables. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'edts', 'minf', 'stbl']);
/**
 * Of those, the ones that rarely hold metadata: if their contents don't
 * add up, they're left as they are, rather than the whole file being taken
 * as unreadable (and sent with all its metadata).
 */
const LENIENT = new Set(['edts', 'minf', 'stbl']);
/** Metadata boxes, dropped wherever they are on the way. */
const METADATA = new Set(['udta', 'meta']);
/** Headers with a creation and modification time. */
const HEADERS = new Set(['mvhd', 'tkhd', 'mdhd']);

/**
 * How deep boxes may nest, and how many a file may have, before it's taken
 * as unreadable. The deepest box walked in a recording is 5 down
 * (moov/trak/mdia/minf/stbl/stco). A plain recording has about 50 boxes on
 * the levels walked. A fragmented one has 2 more (moof, mdat) per
 * fragment, usually one every second or two; even one for every frame and
 * audio packet, as some streaming tools write, is about 150 boxes a second,
 * and a fragment takes over 100 bytes, so 50 MB holds fewer than a million.
 * Reading a million takes a fraction of a second.
 */
export const MAX_DEPTH = 16;
export const MAX_BOXES = 1_000_000;

const FREE = [0x66, 0x72, 0x65, 0x65]; // "free"

class Unreadable extends Error {}
/** Nested too deep or too many boxes: never left alone as a LENIENT box's contents are. */
class TooComplex extends Unreadable {}

/**
 * Strips location, device and time metadata from an MP4 or QuickTime file,
 * in place. Returns false (and changes nothing) if the bytes aren't one.
 */
export function stripVideoMetadata(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const skip = new Set<number>();
  try {
    // A dry run first: anything unreadable shows before a byte is changed.
    if (!walk({ bytes, view, change: false, count: 0, skip })) return false;
  } catch (err) {
    if (err instanceof Unreadable) return false;
    throw err;
  }
  // The same walk again, changing the bytes. It reads only box headers,
  // versions and UUIDs, which no change touches before they're read (a box
  // is changed after its header is read, and never looked inside after).
  walk({ bytes, view, change: true, count: 0, skip });
  return true;
}

interface Walk {
  bytes: Uint8Array;
  view: DataView;
  /** False on the dry run, which changes nothing. */
  change: boolean;
  /** Boxes read so far. */
  count: number;
  /** Where the LENIENT boxes whose contents didn't add up start, found on the dry run: left as they are. */
  skip: Set<number>;
}

interface Box {
  type: string;
  /** Where the box starts, where its contents start, and where it ends. */
  start: number;
  body: number;
  end: number;
}

/** Walks the whole file; false if it isn't a movie (no moov, or an unknown first box). */
function walk(w: Walk): boolean {
  let first = true;
  let movie = false;
  children(w, 0, w.bytes.length, 0, (box) => {
    if (first && !FIRST.has(box.type)) throw new Unreadable();
    first = false;
    if (box.type === 'moov') movie = true;
    visit(w, box, 0);
  });
  return movie;
}

function visit(w: Walk, box: Box, depth: number): void {
  const { bytes } = w;
  // No top-level "uuid" box is needed to play a file: the ones players read
  // (encryption, streaming, 360° video) sit inside moov, trak or moof.
  // Inside, only XMP is known to be metadata; others are kept.
  if (METADATA.has(box.type) || (box.type === 'uuid' && (depth === 0 || isXmp(bytes, box)))) {
    if (w.change) {
      bytes.set(FREE, box.start + 4);
      bytes.fill(0, box.body, box.end);
    }
  } else if (HEADERS.has(box.type)) {
    // version (1) and flags (3), then creation and modification times: 4 bytes each, or 8 in version 1.
    const length = bytes[box.body] === 1 ? 16 : 8;
    if (box.body + 4 + length > box.end) throw new Unreadable();
    if (w.change) bytes.fill(0, box.body + 4, box.body + 4 + length);
  } else if (box.type === 'pnot') {
    // The preview's modification date (4 bytes), then which box the preview is.
    if (w.change) bytes.fill(0, box.body, Math.min(box.body + 4, box.end));
  } else if (box.type === 'prft') {
    // version and flags (4), the track (4), then the wall-clock (NTP) time and the media time it matches.
    if (w.change) bytes.fill(0, Math.min(box.body + 8, box.end), box.end);
  } else if (CONTAINERS.has(box.type) && !w.skip.has(box.start)) {
    try {
      children(w, box.body, box.end, depth + 1, (child) => visit(w, child, depth + 1));
    } catch (err) {
      if (!LENIENT.has(box.type) || !(err instanceof Unreadable) || err instanceof TooComplex) throw err;
      w.skip.add(box.start);
    }
  }
}

function isXmp(bytes: Uint8Array, box: Box): boolean {
  return box.body + 16 <= box.end && XMP.every((b, i) => bytes[box.body + i] === b);
}

/** Calls each for the boxes between start and end, in order; throws Unreadable if they don't add up. */
function children(w: Walk, start: number, end: number, depth: number, each: (box: Box) => void): void {
  if (depth > MAX_DEPTH) throw new TooComplex();
  const { bytes, view } = w;
  let at = start;
  while (at < end) {
    if (++w.count > MAX_BOXES) throw new TooComplex();
    if (at + 8 > end) throw new Unreadable();
    let size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    let header = 8;
    if (size === 1) {
      // A 64-bit size follows the type.
      if (at + 16 > end) throw new Unreadable();
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      // To the end of the file, or of the box it's in (only the last one).
      size = end - at;
    }
    if (size < header || at + size > end) throw new Unreadable();
    each({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
}
