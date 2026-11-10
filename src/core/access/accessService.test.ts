import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { ProjectService } from '../projects/projectService';
import { RepositoryService } from '../repositories/repositoryService';
import { UserService } from '../users/userService';
import { ADMIN_ROLE, AccessService } from './accessService';

let handle: ReturnType<typeof tempDb>;
let users: UserService;
let access: AccessService;
let alice: number;
let projectA: number;
let projectB: number;

function must<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
}

beforeEach(() => {
  handle = tempDb();
  users = new UserService(handle.db);
  access = new AccessService(handle.db);
  const projects = new ProjectService(handle.db, new RepositoryService(handle.db, {} as never));
  projectA = must(projects.create('A')).id;
  projectB = must(projects.create('B')).id;
  alice = must(users.create('alice', 'pw')).id;
});
afterEach(() => handle.cleanup());

describe('bootstrap', () => {
  test('makes the earliest user a global Administrator once', () => {
    access.ensureBootstrap();
    access.ensureBootstrap();

    expect(access.listRoles()).toMatchObject([{ name: ADMIN_ROLE, permissions: ['read', 'write'] }]);
    expect(access.canAdminister(alice)).toBe(true);
    expect(access.listAssignments()).toHaveLength(1);
  });
});

describe('permissions', () => {
  let reader: number;
  let writer: number;
  beforeEach(() => {
    reader = must(access.createRole('Reader', ['read'])).id;
    writer = must(access.createRole('Writer', ['write'])).id;
  });

  test('denies by default', () => {
    expect(access.can(alice, 'read', projectA)).toBe(false);
    expect(access.can(alice, 'write', null)).toBe(false);
  });

  test('a Project-scoped role applies only to that Project', () => {
    access.assign(alice, reader, projectA);
    expect(access.can(alice, 'read', projectA)).toBe(true);
    expect(access.can(alice, 'read', projectB)).toBe(false);
    expect(access.can(alice, 'write', projectA)).toBe(false);
    expect(access.canAdminister(alice)).toBe(false);
  });

  test('write implies read', () => {
    access.assign(alice, writer, projectA);
    expect(access.can(alice, 'read', projectA)).toBe(true);
    expect(access.can(alice, 'write', projectA)).toBe(true);
  });

  test('global and scoped roles combine without conflict', () => {
    access.assign(alice, reader, null);
    access.assign(alice, writer, projectB);
    expect(access.can(alice, 'read', projectA)).toBe(true);
    expect(access.can(alice, 'write', projectA)).toBe(false);
    expect(access.can(alice, 'write', projectB)).toBe(true);
    expect(access.readableProjectIds(alice, [projectA, projectB])).toEqual([projectA, projectB]);
  });

  test('changes take effect immediately and disabled users have no access', () => {
    access.assign(alice, writer, projectA);
    must(access.setRolePermissions(writer, ['read']));
    expect(access.can(alice, 'write', projectA)).toBe(false);

    must(access.unassign(access.listAssignments()[0]!.id));
    expect(access.can(alice, 'read', projectA)).toBe(false);

    access.assign(alice, reader, null);
    users.setDisabled(alice, true);
    expect(access.can(alice, 'read', projectA)).toBe(false);
  });

  test('assignments are idempotent and deleting a Project drops its assignments', () => {
    access.assign(alice, reader, projectA);
    access.assign(alice, reader, projectA);
    access.assign(alice, reader, null);
    access.assign(alice, reader, null);
    expect(access.listAssignments()).toHaveLength(2);

    handle.db.prepare('DELETE FROM projects WHERE id = ?').run(projectA);
    expect(access.listAssignments()).toHaveLength(1);
  });
});

describe('last administrator', () => {
  test('cannot be removed by unassigning, deleting the role or dropping write', () => {
    const admin = must(access.createRole(ADMIN_ROLE, ['read', 'write'])).id;
    access.assign(alice, admin, null);
    const [assignment] = access.listAssignments();

    expect(access.unassign(assignment!.id)).toMatchObject({ ok: false });
    expect(access.deleteRole(admin)).toMatchObject({ ok: false });
    expect(access.setRolePermissions(admin, ['read'])).toMatchObject({ ok: false });
    expect(access.canAdminister(alice)).toBe(true);
  });

  test('a second administrator makes the first removable', () => {
    const admin = must(access.createRole(ADMIN_ROLE, ['read', 'write'])).id;
    const bob = must(users.create('bob', 'pw')).id;
    access.assign(alice, admin, null);
    access.assign(bob, admin, null);

    expect(access.unassign(access.listAssignments()[0]!.id)).toMatchObject({ ok: true });
  });
});
