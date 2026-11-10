import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';

export interface User {
  id: number;
  username: string;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BOOTSTRAP_USERNAME = 'admin';
const BOOTSTRAP_PASSWORD = 'admin';

type Row = Record<string, unknown>;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'hex');
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), expected.length), expected);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Local accounts. Only a hash of each session token is stored, so a leaked database cannot be replayed as sessions.
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // Every installation is authenticated: an empty installation gets `admin`:`admin` so the owner is never locked out.
  ensureBootstrapAdmin(): void {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (n === 0) this.create(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  }

  create(username: string, password: string): Result<User> {
    const name = username.trim();
    if (name === '' || password === '')
      return err({ code: 'INVALID_INPUT', field: 'username', message: 'Username and password are required' });
    try {
      const info = this.db
        .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(name, hashPassword(password), this.now());
      return ok({ id: Number(info.lastInsertRowid), username: name });
    } catch {
      return err({ code: 'INVALID_INPUT', field: 'username', message: `User "${name}" already exists` });
    }
  }

  list(): (User & { disabled: boolean })[] {
    return (this.db.prepare('SELECT id, username, disabled FROM users ORDER BY username').all() as Row[]).map((r) => ({
      id: r.id as number,
      username: r.username as string,
      disabled: r.disabled === 1,
    }));
  }

  setDisabled(userId: number, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
    if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // A wrong username and a wrong password are indistinguishable, in the result and in timing.
  signIn(username: string, password: string): { user: User; token: string; expiresAt: number } | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, disabled FROM users WHERE username = ?')
      .get(username.trim()) as Row | undefined;
    const valid = verifyPassword(password, (row?.password_hash as string | undefined) ?? hashPassword('x'));
    if (row === undefined || !valid || row.disabled === 1) return null;
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), row.id, now, expiresAt);
    return { user: { id: row.id as number, username: row.username as string }, token, expiresAt };
  }

  // Expired sessions are deleted when met; sessions of disabled users never validate.
  userForSession(token: string | undefined): User | null {
    if (token === undefined || token === '') return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.disabled, s.expires_at FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as Row | undefined;
    if (row === undefined) return null;
    if ((row.expires_at as number) <= this.now()) {
      this.signOut(token);
      return null;
    }
    if (row.disabled === 1) return null;
    return { id: row.id as number, username: row.username as string };
  }

  signOut(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
}
