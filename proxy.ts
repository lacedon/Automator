import { NextResponse, type NextRequest } from 'next/server';
import { isAllowedRequest } from './app/lib/hostCheck';

// Runs for every route, including Server Actions, /files and static assets.
export function proxy(request: NextRequest) {
  if (!isAllowedRequest(request.headers)) {
    return new NextResponse('Forbidden: Automator only answers to 127.0.0.1, localhost or [::1].\n', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
