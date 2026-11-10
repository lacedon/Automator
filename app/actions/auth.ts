'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCore } from '../lib/core';
import { safeNext } from '../lib/safeNext';
import { SESSION_COOKIE } from '../lib/session';
import type { FormResult } from './types';

export type SignInValues = { username?: string };

export async function signIn(_prev: FormResult<SignInValues>, formData: FormData): Promise<FormResult<SignInValues>> {
  const username = formData.get('username');
  const password = formData.get('password');
  const values: SignInValues = { username: typeof username === 'string' ? username : '' };
  const session =
    typeof username === 'string' && typeof password === 'string' ? getCore().users.signIn(username, password) : null;
  if (session === null)
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'password', message: 'Wrong username or password' },
      values,
    };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: session.expiresAt,
    secure: (await headers()).get('x-forwarded-proto') === 'https',
  });
  redirect(safeNext(formData.get('next')));
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token !== undefined) getCore().users.signOut(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
