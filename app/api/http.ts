import { z } from 'zod';
import { formatDuration, type AppError } from '@core/index';
import { parseInput } from '../actions/parse';

type Failure = { status: number; code: string; message: string };

function failure(error: AppError): Failure {
  switch (error.code) {
    case 'UNKNOWN_REPOSITORY':
      return {
        status: 400,
        code: error.code,
        message: `Unknown Repository "${error.name}". Known: ${error.known.join(', ')}`,
      };
    case 'DUPLICATE_WATCH':
      return {
        status: 409,
        code: error.code,
        message: `Already automated: Automation #${error.existing.id} (${error.existing.state}, every ${formatDuration(error.existing.intervalMs)})`,
      };
    case 'RUN_IN_PROGRESS':
      return { status: 409, code: error.code, message: 'Cancel the running Run first' };
    case 'INVALID_STATE':
      return { status: 409, code: error.code, message: `Cannot ${error.action} while ${error.state}` };
    case 'JIRA_DISABLED':
      return { status: 409, code: error.code, message: 'Jira checking is disabled (jira.enabled is false)' };
    case 'MISSING_INSTRUCTIONS':
      return { status: 400, code: error.code, message: 'Free-form Automations need instructions' };
    case 'INVALID_INPUT':
      return { status: 400, code: error.code, message: `${error.field}: ${error.message}` };
    case 'INVALID_TARGET':
      return { status: 400, code: error.code, message: error.message };
    case 'FORBIDDEN':
      return { status: 403, code: error.code, message: 'Permission denied' };
    case 'NOT_FOUND':
      return { status: 404, code: error.code, message: 'Not found' };
    case 'RESTART_FAILED':
    case 'UPGRADE_FAILED':
      return { status: 500, code: error.code, message: error.message };
  }
}

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

export function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: HEADERS });
}

export function errorResponse(error: AppError): Response {
  const { status, ...body } = failure(error);
  return json({ error: body }, status);
}

// Parses a JSON object body with the schema; a malformed body or a failed schema is a 400 response.
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; value: z.output<S> } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: errorResponse({ code: 'INVALID_INPUT', field: 'body', message: 'Expected a JSON object' }),
    };
  }
  const input = parseInput(schema, body);
  return input.ok ? input : { ok: false, response: errorResponse(input.error) };
}
