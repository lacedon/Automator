import { describe, expect, test } from 'vitest';
import { isAllowedHost, isAllowedRequest } from './hostCheck';

describe('isAllowedHost', () => {
  test.each(['127.0.0.1:4317', 'localhost:4317', '[::1]:4317', 'LOCALHOST:4399', '127.0.0.1:3000', 'localhost', '127.0.0.1', '[::1]'])(
    'allows loopback host %s',
    (host) => {
      expect(isAllowedHost(host)).toBe(true);
    },
  );

  test.each([
    null,
    '',
    'evil.example',
    'evil.example:4317',
    'localhost.evil.example:4317',
    '127.0.0.1.nip.io:4317',
    '127.0.0.2:4317',
    '0.0.0.0:4317',
    '::1:4317',
    '127.0.0.1:',
    '127.0.0.1:abc',
    '127.0.0.1:4317 ',
    'localhost:4317@evil.example',
  ])('rejects %s', (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });
});

describe('isAllowedRequest', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  test('requires a loopback Host and, when present, a loopback X-Forwarded-Host', () => {
    expect(isAllowedRequest(headers({ host: '127.0.0.1:4317' }))).toBe(true);
    expect(isAllowedRequest(headers({ host: '127.0.0.1:4317', 'x-forwarded-host': 'localhost:4317' }))).toBe(true);
    expect(isAllowedRequest(headers({}))).toBe(false);
    expect(isAllowedRequest(headers({ host: 'evil.example' }))).toBe(false);
    expect(isAllowedRequest(headers({ host: '127.0.0.1:4317', 'x-forwarded-host': 'evil.example' }))).toBe(false);
  });
});
