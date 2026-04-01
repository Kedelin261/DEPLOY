// DEPLOY Platform — TOTP Two-Factor Authentication Service
// Pure Web Crypto API implementation — no external libraries needed.
// Compatible with Google Authenticator, Authy, 1Password, etc.

export class TOTPService {
  private static readonly DIGITS = 6;
  private static readonly PERIOD = 30; // seconds
  private static readonly ALGORITHM = 'SHA-1';
  private static readonly BACKUP_CODE_COUNT = 8;
  private static readonly BACKUP_CODE_LENGTH = 10;

  // ── Generate a new TOTP secret (base32-encoded) ───────────────────────────
  static async generateSecret(): Promise<string> {
    const bytes = new Uint8Array(20); // 160-bit secret
    crypto.getRandomValues(bytes);
    return this.base32Encode(bytes);
  }

  // ── Generate QR URI for authenticator apps ────────────────────────────────
  static getOtpAuthURI(opts: {
    secret: string;
    email: string;
    issuer?: string;
  }): string {
    const issuer = encodeURIComponent(opts.issuer || 'DEPLOY Platform');
    const account = encodeURIComponent(opts.email);
    const secret = opts.secret.replace(/\s/g, '').toUpperCase();
    return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${this.DIGITS}&period=${this.PERIOD}`;
  }

  // ── Generate QR code data URL (SVG-based, no external lib) ──────────────
  // Returns the otpauth URI — frontend uses a QR library or API
  static getQRDataURL(otpAuthURI: string): string {
    // Return the URI for use with a QR code API
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpAuthURI)}`;
  }

  // ── Verify a TOTP token ────────────────────────────────────────────────────
  // Accepts ±1 window (30s grace period) to handle clock skew
  static async verify(token: string, secret: string): Promise<boolean> {
    if (!token || !secret) return false;
    const cleaned = token.replace(/\s/g, '');
    if (!/^\d{6}$/.test(cleaned)) return false;

    const now = Math.floor(Date.now() / 1000);
    const counter = Math.floor(now / this.PERIOD);

    // Check current window and ±1 window
    for (const drift of [-1, 0, 1]) {
      const expected = await this.generateTOTP(secret, counter + drift);
      if (expected === cleaned) return true;
    }
    return false;
  }

  // ── Generate 8 alphanumeric backup codes ──────────────────────────────────
  static generateBackupCodes(): string[] {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
    const codes: string[] = [];
    for (let i = 0; i < this.BACKUP_CODE_COUNT; i++) {
      const bytes = new Uint8Array(this.BACKUP_CODE_LENGTH);
      crypto.getRandomValues(bytes);
      codes.push(
        Array.from(bytes)
          .map(b => chars[b % chars.length])
          .join('')
          .replace(/(.{5})/g, '$1-')
          .slice(0, 11) // "XXXXX-XXXXX" format
      );
    }
    return codes;
  }

  // ── Hash a backup code for storage (SHA-256) ──────────────────────────────
  static async hashBackupCode(code: string): Promise<string> {
    const normalized = code.replace(/-/g, '').toUpperCase();
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(normalized)
    );
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ── Verify and consume a backup code ─────────────────────────────────────
  // Returns the remaining codes array or null if code not found
  static async verifyBackupCode(
    inputCode: string,
    hashedCodes: string[]
  ): Promise<string[] | null> {
    const inputHash = await this.hashBackupCode(inputCode);
    const idx = hashedCodes.findIndex(h => h === inputHash);
    if (idx === -1) return null;
    // Remove used code
    const remaining = [...hashedCodes];
    remaining.splice(idx, 1);
    return remaining;
  }

  // ── Internal: generate TOTP value for a counter ───────────────────────────
  private static async generateTOTP(secret: string, counter: number): Promise<string> {
    const keyBytes = this.base32Decode(secret);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes,
      { name: 'HMAC', hash: this.ALGORITHM },
      false, ['sign']
    );

    // Counter as big-endian 8-byte buffer
    const counterBuf = new ArrayBuffer(8);
    const counterView = new DataView(counterBuf);
    counterView.setUint32(4, counter & 0xffffffff, false);

    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));

    // Dynamic truncation
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % (10 ** this.DIGITS);

    return code.toString().padStart(this.DIGITS, '0');
  }

  // ── Base32 encode (RFC 4648) ──────────────────────────────────────────────
  private static base32Encode(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let buffer = 0;
    let bitsLeft = 0;

    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bitsLeft += 8;
      while (bitsLeft >= 5) {
        result += alphabet[(buffer >> (bitsLeft - 5)) & 31];
        bitsLeft -= 5;
      }
    }
    if (bitsLeft > 0) {
      result += alphabet[(buffer << (5 - bitsLeft)) & 31];
    }
    return result;
  }

  // ── Base32 decode ─────────────────────────────────────────────────────────
  private static base32Decode(encoded: string): Uint8Array {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = encoded.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
    const bytes: number[] = [];
    let buffer = 0;
    let bitsLeft = 0;

    for (const char of cleaned) {
      const val = alphabet.indexOf(char);
      if (val < 0) continue;
      buffer = (buffer << 5) | val;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        bytes.push((buffer >> (bitsLeft - 8)) & 255);
        bitsLeft -= 8;
      }
    }
    return new Uint8Array(bytes);
  }
}
