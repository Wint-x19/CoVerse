import { SessionError, type Artifact } from "@coverse/core";

function requireSnapshot(ok: unknown): asserts ok {
  if (!ok) throw new SessionError("UNSTABLE_INPUT", "/input", "SQLite WAL and index do not identify a verified committed snapshot");
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const pageSize = (encoded: number) => encoded === 1 ? 65536 : encoded;

/** SQLite fileformat2 §4.2. Accumulate unsigned word pairs in the declared checksum byte order. */
function checksum(data: DataView, start: number, length: number, little: boolean, sum: [number, number]) {
  for (let i = start; i < start + length; i += 8) {
    sum[0] = (sum[0] + data.getUint32(i, little) + sum[1]) >>> 0;
    sum[1] = (sum[1] + data.getUint32(i + 4, little) + sum[0]) >>> 0;
  }
}

/** Read the committed view from captured bytes. The native database and its journals remain untouched. */
export function committedSnapshot(db: Uint8Array, wal: Artifact, shm?: Artifact): Uint8Array {
  requireSnapshot(db.length >= 100 && db[18] === 2 && db[19] === 2 && wal.bytes.length >= 32 && shm && shm.bytes.length >= 136);
  const log = view(wal.bytes), index = view(shm.bytes);
  const magic = log.getUint32(0), size = log.getUint32(8);
  const little = magic === 0x377f0682;
  requireSnapshot((little || magic === 0x377f0683) && log.getUint32(4) === 3007000 &&
    size >= 512 && size <= 65536 && (size & (size - 1)) === 0 && size === pageSize(view(db).getUint16(16)) && db.length % size === 0);

  // The two index headers must agree, including their checksum and the WAL salts.
  const nativeLittle = index.getUint32(0, true) === 3007000;
  const word = (offset: number) => index.getUint32(offset, nativeLittle);
  const headerSum: [number, number] = [0, 0];
  checksum(index, 0, 40, nativeLittle, headerSum);
  requireSnapshot(shm.bytes.subarray(0, 48).every((byte, i) => byte === shm.bytes[i + 48]) &&
    word(0) === 3007000 && index.getUint8(12) === 1 && index.getUint8(13) === Number(!little) &&
    pageSize(index.getUint16(14, nativeLittle)) === size && index.getBigUint64(32) === log.getBigUint64(16) &&
    headerSum[0] === word(40) && headerSum[1] === word(44));

  const frames = word(16), pages = word(20), stride = size + 24;
  requireSnapshot(frames > 0 && 32 + frames * stride <= log.byteLength &&
    pages > 0 && pages <= db.length / size + frames);
  const sum: [number, number] = [0, 0];
  checksum(log, 0, 24, little, sum);
  requireSnapshot(sum[0] === log.getUint32(24) && sum[1] === log.getUint32(28));
  const latest = new Map<number, number>();
  for (let frame = 0; frame < frames; frame++) {
    const start = 32 + frame * stride, page = log.getUint32(start);
    requireSnapshot(page > 0 && log.getBigUint64(start + 8) === log.getBigUint64(16));
    checksum(log, start, 8, little, sum);
    checksum(log, start + 24, size, little, sum);
    requireSnapshot(sum[0] === log.getUint32(start + 16) && sum[1] === log.getUint32(start + 20));
    latest.set(page, start + 24);
  }
  requireSnapshot(log.getUint32(32 + (frames - 1) * stride + 4) === pages && sum[0] === word(24) && sum[1] === word(28));
  const bytes = new Uint8Array(pages * size);
  bytes.set(db.subarray(0, bytes.length));
  for (const [page, offset] of latest) {
    if (page <= pages) bytes.set(wal.bytes.subarray(offset, offset + size), (page - 1) * size);
  }
  return bytes;
}
