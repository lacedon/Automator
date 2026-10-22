import type { AppError } from '@core/index';

export type ActionResult<T = void> = { ok: true; value?: T } | { ok: false; error: AppError };

// Failed form submissions echo the submitted fields so the form keeps them.
export type FormResult<V> = { ok: false; error: AppError; values: V } | null;
