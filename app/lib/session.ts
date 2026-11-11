import { cookies, headers } from 'next/headers';
import type { User } from '@core/index';
import { getCore } from './core';

export const SESSION_COOKIE = 'automator-session';

// An `Authorization` header (CLI and API clients): `Bearer <access token>` or `Basic <username:password>`.
export function userForAuthorization(header: string | null | undefined): User | null {
  const { users } = getCore();
  const bearer = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (bearer !== undefined) return users.userForToken(bearer);
  const basic = /^Basic\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (basic === undefined) return null;
  const decoded = Buffer.from(basic, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : users.userForPassword(decoded.slice(0, colon), decoded.slice(colon + 1));
}

export const hasAuthorization = (header: string | null | undefined): boolean => /^(Bearer|Basic)\s/i.test(header ?? '');

// Browser session cookie only; ignores any Authorization header.
export async function sessionUser(): Promise<User | null> {
  const jar = await cookies();
  return getCore().users.userForSession(jar.get(SESSION_COOKIE)?.value);
}

export async function currentUser(): Promise<User | null> {
  const header = (await headers()).get('authorization');
  return hasAuthorization(header) ? userForAuthorization(header) : sessionUser();
}
