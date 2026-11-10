import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A user's own secrets, exposed to their Runs as environment variables. Values are encrypted at rest with a key
// kept beside the database, so a copied database file alone does not reveal them.
export class CredentialService {
  private key: Buffer | null = null;

  constructor(
    private readonly db: Database,
    private readonly keyFile: string,
    private readonly now: () => number = Date.now,
  ) {}

  set(userId: number, name: string, value: string): Result<void> {
    if (!NAME.test(name))
      return err({ code: 'INVALID_INPUT', field: 'name', message: 'Name must be an environment variable name' });
    if (value === '') return err({ code: 'INVALID_INPUT', field: 'value', message: 'Value is required' });
    this.db
      .prepare(
        `INSERT INTO user_credentials (user_id, name, value_enc, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      )
      .run(userId, name, this.encrypt(value), this.now());
    return ok(undefined);
  }

  remove(userId: number, name: string): void {
    this.db.prepare('DELETE FROM user_credentials WHERE user_id = ? AND name = ?').run(userId, name);
  }

  // Names only: stored values are never shown again.
  names(userId: number): { name: string; updatedAt: number }[] {
    return (
      this.db.prepare('SELECT name, updated_at FROM user_credentials WHERE user_id = ? ORDER BY name').all(userId) as {
        name: string;
        updated_at: number;
      }[]
    ).map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  env(userId: number | null): Record<string, string> {
    if (userId === null) return {};
    const rows = this.db.prepare('SELECT name, value_enc FROM user_credentials WHERE user_id = ?').all(userId) as {
      name: string;
      value_enc: string;
    }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = this.decrypt(r.value_enc);
    return out;
  }

  private loadKey(): Buffer {
    if (this.key !== null) return this.key;
    if (!fs.existsSync(this.keyFile)) {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    this.key = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'hex');
    return this.key;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(), iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }

  private decrypt(stored: string): string {
    const [iv, tag, body] = stored.split('.').map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', this.loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}
