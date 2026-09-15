// Buffer stores UTF-8 bytes. Eviction advances to a code point boundary.
export class OutputRing {
  private buffer = Buffer.alloc(0);
  private dropped = 0;
  private pendingHighSurrogate = '';
  constructor(readonly capacity = 1024 * 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 4) throw new RangeError('ring capacity must be >= 4');
  }
  append(text: string): void {
    text = this.pendingHighSurrogate + text;
    this.pendingHighSurrogate = '';
    if (/[\uD800-\uDBFF]$/.test(text)) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    const incoming = Buffer.from(text, 'utf8');
    const joined = Buffer.concat([this.buffer, incoming]);
    let cut = Math.max(0, joined.length - this.capacity);
    while (cut < joined.length && (joined[cut]! & 0xc0) === 0x80) cut++;
    this.dropped += cut;
    this.buffer = Buffer.from(joined.subarray(cut));
  }
  finish(): void {
    if (this.pendingHighSurrogate) {
      this.pendingHighSurrogate = '';
      this.append('\uFFFD');
    }
  }
  read() {
    const result = { output: this.buffer.toString('utf8'), truncated: this.dropped > 0, dropped_bytes: this.dropped };
    this.buffer = Buffer.alloc(0);
    this.dropped = 0;
    return result;
  }
}
