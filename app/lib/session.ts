import { cookies, headers } from 'next/headers';
import type { User } from '@core/index';
import { getCore } from './core';

export const SESSION_COOKIE = 'automator-session';

// An `Authorization: Bearer <access token>` header (CLI and API clients) or the browser session cookie.
export function bearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

// Browser session cookie only; ignores any Authorization header.
export async function sessionUser(): Promise<User | null> {
  const jar = await cookies();
  return getCore().users.userForSession(jar.get(SESSION_COOKIE)?.value);
}

export async function currentUser(): Promise<User | null> {
  const token = bearerToken((await headers()).get('authorization'));
  if (token !== undefined) return getCore().users.userForToken(token);
  return sessionUser();
}
