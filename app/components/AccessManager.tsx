'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('Access');
  return (
    <>
      {PERMISSIONS.map((p) => (
        <label key={p}>
          <input
            type="checkbox"
            checked={value.includes(p)}
            onChange={() => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p])}
          />{' '}
          {p === 'read' ? t('permRead') : t('permWrite')}
        </label>
      ))}
    </>
  );
}

function RoleRow({ role }: { role: Role }) {
  const t = useTranslations('Access');
  const [permissions, setPermissions] = useState<Permission[]>(role.permissions);
  return (
    <SettingsTableRow
      name={role.name}
      actions={
        <>
          <ActionButton action={() => setRolePermissions(role.id, permissions)}>{t('save')}</ActionButton>
          <ActionButton className="btn btn-danger" action={() => deleteRole(role.id)}>
            {t('delete')}
          </ActionButton>
        </>
      }
    >
      <PermissionBoxes value={permissions} onChange={setPermissions} />
    </SettingsTableRow>
  );
}

export function AccessManager({ users, roles, assignments, projects, currentUserId }: Props) {
  const t = useTranslations('Access');
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
    id === null ? t('allProjects') : (projects.find((p) => p.id === id)?.name ?? '?');
  return (
    <ActionErrorProvider>
      <h2>{t('users')}</h2>
      <div className="project-create">
        <input
          aria-label={t('newUsername')}
          placeholder={t('username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          aria-label={t('newPassword')}
          type="password"
          placeholder={t('password')}
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
          {t('createUser')}
        </ActionButton>
      </div>
      <SettingsTable label={t('users')} headers={[t('userCol'), t('statusCol'), t('actionsCol')]}>
        {users.map((u) => (
          <SettingsTableRow
            key={u.id}
            name={u.username}
            actions={
              <ActionButton
                action={() => setUserDisabled(u.id, !u.disabled)}
                disabledReason={u.id === currentUserId ? t('cannotDisableSelf') : undefined}
              >
                {u.disabled ? t('enable') : t('disable')}
              </ActionButton>
            }
          >
            <span className="muted">{u.disabled ? t('disabled') : t('active')}</span>
          </SettingsTableRow>
        ))}
      </SettingsTable>

      <h2>{t('roles')}</h2>
      <div className="project-create">
        <input
          aria-label={t('newRoleName')}
          placeholder={t('roleName')}
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
        />
        <PermissionBoxes value={rolePermissions} onChange={setNewRolePermissions} />
        <ActionButton
          className="btn btn-primary"
          action={() => createRole(roleName, rolePermissions)}
          onDone={() => setRoleName('')}
        >
          {t('createRole')}
        </ActionButton>
      </div>
      <SettingsTable label={t('roles')} headers={[t('roleCol'), t('permissionsCol'), t('actionsCol')]}>
        {roles.map((r) => (
          <RoleRow key={r.id} role={r} />
        ))}
      </SettingsTable>

      <h2>{t('assignments')}</h2>
      <div className="project-create">
        <select aria-label={t('assignUser')} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">{t('userOption')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select aria-label={t('assignRole')} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">{t('roleOption')}</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select aria-label={t('assignScope')} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="global">{t('allProjects')}</option>
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
          {t('assign')}
        </ActionButton>
      </div>
      <SettingsTable label={t('assignments')} headers={[t('userCol'), t('roleScopeCol'), t('actionsCol')]}>
        {assignments.map((a) => (
          <SettingsTableRow
            key={a.id}
            name={userName(a.userId)}
            actions={<ActionButton action={() => unassignRole(a.id)}>{t('remove')}</ActionButton>}
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
