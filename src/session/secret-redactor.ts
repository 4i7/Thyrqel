/** Suppresses exact secret echoes, including matches split across PTY chunks.
 * This cannot protect secrets from the program receiving them or transformed output.
 */
export class SecretRedactor {
  private secrets: string[] = [];
  private pending = '';
  add(secret: string) {
    if (!secret.length || secret.length > 1024 || /[\x00-\x1f\x7f]/.test(secret)) {
      throw new Error('Secret must contain 1–1024 characters without control characters');
    }
    if (this.secrets.includes(secret)) return;
    if (this.secrets.length >= 8) throw new Error('Secret limit reached; open a new session');
    this.secrets.push(secret);
    this.secrets.sort((a, b) => b.length - a.length);
  }
  accept(chunk: string) {
    if (!this.secrets.length) return chunk;
    this.pending += chunk;
    let output = '';
    while (this.pending.length) {
      if (this.secrets.some(secret => secret.length > this.pending.length && secret.startsWith(this.pending))) break;
      const match = this.secrets.find(secret => this.pending.startsWith(secret));
      if (match) {
        output += '[REDACTED]';
        this.pending = this.pending.slice(match.length);
      } else if (this.secrets.some(secret => secret.startsWith(this.pending))) {
        break;
      } else {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    return output;
  }
  finish() {
    const output = this.pending ? '[REDACTED]' : '';
    this.pending = '';
    this.secrets = [];
    return output;
  }
}
