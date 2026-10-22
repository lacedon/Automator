// Guards against DNS rebinding: a hostile page whose name resolves to 127.0.0.1 still sends its own Host.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

export function isAllowedHost(host: string | null): boolean {
  return host !== null && LOOPBACK_HOST.test(host.toLowerCase());
}

// Next.js compares a Server Action's Origin with X-Forwarded-Host when it is set, so both must be loopback.
export function isAllowedRequest(headers: Headers): boolean {
  const forwarded = headers.get('x-forwarded-host');
  return isAllowedHost(headers.get('host')) && (forwarded === null || isAllowedHost(forwarded));
}
