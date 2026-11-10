import { cookies } from 'next/headers';
import type { User } from '@core/index';
import { getCore } from './core';

export const SESSION_COOKIE = 'automator-session';

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return getCore().users.userForSession(jar.get(SESSION_COOKIE)?.value);
}
