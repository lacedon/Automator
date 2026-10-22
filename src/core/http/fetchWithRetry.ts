export class HttpError extends Error {
  readonly status: number | null;
  readonly auth: boolean;

  constructor(message: string, status: number | null, auth: boolean) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.auth = auth;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_FACTOR = 4;
const BACKOFF_CAP_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTH_STATUSES = new Set([401, 403, 404]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError = new HttpError(`Request to ${url} failed`, null, false);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1), BACKOFF_CAP_MS));
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      lastError = new HttpError(`Request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`, null, false);
      continue;
    }
    if (res.ok) return res;
    await res.body?.cancel();
    const error = new HttpError(
      `Request to ${url} failed with HTTP ${res.status}`,
      res.status,
      AUTH_STATUSES.has(res.status),
    );
    if (!isRetryable(res.status)) throw error;
    lastError = error;
  }
  throw lastError;
}
