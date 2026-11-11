import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { SESSION_TTL_MS, UserService } from './userService';

let handle: ReturnType<typeof tempDb>;
let now: number;
let users: UserService;

beforeEach(() => {
  handle = tempDb();
  now = Date.parse('2026-10-21T10:00:00');
  users = new UserService(handle.db, () => now);
});
afterEach(() => handle.cleanup());

describe('bootstrap', () => {
  test('seeds admin:admin only on an empty installation', () => {
    users.ensureBootstrapAdmin();
    expect(users.signIn('admin', 'admin')?.user.username).toBe('admin');

    users.ensureBootstrapAdmin();
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  test('does not recreate admin once other users exist', () => {
    users.create('alice', 'pw');
    users.ensureBootstrapAdmin();
    expect(users.signIn('admin', 'admin')).toBeNull();
  });
});

describe('sign-in', () => {
  beforeEach(() => {
    users.create('alice', 'secret');
  });

  test('accepts the password, ignoring username case, and rejects anything else', () => {
    expect(users.signIn('ALICE', 'secret')).not.toBeNull();
    expect(users.signIn('alice', 'wrong')).toBeNull();
    expect(users.signIn('nobody', 'secret')).toBeNull();
  });

  test('userForPassword checks the password without opening a session', () => {
    expect(users.userForPassword('alice', 'secret')?.username).toBe('alice');
    expect(users.userForPassword('alice', 'wrong')).toBeNull();
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  test('does not store the password or the session token in clear text', () => {
    const session = users.signIn('alice', 'secret')!;
    const stored = JSON.stringify([
      handle.db.prepare('SELECT * FROM users').all(),
      handle.db.prepare('SELECT * FROM sessions').all(),
    ]);
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain(session.token);
  });

  test('rejects a duplicate username', () => {
    expect(users.create('Alice', 'other')).toMatchObject({ ok: false });
  });
});

describe('sessions', () => {
  test('a valid token resolves to its user and sign-out invalidates it', () => {
    users.create('alice', 'secret');
    const { token } = users.signIn('alice', 'secret')!;
    expect(users.userForSession(token)).toMatchObject({ username: 'alice' });

    users.signOut(token);
    expect(users.userForSession(token)).toBeNull();
  });

  test('unknown, empty and missing tokens are invalid', () => {
    expect(users.userForSession('nope')).toBeNull();
    expect(users.userForSession('')).toBeNull();
    expect(users.userForSession(undefined)).toBeNull();
  });

  test('a session expires and is removed', () => {
    users.create('alice', 'secret');
    const { token } = users.signIn('alice', 'secret')!;
    now += SESSION_TTL_MS - 1;
    expect(users.userForSession(token)).not.toBeNull();

    now += 1;
    expect(users.userForSession(token)).toBeNull();
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  test('disabling a user ends their sessions and blocks sign-in', () => {
    const created = users.create('alice', 'secret');
    if (!created.ok) throw new Error('create failed');
    const { token } = users.signIn('alice', 'secret')!;

    users.setDisabled(created.value.id, true);

    expect(users.userForSession(token)).toBeNull();
    expect(users.signIn('alice', 'secret')).toBeNull();
  });
});

describe('access tokens', () => {
  function alice() {
    const created = users.create('alice', 'secret');
    if (!created.ok) throw new Error('create failed');
    return created.value.id;
  }
  function issue(userId: number, expiresAt: number | null = null) {
    const r = users.createToken(userId, 'cli', expiresAt);
    if (!r.ok) throw new Error('token failed');
    return r.value;
  }

  test('authenticates the owner, stores only a hash and records use', () => {
    const id = alice();
    const { token } = issue(id);

    expect(users.userForToken(token)).toEqual({ id, username: 'alice' });
    expect(users.userForToken('atk_wrong')).toBeNull();
    expect(users.userForToken(undefined)).toBeNull();
    expect(handle.db.prepare('SELECT token_hash FROM api_tokens').pluck().get()).not.toContain(token);
    expect(users.listTokens(id)).toMatchObject([{ name: 'cli', expiresAt: null, lastUsedAt: now }]);
  });

  test('stops working when expired, revoked or the user is disabled', () => {
    const id = alice();
    const expiring = issue(id, now + 1000);
    const revoked = issue(id);
    const kept = issue(id);

    now += 1000;
    expect(users.userForToken(expiring.token)).toBeNull();
    users.revokeToken(id, revoked.id);
    expect(users.userForToken(revoked.token)).toBeNull();
    users.setDisabled(id, true);
    expect(users.userForToken(kept.token)).toBeNull();
  });

  test('regenerating replaces the secret; others cannot touch the token', () => {
    const id = alice();
    const other = users.create('bob', 'pw');
    if (!other.ok) throw new Error('create failed');
    const { token, id: tokenId } = issue(id);

    expect(users.regenerateToken(other.value.id, tokenId)).toMatchObject({ ok: false });
    users.revokeToken(other.value.id, tokenId);
    const next = users.regenerateToken(id, tokenId);
    if (!next.ok) throw new Error('regenerate failed');

    expect(users.userForToken(token)).toBeNull();
    expect(users.userForToken(next.value.token)?.id).toBe(id);
  });

  test('rejects a blank name and a past expiry', () => {
    const id = alice();
    expect(users.createToken(id, ' ', null)).toMatchObject({ ok: false });
    expect(users.createToken(id, 'x', now)).toMatchObject({ ok: false });
  });
});
