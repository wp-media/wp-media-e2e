import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/**
 * For the report bundle's specs: a `.tar.gz` listed by reading its headers, not by asking a `tar`.
 * macOS's bsdtar hides the AppleDouble (`._*`) entries and extended attributes it wrote when it lists
 * its own archive, which GNU tar then unpacks as files or warns about; only the raw headers show
 * every entry. Reads ustar (with its name prefix), pax (`x`) and GNU long-name (`L`) headers.
 */

/** One entry of an archive, as its headers say. */
export interface TarEntry {
  /** Its path, as stored (`<name>/index.html`; a folder ends with `/`). */
  readonly path: string;
  /** Its type flag: `0` a file, `5` a folder, `2` a link, … */
  readonly type: string;
  /** Its permission bits. */
  readonly mode: number;
  /** The keys of the pax records that came with it (`path`, `LIBARCHIVE.xattr.…`). */
  readonly paxKeys: readonly string[];
}

/** A tar block's size. */
const BLOCK = 512;

/**
 * A header field as text: up to its first NUL.
 *
 * @param block - the header.
 * @param start - the field's offset.
 * @param length - its length.
 */
function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/**
 * A header's octal number field.
 *
 * @param block - the header.
 * @param start - the field's offset.
 * @param length - its length.
 */
function octal(block: Buffer, start: number, length: number): number {
  const text = field(block, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/**
 * The records of a pax header's data: `<length> <key>=<value>\n`, one after the other.
 *
 * @param data - the data.
 */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.toString("utf8", offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/**
 * Every entry of a `.tar.gz`, in archive order; pax and long-name headers fold into the entry they
 * describe.
 *
 * @param path - the archive.
 */
export function listTarGz(path: string): TarEntry[] {
  const tar = gunzipSync(readFileSync(path));
  const entries: TarEntry[] = [];
  let pax = new Map<string, string>();
  let longName: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    const type = field(block, 156, 1) || "0";
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    entries.push({
      path:
        pax.get("path") ??
        longName ??
        (prefix === "" ? name : `${prefix}/${name}`),
      type,
      mode: octal(block, 100, 8) & 0o7777,
      paxKeys: [...pax.keys()],
    });
    pax = new Map();
    longName = undefined;
  }
  return entries;
}
