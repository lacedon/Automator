'use server';

import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { requireAdmin } from '../lib/guard';
import type { ActionResult } from './types';

const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;

function failure(message: string): ActionResult<{ accepted: boolean }> {
  return { ok: false, error: { code: 'RESTART_FAILED', message } };
}

export async function requestApplicationRestart(): Promise<ActionResult<{ accepted: boolean }>> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard;

  const socketPath = process.env.AUTOMATOR_SUPERVISOR_SOCKET;
  const send = process.send;
  if (socketPath === undefined && (typeof send !== 'function' || process.connected === false))
    return failure('The supervisor IPC channel is unavailable.');

  const requestId = randomUUID();

  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const finish = (result: ActionResult<{ accepted: boolean }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      socket?.destroy();
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
    const onSocketMessage = (data: string) => {
      try {
        onMessage(JSON.parse(data) as unknown);
      } catch {
        finish(failure('The supervisor IPC socket returned an invalid acknowledgement.'));
      }
    };
    const timeout = setTimeout(
      () => finish(failure('The supervisor did not acknowledge the restart request in time.')),
      ACKNOWLEDGEMENT_TIMEOUT_MS,
    );

    if (socketPath !== undefined) {
      let buffer = '';
      socket = createConnection(socketPath);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket?.write(`${JSON.stringify({ type: 'restart', requestId })}\n`, (error) => {
          if (error) finish(failure('The supervisor IPC socket could not accept the restart request.'));
        });
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline !== -1) onSocketMessage(buffer.slice(0, newline));
      });
      socket.on('error', () => finish(failure('The supervisor IPC socket disconnected.')));
      socket.on('close', () => {
        if (!settled) finish(failure('The supervisor IPC socket disconnected.'));
      });
    } else {
      process.on('message', onMessage);
      process.once('disconnect', onDisconnect);
      try {
        send!.call(process, { type: 'restart', requestId }, (error) => {
          if (error) finish(failure('The supervisor IPC channel could not accept the restart request.'));
        });
      } catch {
        finish(failure('The supervisor IPC channel could not accept the restart request.'));
      }
    }
  });
}
