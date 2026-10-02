// Reads bytes from anywhere in a large file without loading all of it. A Blob is what both Node
// (fs.openAsBlob) and the browser (a File from a file picker) hand us, so this works in both.

const WINDOW_BYTES = 8 * 1024 * 1024;

export class BlobReader {
  readonly size: number;
  private blob: Blob;
  private window = new Uint8Array(0);
  private windowStart = 0;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  // `length` bytes starting at `offset`. Reads go through an 8 MB window, because a demuxer asks
  // for many small pieces that are usually next to each other.
  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.size);
    if (offset < this.windowStart || end > this.windowStart + this.window.length) {
      const windowEnd = Math.min(this.size, Math.max(end, offset + WINDOW_BYTES));
      this.window = new Uint8Array(await this.blob.slice(offset, windowEnd).arrayBuffer());
      this.windowStart = offset;
    }
    return this.window.subarray(offset - this.windowStart, end - this.windowStart);
  }
}

// Unsigned big-endian integer from up to 8 bytes. Numbers above 2^53 are not exact, which no file
// offset or duration we read comes close to.
export function readUint(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
  return value;
}

export function readText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, "");
}
