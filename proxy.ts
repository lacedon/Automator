import { NextResponse, type NextRequest } from 'next/server';
import { getCore } from './app/lib/core';
import { SESSION_COOKIE, bearerToken } from './app/lib/session';

const PUBLIC_PATHS = ['/login', '/favicon.ico', '/icon.svg', '/apple-icon.png'];

// Runs for every route, including Server Actions and /files. Anything but the sign-in page needs a valid session.
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.includes(pathname) || pathname.startsWith('/_next/static/');
  const { users } = getCore();
  const token = bearerToken(request.headers.get('authorization'));
  const user =
    token !== undefined ? users.userForToken(token) : users.userForSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!isPublic && user === null) {
    const navigation =
      request.method === 'GET' &&
      request.headers.get('next-action') === null &&
      (request.headers.get('accept') ?? '').includes('text/html');
    if (navigation) {
      const login = new URL('/login', request.url);
      if (pathname !== '/') login.searchParams.set('next', pathname + search);
      return NextResponse.redirect(login);
    }
    return new NextResponse('Unauthorized\n', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
