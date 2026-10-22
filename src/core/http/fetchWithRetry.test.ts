import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchWithRetry, HttpError } from './fetchWithRetry';

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingSleep() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

function stubFetch(...outcomes: (number | Error)[]) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const outcome of outcomes) {
    if (outcome instanceof Error) spy.mockRejectedValueOnce(outcome);
    else spy.mockResolvedValueOnce(new Response(`status ${outcome}`, { status: outcome }));
  }
  return spy;
}

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected HttpError');
}

describe('fetchWithRetry', () => {
  test('retries 503 twice then succeeds with sleeps 1000 and 4000', async () => {
    const spy = stubFetch(503, 503, 200);
    const { sleeps, sleep } = recordingSleep();
    const res = await fetchWithRetry('https://x.test/a', { headers: { a: 'b' } }, { sleep });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([1000, 4000]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith(
      'https://x.test/a',
      expect.objectContaining({ headers: { a: 'b' }, signal: expect.any(AbortSignal) }),
    );
  });

  test('does not retry 401 and marks auth', async () => {
    const spy = stubFetch(401);
    const { sleeps, sleep } = recordingSleep();
    const e = await caught(fetchWithRetry('https://x.test/a', {}, { sleep }));
    expect(e.status).toBe(401);
    expect(e.auth).toBe(true);
    expect(sleeps).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test.each([403, 404])('does not retry %i and marks auth', async (status) => {
    const spy = stubFetch(status);
    const e = await caught(fetchWithRetry('https://x.test/a', {}, recordingSleep()));
    expect(e).toMatchObject({ status, auth: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('does not retry other 4xx and does not mark auth', async () => {
    const spy = stubFetch(400);
    const e = await caught(fetchWithRetry('https://x.test/a', {}, recordingSleep()));
    expect(e).toMatchObject({ status: 400, auth: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('retries 429', async () => {
    stubFetch(429, 200);
    const { sleeps, sleep } = recordingSleep();
    expect((await fetchWithRetry('https://x.test/a', {}, { sleep })).status).toBe(200);
    expect(sleeps).toEqual([1000]);
  });

  test('retries network error', async () => {
    const spy = stubFetch(new TypeError('fetch failed'), 200);
    const { sleeps, sleep } = recordingSleep();
    const res = await fetchWithRetry('https://x.test/a', {}, { sleep });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([1000]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('gives up after 3 attempts', async () => {
    const spy = stubFetch(503, 502, 500);
    const { sleeps, sleep } = recordingSleep();
    const e = await caught(fetchWithRetry('https://x.test/a', {}, { sleep }));
    expect(e).toMatchObject({ status: 500, auth: false });
    expect(sleeps).toEqual([1000, 4000]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('gives up after 3 network errors with null status', async () => {
    stubFetch(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const e = await caught(fetchWithRetry('https://x.test/a', {}, recordingSleep()));
    expect(e).toMatchObject({ status: null, auth: false });
    expect(e.message).toContain('fetch failed');
  });

  test('caps backoff at 10000 ms', async () => {
    stubFetch(503, 503, 503, 503);
    const { sleeps, sleep } = recordingSleep();
    await caught(fetchWithRetry('https://x.test/a', {}, { attempts: 4, sleep }));
    expect(sleeps).toEqual([1000, 4000, 10000]);
  });

  test('times out a stalled request and retries', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    spy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleeps, sleep } = recordingSleep();
    const res = await fetchWithRetry('https://x.test/a', {}, { sleep, timeoutMs: 20 });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([1000]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('reports a timeout as a network error after all attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const e = await caught(fetchWithRetry('https://x.test/a', {}, { ...recordingSleep(), timeoutMs: 10 }));
    expect(e).toMatchObject({ status: null, auth: false });
  });

  test('does not retry when the caller aborts', async () => {
    const spy = stubFetch(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithRetry('https://x.test/a', { signal: controller.signal }, recordingSleep())).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
