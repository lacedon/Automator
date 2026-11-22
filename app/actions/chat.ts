'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { copyWork, type AppError, type CopyWork } from '@core/index';
import { getCore } from '../lib/core';
import { requireWriteOnRun } from '../lib/guard';
import { parseInput } from './parse';

export type ChatFormState =
  { ok: true; value: { runId: number } } | { ok: false; error: AppError; values: { message?: string } } | null;

const chatSchema = z.object({
  runId: z
    .string()
    .regex(/^[1-9]\d*$/, 'Run id must be a positive integer')
    .transform(Number),
  message: z.string(),
});

export async function sendRunMessage(_prev: ChatFormState, formData: FormData): Promise<ChatFormState> {
  const message = formData.get('message');
  const values = typeof message === 'string' ? { message } : {};
  const input = parseInput(chatSchema, { runId: formData.get('runId'), message });
  if (!input.ok) return { ...input, values };
  const guard = await requireWriteOnRun(input.value.runId);
  if (!guard.ok) return { ...guard, values };
  const core = getCore();
  const result = core.queue.requestFollowUp(input.value.runId, input.value.message);
  if (!result.ok) return { ...result, values };
  core.access.setOwner('runs', result.value.run.id, guard.userId);
  revalidatePath('/', 'layout');
  return { ok: true, value: { runId: result.value.run.id } };
}

export type BranchFormState = { ok: false; error: AppError; values: { message?: string } } | null;

export async function branchRun(_prev: BranchFormState, formData: FormData): Promise<BranchFormState> {
  const message = formData.get('message');
  const values = typeof message === 'string' ? { message } : {};
  const input = parseInput(chatSchema, { runId: formData.get('runId'), message });
  if (!input.ok) return { ...input, values };
  const guard = await requireWriteOnRun(input.value.runId);
  if (!guard.ok) return { ...guard, values };
  const core = getCore();
  const result = core.queue.requestBranch(input.value.runId, input.value.message);
  if (!result.ok) return { ...result, values };
  core.access.setOwner('runs', result.value.run.id, guard.userId);
  revalidatePath('/', 'layout');
  redirect(`/runs/${result.value.run.id}`);
}

export type CloseChatResult =
  { ok: true } | { ok: false; error: AppError } | { ok: false; needsConfirmation: true; work: CopyWork };

// Closing deletes the Chat's working copy, so unsaved work needs an explicit confirmation first.
export async function closeChat(runId: number, confirmed: boolean): Promise<CloseChatResult> {
  if (!Number.isInteger(runId) || runId < 1) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'runId', message: 'Run id must be a positive integer' },
    };
  }
  const guard = await requireWriteOnRun(runId);
  if (!guard.ok) return guard;
  const core = getCore();
  const session = core.chats.forRun(runId);
  if (session !== null && session.copyPath !== null && !confirmed) {
    const work = await copyWork(session.copyPath, core.repositories.get(session.repository)?.folder ?? null);
    // A failed git check counts as possible work: only a positive "nothing to lose" skips the confirmation.
    if (work !== null && (work.unknown || work.uncommitted || work.unpushedCommits > 0)) {
      return { ok: false, needsConfirmation: true, work };
    }
  }
  const result = core.queue.requestCloseChat(runId);
  if (!result.ok) return result;
  revalidatePath('/', 'layout');
  return { ok: true };
}
