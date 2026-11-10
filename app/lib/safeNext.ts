// Only same-site paths may follow a sign-in, so the login page cannot be used as an open redirect.
export function safeNext(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}
