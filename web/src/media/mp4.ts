// Removes where and when a video was recorded, before it's sent "as video"
// (photos are redrawn instead, which drops their metadata), and from voice
// and video messages recorded as MP4 (media/record.ts). Phones keep the
// location in MP4/QuickTime metadata boxes: moov/udta ("©xyz", Android and
// others) and moov/meta ("com.apple.quicktime.location.ISO6709", iPhone),
// next to the make, model and software; QuickTime allows them deeper too,
// in a track's media information. Editing apps add XMP in a "uuid" box,
// and some cameras their own "uuid" boxes, in the movie or a track (Sony's
// dates, Canon's GPS, serial number and dates, Garmin's GPS). Some cameras
// also leave data in "free" or "skip" boxes, which players ignore. The
// recording time is also in the movie, track and media headers (mvhd,
// tkhd, mdhd), a QuickTime preview's date (pnot) and a fragmented file's
// wall-clock times (prft). And whatever wrote the file names itself in
// each track's handler ("Core Media Video" on an iPhone, "VideoHandler"
// in Chrome) and in a video track's encoder name ("HEVC", "AVC1 Coding"):
// hints at the device, the same in every chat.
//
// Metadata boxes become "free" boxes full of zeros, free and skip boxes are
// emptied the same way, and the times and the handler and encoder names
// are zeroed, all in place: the file keeps its exact length, so every
// offset in it (the sample tables' chunk offsets, stco and co64) stays
// right, and players skip "free" boxes. "As file" sends the original
// bytes, as Telegram does. Still kept: timed metadata tracks (a camera's
// GPS track, a timecode track; their samples are in mdat), "uuid" boxes
// inside the movie that aren't known metadata, the file's brands (ftyp)
// and the encoder's settings.

/** How an MP4 (ftyp) or an older QuickTime file starts. */
const FIRST = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot']);
/**
 * "uuid" box types known to hold only metadata, dropped wherever they are on
 * the way (as ExifTool reads them): Adobe's XMP; Sony's (USMT, in the movie
 * or a track: dates, time zone, software, model); Canon's (in the movie:
 * make, model, dates, serial number, GPS); Garmin's GPS (in the movie).
 */
const METADATA_UUIDS = [
  [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac],
  [0x55, 0x53, 0x4d, 0x54, 0x21, 0xd2, 0x4f, 0xce, 0xbb, 0x88, 0x69, 0x5c, 0xfa, 0xc9, 0xc7, 0x40],
  [0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48],
  [0x9b, 0x63, 0x0f, 0x8d, 0x63, 0x74, 0x40, 0xec, 0x82, 0x04, 0xbc, 0x5f, 0xf5, 0x09, 0x17, 0x28],
];
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
/** Boxes players skip by definition: their contents are zeroed (see toEmpty). */
const UNUSED = new Set(['free', 'skip']);
/** Chunk offset tables, 32-bit and 64-bit: where each chunk of samples is. */
const CHUNKS = new Set(['stco', 'co64']);
/** Kinds of track (handler types) whose sample descriptions are pictures, each naming its encoder: video, and auxiliary video (depth, alpha). */
const VISUAL = new Set(['vide', 'auxv']);
/**
 * Where a handler's name starts in its box: after version and flags (4), a
 * QuickTime component type (4), the handler type (4) and 12 reserved bytes.
 */
const HANDLER_NAME = 24;
/**
 * Where a visual sample entry's encoder name is in it: after the box header
 * (8), 6 reserved bytes and a data reference index (2), 16 bytes of codec
 * fields, width and height (4), resolutions (8), 4 reserved bytes and a
 * frame count (2). A Pascal string in 32 bytes.
 */
const ENCODER_NAME = 50;
const ENCODER_NAME_LENGTH = 32;

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
  const dry: Walk = { bytes, view, change: false, count: 0, unread: new Set(), unused: [], chunks: [], fragmented: false, empty: null };
  try {
    // A dry run first: anything unreadable shows before a byte is changed.
    if (!walk(dry)) return false;
  } catch (err) {
    if (err instanceof Unreadable) return false;
    throw err;
  }
  // The same walk again, changing the bytes. It reads only box headers,
  // versions, UUIDs, handler types and sample entries' sizes, which no
  // change touches before they're read (a box is changed after its header
  // is read, and never looked inside after; a handler's name comes after
  // its type, an encoder's name after its entry's size).
  walk({ ...dry, change: true, count: 0, empty: toEmpty(dry) });
  return true;
}

interface Walk {
  bytes: Uint8Array;
  view: DataView;
  /** False on the dry run, which changes nothing. */
  change: boolean;
  /** Boxes read so far. */
  count: number;
  /** Found on the dry run: where the LENIENT boxes whose contents didn't add up start. They're left as they are. */
  unread: Set<number>;
  /** Found on the dry run: where the free and skip boxes start and end, in order (start, end, start, end...). */
  unused: number[];
  /** Found on the dry run: the chunk offset tables. */
  chunks: Box[];
  /** Found on the dry run: whether the file has fragments (moof). */
  fragmented: boolean;
  /** For the second run: the free and skip boxes to empty, by where they start (see toEmpty). */
  empty: Set<number> | null;
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
    if (box.type === 'moof') w.fragmented = true;
    visit(w, box, 0, '');
  });
  return movie;
}

/** `handler`: the kind of track the box is in (its handler type, "vide", "soun"...), or '' outside one. */
function visit(w: Walk, box: Box, depth: number, handler: string): void {
  const { bytes } = w;
  // No top-level "uuid" box is needed to play a file: the ones players read
  // (encryption, streaming, 360° video) sit inside moov, trak or moof.
  // Inside, only known metadata ones go; others are kept.
  if (METADATA.has(box.type) || (box.type === 'uuid' && (depth === 0 || isMetadataUuid(bytes, box)))) {
    if (w.change) {
      bytes.set(FREE, box.start + 4);
      bytes.fill(0, box.body, box.end);
    }
  } else if (UNUSED.has(box.type)) {
    if (!w.change) w.unused.push(box.start, box.end);
    else if (w.empty?.has(box.start)) bytes.fill(0, box.body, box.end);
  } else if (CHUNKS.has(box.type)) {
    if (!w.change) w.chunks.push(box);
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
  } else if (box.type === 'hdlr') {
    // Its name, a null-terminated string in MP4 and a counted one in
    // QuickTime: all zeros reads as no name in both.
    if (w.change && box.body + HANDLER_NAME < box.end) bytes.fill(0, box.body + HANDLER_NAME, box.end);
  } else if (box.type === 'stsd') {
    if (w.change && VISUAL.has(handler)) blankEncoderNames(w, box);
  } else if (CONTAINERS.has(box.type) && !w.unread.has(box.start)) {
    const inside = box.type === 'mdia' ? handlerOf(w, box, depth) : handler;
    try {
      children(w, box.body, box.end, depth + 1, (child) => visit(w, child, depth + 1, inside));
    } catch (err) {
      if (!LENIENT.has(box.type) || !(err instanceof Unreadable) || err instanceof TooComplex) throw err;
      w.unread.add(box.start);
    }
  }
}

/** A track's kind: the handler type of the hdlr box among its media's boxes, or '' if there's none. */
function handlerOf(w: Walk, mdia: Box, depth: number): string {
  let handler = '';
  children(w, mdia.body, mdia.end, depth + 1, (box) => {
    if (!handler && box.type === 'hdlr' && box.body + 12 <= box.end) handler = String.fromCharCode(...w.bytes.subarray(box.body + 8, box.body + 12));
  });
  return handler;
}

/**
 * Zeroes the encoder name in each of a video track's sample descriptions
 * (stsd: version and flags, the number of entries, then the entries). An
 * entry too short to have one is left as it is, and so is the rest from an
 * entry that doesn't fit.
 */
function blankEncoderNames(w: Walk, stsd: Box): void {
  const { bytes, view } = w;
  if (stsd.body + 8 > stsd.end) return;
  let at = stsd.body + 8;
  for (let n = view.getUint32(stsd.body + 4); n > 0 && at + 8 <= stsd.end; n--) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > stsd.end) return;
    if (ENCODER_NAME + ENCODER_NAME_LENGTH <= size) bytes.fill(0, at + ENCODER_NAME, at + ENCODER_NAME + ENCODER_NAME_LENGTH);
    at += size;
  }
}

function isMetadataUuid(bytes: Uint8Array, box: Box): boolean {
  return box.body + 16 <= box.end && METADATA_UUIDS.some((uuid) => uuid.every((b, i) => bytes[box.body + i] === b));
}

/**
 * The free and skip boxes to empty, by where they start: all of them,
 * except any a chunk offset points into (no muxer puts samples there, but
 * if one did, they'd stay playable). None when where the samples are isn't
 * known: an edit list, media information or sample table that couldn't be
 * read, or a fragmented file, whose
 * samples are found from each fragment's moof, which isn't read here.
 */
function toEmpty(w: Walk): Set<number> | null {
  const { view, unused } = w;
  const empty = new Set<number>();
  if (w.fragmented || w.unread.size > 0) return null;
  for (let i = 0; i < unused.length; i += 2) empty.add(unused[i]!);
  if (!empty.size) return empty;
  for (const table of w.chunks) {
    // version and flags (4), the number of chunks (4), then each chunk's offset.
    const step = table.type === 'co64' ? 8 : 4;
    if (table.body + 8 > table.end) return null;
    const count = view.getUint32(table.body + 4);
    if (count > (table.end - table.body - 8) / step) return null;
    for (let at = table.body + 8, n = 0; n < count; n++, at += step) {
      const offset = step === 8 ? view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4) : view.getUint32(at);
      // The last box starting at or before the offset (unused is in order).
      let lo = 0;
      let hi = unused.length / 2;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (unused[mid * 2]! <= offset) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && offset < unused[lo * 2 - 1]!) empty.delete(unused[lo * 2 - 2]!);
    }
  }
  return empty;
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
