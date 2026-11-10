import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { CredentialService } from './credentialService';
import { UserService } from './userService';

let handle: ReturnType<typeof tempDb>;
let credentials: CredentialService;
let alice: number;
let bob: number;

beforeEach(() => {
  handle = tempDb();
  const users = new UserService(handle.db);
  const id = (name: string) => {
    const r = users.create(name, 'pw');
    if (!r.ok) throw new Error('create failed');
    return r.value.id;
  };
  alice = id('alice');
  bob = id('bob');
  credentials = new CredentialService(handle.db, path.join(path.dirname(handle.file), 'credentials.key'));
});
afterEach(() => handle.cleanup());

test('stores encrypted values per user and returns them as environment variables', () => {
  credentials.set(alice, 'GH_TOKEN', 'secret-a');
  credentials.set(alice, 'GH_TOKEN', 'secret-a2');
  credentials.set(bob, 'GH_TOKEN', 'secret-b');

  expect(credentials.env(alice)).toEqual({ GH_TOKEN: 'secret-a2' });
  expect(credentials.env(bob)).toEqual({ GH_TOKEN: 'secret-b' });
  expect(credentials.env(null)).toEqual({});
  expect(credentials.names(alice)).toMatchObject([{ name: 'GH_TOKEN' }]);
  expect(JSON.stringify(handle.db.prepare('SELECT value_enc FROM user_credentials').all())).not.toContain('secret');
  expect(fs.statSync(path.join(path.dirname(handle.file), 'credentials.key')).mode & 0o077).toBe(0);
});

test('removes a credential, rejects bad names and drops them with the user', () => {
  credentials.set(alice, 'GH_TOKEN', 'x');
  credentials.remove(alice, 'GH_TOKEN');
  expect(credentials.env(alice)).toEqual({});

  expect(credentials.set(alice, 'bad name', 'x')).toMatchObject({ ok: false });
  expect(credentials.set(alice, 'GH_TOKEN', '')).toMatchObject({ ok: false });

  credentials.set(bob, 'GH_TOKEN', 'x');
  handle.db.prepare('DELETE FROM users WHERE id = ?').run(bob);
  expect(credentials.names(bob)).toEqual([]);
});
