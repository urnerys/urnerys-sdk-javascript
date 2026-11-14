import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

interface Entry {
  file: string;
  name: Buffer;
  size: number;
  crc: number;
  offset: number;
}

export interface Zip {
  /**
   * Number of files in the archive.
   */
  files: number;

  /**
   * Size of the archive in bytes.
   */
  size: number;

  /**
   * Produces the archive. Throws if a file changes size after `createZip` has read it.
   */
  stream(): AsyncGenerator<Buffer>;
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

const VERSION = 20;
const FLAG_UTF8 = 0x800;

/*
 * 1980-01-01, the earliest date a zip archive can hold. A fixed date keeps archives of the same files identical.
 */
const DOS_DATE = (1 << 5) | 1;

/*
 * Entries are stored, not compressed, since most of a Playwright report is images, videos, and traces that are already
 * compressed. The CRC goes into the local header, so every file is read twice: once here and once while streaming.
 * That keeps the archive free of data descriptors, which some readers don't support for stored entries.
 *
 * There is no Zip64 support: archives must stay below 4 GiB and 65,535 files.
 */
export async function createZip(directory: string): Promise<Zip> {
  const entries: Entry[] = [];
  let offset = 0;

  for (const file of await listFiles(directory)) {
    const name = Buffer.from(path.relative(directory, file).split(path.sep).join("/"), "utf8");
    const { size, crc } = await checksum(file);

    entries.push({ file, name, size, crc, offset });
    offset += LOCAL_HEADER_SIZE + name.length + size;
  }

  const centralDirectorySize = entries.reduce((sum, { name }) => sum + CENTRAL_HEADER_SIZE + name.length, 0);

  return {
    files: entries.length,
    size: offset + centralDirectorySize + END_OF_CENTRAL_DIRECTORY_SIZE,
    stream: () => streamZip(entries, offset, centralDirectorySize),
  };
}

async function* streamZip(entries: Entry[], centralDirectoryOffset: number, centralDirectorySize: number) {
  for (const entry of entries) {
    yield localHeader(entry);

    let size = 0;
    for await (const chunk of fs.createReadStream(entry.file)) {
      size += chunk.length;
      yield chunk as Buffer;
    }

    if (size !== entry.size) {
      throw new Error(`${entry.file} changed while it was being archived`);
    }
  }

  for (const entry of entries) {
    yield centralHeader(entry);
  }

  const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  yield end;
}

function localHeader({ name, size, crc }: Entry): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(FLAG_UTF8, 6);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function centralHeader({ name, size, crc, offset }: Entry): Buffer {
  const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/*
 * Only regular files are listed. Symbolic links are skipped, since the server rejects archives that contain them.
 */
async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  for (const dirent of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await listFiles(file)));
    } else if (dirent.isFile()) {
      files.push(file);
    }
  }

  return files;
}

async function checksum(file: string): Promise<{ size: number; crc: number }> {
  let size = 0;
  let crc = 0;

  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    crc = zlib.crc32(chunk as Buffer, crc);
  }

  return { size, crc };
}
