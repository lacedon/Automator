import type { AppError } from '@core/index';

export type ActionResult<T = void> = { ok: true; value?: T } | { ok: false; error: AppError };
