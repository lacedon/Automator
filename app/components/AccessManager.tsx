'use client';

import { useState } from 'react';
import type { Permission, Role, RoleAssignment, User } from '@core/index';
import {
  assignRole,
  createRole,
  createUser,
  deleteRole,
  setRolePermissions,
  setUserDisabled,
  unassignRole,
} from '../actions/access';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { SettingsTable, SettingsTableRow } from './SettingsTable';

const PERMISSIONS: Permission[] = ['read', 'write'];

type Props = {
  users: (User & { disabled: boolean })[];
  roles: Role[];
  assignments: RoleAssignment[];
  projects: { id: number; name: string }[];
  currentUserId: number;
};

function PermissionBoxes({ value, onChange }: { value: Permission[]; onChange: (next: Permission[]) => void }) {
  return (
    <>
      {PERMISSIONS.map((p) => (
        <label key={p}>
          <input
            type="checkbox"
            checked={value.includes(p)}
            onChange={() => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p])}
          />{' '}
          {p}
        </label>
      ))}
    </>
  );
}

function RoleRow({ role }: { role: Role }) {
  const [permissions, setPermissions] = useState<Permission[]>(role.permissions);
  return (
    <SettingsTableRow
      name={role.name}
      actions={
        <>
          <ActionButton action={() => setRolePermissions(role.id, permissions)}>Save</ActionButton>
          <ActionButton className="btn btn-danger" action={() => deleteRole(role.id)}>
            Delete
          </ActionButton>
        </>
      }
    >
      <PermissionBoxes value={permissions} onChange={setPermissions} />
    </SettingsTableRow>
  );
}

export function AccessManager({ users, roles, assignments, projects, currentUserId }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roleName, setRoleName] = useState('');
  const [rolePermissions, setNewRolePermissions] = useState<Permission[]>(['read']);
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('global');
  const userName = (id: number) => users.find((u) => u.id === id)?.username ?? '?';
  const roleLabel = (id: number) => roles.find((r) => r.id === id)?.name ?? '?';
  const scopeLabel = (id: number | null) =>
    id === null ? 'All projects' : (projects.find((p) => p.id === id)?.name ?? '?');
  return (
    <ActionErrorProvider>
      <h2>Users</h2>
      <div className="project-create">
        <input
          aria-label="New username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          aria-label="New password"
          type="password"
          placeholder="Password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ActionButton
          className="btn btn-primary"
          action={() => createUser(username, password)}
          onDone={() => {
            setUsername('');
            setPassword('');
          }}
        >
          Create user
        </ActionButton>
      </div>
      <SettingsTable label="Users" headers={['User', 'Status', 'Actions']}>
        {users.map((u) => (
          <SettingsTableRow
            key={u.id}
            name={u.username}
            actions={
              <ActionButton
                action={() => setUserDisabled(u.id, !u.disabled)}
                disabledReason={u.id === currentUserId ? 'You cannot disable yourself' : undefined}
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </ActionButton>
            }
          >
            <span className="muted">{u.disabled ? 'Disabled' : 'Active'}</span>
          </SettingsTableRow>
        ))}
      </SettingsTable>

      <h2>Roles</h2>
      <div className="project-create">
        <input
          aria-label="New role name"
          placeholder="Role name"
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
        />
        <PermissionBoxes value={rolePermissions} onChange={setNewRolePermissions} />
        <ActionButton
          className="btn btn-primary"
          action={() => createRole(roleName, rolePermissions)}
          onDone={() => setRoleName('')}
        >
          Create role
        </ActionButton>
      </div>
      <SettingsTable label="Roles" headers={['Role', 'Permissions', 'Actions']}>
        {roles.map((r) => (
          <RoleRow key={r.id} role={r} />
        ))}
      </SettingsTable>

      <h2>Assignments</h2>
      <div className="project-create">
        <select aria-label="Assign user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">User…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select aria-label="Assign role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">Role…</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select aria-label="Assign scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="global">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ActionButton
          className="btn btn-primary"
          action={() => assignRole(Number(userId), Number(roleId), scope === 'global' ? null : Number(scope))}
        >
          Assign
        </ActionButton>
      </div>
      <SettingsTable label="Assignments" headers={['User', 'Role and scope', 'Actions']}>
        {assignments.map((a) => (
          <SettingsTableRow
            key={a.id}
            name={userName(a.userId)}
            actions={<ActionButton action={() => unassignRole(a.id)}>Remove</ActionButton>}
          >
            <span className="muted">
              {roleLabel(a.roleId)} · {scopeLabel(a.projectId)}
            </span>
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </ActionErrorProvider>
  );
}
