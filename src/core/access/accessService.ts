import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';

export type Permission = 'read' | 'write';
export const PERMISSIONS: readonly Permission[] = ['read', 'write'];
export const ADMIN_ROLE = 'Administrator';

export interface Role {
  id: number;
  name: string;
  permissions: Permission[];
}

// projectId null is a global assignment: it applies to every Project.
export interface RoleAssignment {
  id: number;
  userId: number;
  roleId: number;
  projectId: number | null;
}

type Row = Record<string, unknown>;

const invalid = (field: string, message: string) => err({ code: 'INVALID_INPUT', field, message } as const);

// A user holds a permission in a Project if any of their roles, global or scoped to it, grants it. `write` implies
// `read`. There are no deny rules, so assignments can never conflict.
export class AccessService {
  constructor(private readonly db: Database) {}

  // Gives existing installations a first Administrator: the earliest user, but only while nobody has any role.
  ensureBootstrap(): void {
    let role = this.db.prepare('SELECT id FROM roles WHERE name = ?').get(ADMIN_ROLE) as { id: number } | undefined;
    if (role === undefined && (this.db.prepare('SELECT COUNT(*) AS n FROM roles').get() as { n: number }).n === 0) {
      const created = this.createRole(ADMIN_ROLE, [...PERMISSIONS]);
      if (created.ok) role = { id: created.value.id };
    }
    const assigned = (this.db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get() as { n: number }).n;
    const first = this.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (role !== undefined && assigned === 0 && first !== undefined) this.assign(first.id, role.id, null);
  }

  listRoles(): Role[] {
    const perms = this.db.prepare('SELECT role_id, permission FROM role_permissions').all() as Row[];
    return (this.db.prepare('SELECT id, name FROM roles ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      permissions: PERMISSIONS.filter((p) => perms.some((x) => x.role_id === r.id && x.permission === p)),
    }));
  }

  createRole(name: string, permissions: Permission[]): Result<Role> {
    const trimmed = name.trim();
    if (trimmed === '') return invalid('name', 'Name is required');
    try {
      const id = Number(this.db.prepare('INSERT INTO roles (name) VALUES (?)').run(trimmed).lastInsertRowid);
      this.setRolePermissions(id, permissions);
      return ok({ id, name: trimmed, permissions: PERMISSIONS.filter((p) => permissions.includes(p)) });
    } catch {
      return invalid('name', `Role "${trimmed}" already exists`);
    }
  }

  // The last role that grants a global `write` can't lose it, so the installation can't lock itself out.
  setRolePermissions(roleId: number, permissions: Permission[]): Result<void> {
    if (!permissions.includes('write') && this.wouldRemoveLastAdmin({ roleId }))
      return invalid('permissions', 'This would leave nobody able to manage the installation');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      for (const p of new Set(permissions))
        this.db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(roleId, p);
    })();
    return ok(undefined);
  }

  deleteRole(roleId: number): Result<void> {
    if (this.wouldRemoveLastAdmin({ roleId }))
      return invalid('role', 'This would leave nobody able to manage the installation');
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    return ok(undefined);
  }

  listAssignments(): RoleAssignment[] {
    return (
      this.db.prepare('SELECT id, user_id, role_id, project_id FROM role_assignments ORDER BY id').all() as Row[]
    ).map((r) => ({
      id: r.id as number,
      userId: r.user_id as number,
      roleId: r.role_id as number,
      projectId: r.project_id as number | null,
    }));
  }

  assign(userId: number, roleId: number, projectId: number | null): Result<void> {
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO role_assignments (user_id, role_id, project_id) VALUES (?, ?, ?)')
        .run(userId, roleId, projectId);
      return ok(undefined);
    } catch {
      return invalid('assignment', 'The user, role or Project no longer exists');
    }
  }

  unassign(assignmentId: number): Result<void> {
    if (this.wouldRemoveLastAdmin({ assignmentId }))
      return invalid('assignment', 'This would leave nobody able to manage the installation');
    this.db.prepare('DELETE FROM role_assignments WHERE id = ?').run(assignmentId);
    return ok(undefined);
  }

  can(userId: number, permission: Permission, projectId: number | null = null): boolean {
    const granted = permission === 'read' ? ['read', 'write'] : ['write'];
    const row = this.db
      .prepare(
        `SELECT 1 FROM role_assignments a JOIN role_permissions p ON p.role_id = a.role_id
         JOIN users u ON u.id = a.user_id
         WHERE a.user_id = ? AND u.disabled = 0 AND p.permission IN (${granted.map(() => '?').join(',')})
           AND (a.project_id IS NULL OR a.project_id = ?) LIMIT 1`,
      )
      .get(userId, ...granted, projectId);
    return row !== undefined;
  }

  // Managing users, roles and global settings takes a global `write`.
  canAdminister(userId: number): boolean {
    return this.can(userId, 'write', null);
  }

  // Projects a user may see: those with a scoped grant, or all of them with a global one.
  readableProjectIds(userId: number, allProjectIds: number[]): number[] {
    return allProjectIds.filter((id) => this.can(userId, 'read', id));
  }

  private wouldRemoveLastAdmin(change: { roleId?: number; assignmentId?: number }): boolean {
    const admins = (sql: string, ...args: unknown[]) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT a.user_id) AS n FROM role_assignments a
             JOIN role_permissions p ON p.role_id = a.role_id AND p.permission = 'write'
             JOIN users u ON u.id = a.user_id
             WHERE a.project_id IS NULL AND u.disabled = 0 ${sql}`,
          )
          .get(...args) as { n: number }
      ).n;
    const before = admins('');
    if (before === 0) return false;
    const after =
      change.roleId !== undefined
        ? admins('AND a.role_id <> ?', change.roleId)
        : admins('AND a.id <> ?', change.assignmentId);
    return after === 0;
  }
}
