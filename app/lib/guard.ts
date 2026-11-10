import type { AppError } from '@core/index';
import { getCore } from './core';
import { currentUser } from './session';

type Denied = { ok: false; error: AppError };
export type Guard = { ok: true; userId: number } | Denied;

const FORBIDDEN: Denied = { ok: false, error: { code: 'FORBIDDEN' } };

// Server Actions are public endpoints, so each one checks permission itself rather than trusting the UI.
async function check(allowed: (userId: number) => boolean): Promise<Guard> {
  const user = await currentUser();
  return user !== null && allowed(user.id) ? { ok: true, userId: user.id } : FORBIDDEN;
}

// Installation-wide settings, users and roles.
export const requireAdmin = () => check((id) => getCore().access.canAdminister(id));

export const requireWriteOnRepository = (repository: string) =>
  check((id) => getCore().access.canOnRepository(id, 'write', repository));

export const requireWriteOnWatch = (watchId: number) =>
  check((id) => getCore().access.canOnWatch(id, 'write', watchId));

export const requireWriteOnRun = (runId: number) => check((id) => getCore().access.canOnRun(id, 'write', runId));

// Pages answer 404 rather than 403 so an identifier does not reveal whether it exists.
export async function canReadWatch(watchId: number): Promise<boolean> {
  return (await check((id) => getCore().access.canOnWatch(id, 'read', watchId))).ok;
}

export async function canReadRun(runId: number): Promise<boolean> {
  return (await check((id) => getCore().access.canOnRun(id, 'read', runId))).ok;
}

export async function canReadGlobally(): Promise<boolean> {
  return (await check((id) => getCore().access.can(id, 'read', null))).ok;
}
