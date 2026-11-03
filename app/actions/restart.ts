'use server';

import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { isAllowedRequest } from '../lib/hostCheck';
import type { ActionResult } from './types';

const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;

function failure(message: string): ActionResult<{ accepted: boolean }> {
  return { ok: false, error: { code: 'RESTART_FAILED', message } };
}

export async function requestApplicationRestart(): Promise<ActionResult<{ accepted: boolean }>> {
  if (!isAllowedRequest(await headers()))
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        field: 'request',
        message: 'Application restart is only allowed from a loopback request.',
      },
    };

  const send = process.send;
  if (typeof send !== 'function' || process.connected === false)
    return failure('The supervisor IPC channel is unavailable.');

  const requestId = randomUUID();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ActionResult<{ accepted: boolean }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      resolve(result);
    };

    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const acknowledgement = message as { type?: unknown; requestId?: unknown };
      if (acknowledgement.requestId !== requestId) return;
      if (acknowledgement.type === 'restart-accepted') {
        finish({ ok: true, value: { accepted: true } });
      } else if (acknowledgement.type === 'restart-rejected') {
        finish(failure('The supervisor rejected the restart request.'));
      }
    };
    const onDisconnect = () => finish(failure('The supervisor IPC channel disconnected.'));
    const timeout = setTimeout(
      () => finish(failure('The supervisor did not acknowledge the restart request in time.')),
      ACKNOWLEDGEMENT_TIMEOUT_MS,
    );

    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    try {
      if (
        !send.call(process, { type: 'restart', requestId }, (error) => {
          if (error) finish(failure('The supervisor IPC channel could not accept the restart request.'));
        })
      )
        finish(failure('The supervisor IPC channel could not accept the restart request.'));
    } catch {
      finish(failure('The supervisor IPC channel could not accept the restart request.'));
    }
  });
}
