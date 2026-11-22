import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import { err, ok, type Result } from '../domain/result';
import type { ChatSession, PendingQuestion, Run } from '../domain/types';
import { MAX_FOLLOW_UP_CHARS, type QueueService } from '../queue/queueService';

// Questions an Interactive Chat's agent asks the user mid-turn. Every transition is one IMMEDIATE transaction, so the
// waiter (the MCP process, the pi chat-tool process, or the session manager) and the dashboard cannot interleave:
// an answer either lands in the waiting turn or starts exactly one `answer` turn, never both and never neither.

type Row = Record<string, unknown>;

const CLEAR_QUESTION = `question_text = NULL, question_options_json = NULL, question_source = NULL,
  question_request_id = NULL, question_run_id = NULL, question_asked_at = NULL, question_expires_at = NULL,
  question_expired_at = NULL, question_answer = NULL`;

export type OpenQuestionInput = {
  sessionId: number;
  runId: number | null;
  text: string;
  options: string[] | null;
  source: 'automator' | 'native';
  requestId: string;
  now: number;
  waitMs: number;
};

// The limits of the ask_user schema, enforced for native questions too: unbounded provider text must not be stored,
// shown whole, or embedded in the next prompt.
export const MAX_QUESTION_CHARS = 2000;
export const MAX_OPTION_CHARS = 200;
export const MAX_OPTIONS = 10;

export function openQuestion(db: Database, rawInput: OpenQuestionInput): Result<PendingQuestion> {
  const input = {
    ...rawInput,
    text: rawInput.text.slice(0, MAX_QUESTION_CHARS),
    options:
      rawInput.options === null
        ? null
        : rawInput.options.slice(0, MAX_OPTIONS).map((option) => option.slice(0, MAX_OPTION_CHARS)),
  };
  return db
    .transaction((): Result<PendingQuestion> => {
      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(input.sessionId);
      if (row === undefined) return err({ code: 'NOT_FOUND' });
      const session = toChatSession(row);
      if (session.closedAt !== null || session.closeRequestedAt !== null) {
        return err({ code: 'INVALID_INPUT', field: 'session', message: 'This chat is closed' });
      }
      // A question whose turn was told to stop is stale: a later turn asking again replaces it.
      if (session.question !== null && session.question.expiredAt === null) {
        return err({
          code: 'INVALID_INPUT',
          field: 'question',
          message: 'A question is already waiting for an answer',
        });
      }
      const expiresAt = input.now + input.waitMs;
      db.prepare(
        `UPDATE chat_sessions SET question_text = ?, question_options_json = ?, question_source = ?,
           question_request_id = ?, question_run_id = ?, question_asked_at = ?, question_expires_at = ?,
           question_expired_at = NULL, question_answer = NULL, last_activity_at = ?
         WHERE id = ?`,
      ).run(
        input.text,
        input.options === null ? null : JSON.stringify(input.options),
        input.source,
        input.requestId,
        input.runId,
        input.now,
        expiresAt,
        input.now,
        input.sessionId,
      );
      return ok({
        text: input.text,
        options: input.options,
        source: input.source,
        requestId: input.requestId,
        runId: input.runId,
        askedAt: input.now,
        expiresAt,
        expiredAt: null,
      });
    })
    .immediate();
}

export type SettleResult =
  { kind: 'answered'; text: string } | { kind: 'expired' } | { kind: 'pending' } | { kind: 'gone' };

// Read-only (no write lock): true when settleQuestion has something to do, that is when the question was answered,
// is due to expire, is already expired, or is gone. A waiter polls this and only then takes the IMMEDIATE transaction.
export function needsSettling(db: Database, sessionId: number, requestId: string, now: number): boolean {
  const row = db
    .prepare(
      'SELECT question_request_id AS id, question_answer AS answer, question_expired_at AS expiredAt, question_expires_at AS expiresAt FROM chat_sessions WHERE id = ?',
    )
    .get(sessionId) as
    { id: string | null; answer: string | null; expiredAt: number | null; expiresAt: number | null } | undefined;
  if (row === undefined || row.id !== requestId) return true;
  return row.answer !== null || row.expiredAt !== null || now >= (row.expiresAt ?? 0);
}

// Called by the waiter. Exactly one of: answered (the answer is handed over and the question cleared), expired (the
// timeout reply is due; the question stays pending for a later `answer` turn), pending, or gone.
export function settleQuestion(db: Database, sessionId: number, requestId: string, now: number): SettleResult {
  return db
    .transaction((): SettleResult => {
      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as Row | undefined;
      if (row === undefined || row.question_request_id !== requestId) return { kind: 'gone' };
      if (row.question_answer !== null) {
        db.prepare(`UPDATE chat_sessions SET ${CLEAR_QUESTION}, last_activity_at = ? WHERE id = ?`).run(now, sessionId);
        return { kind: 'answered', text: row.question_answer as string };
      }
      if (row.question_expired_at !== null) return { kind: 'expired' };
      if (now >= (row.question_expires_at as number)) {
        db.prepare('UPDATE chat_sessions SET question_expired_at = ? WHERE id = ? AND question_answer IS NULL').run(
          now,
          sessionId,
        );
        return { kind: 'expired' };
      }
      return { kind: 'pending' };
    })
    .immediate();
}

// Clears the question and queues exactly one `answer` turn on the Chat tip. The caller holds the IMMEDIATE
// transaction, and clearing the question there is what stops any other path from queuing a second turn. The queued
// turn waits behind the Chat's running turn (claimNext runs one turn per Chat at a time).
function startAnswerTurn(
  db: Database,
  queue: QueueService,
  session: ChatSession,
  question: PendingQuestion,
  text: string,
): Run {
  const tip = db.prepare('SELECT id FROM runs WHERE chat_session_id = ? ORDER BY id DESC LIMIT 1').get(session.id) as {
    id: number;
  };
  clearQuestion(db, session.id);
  return queue.enqueueAdhoc({
    repository: session.repository,
    prompt: `Answer to your earlier question "${question.text}":\n\n${text}`,
    provider: session.provider,
    model: session.model,
    parentRunId: tip.id,
    agentId: session.agentId,
    chatSessionId: session.id,
    trigger: 'answer',
  });
}

// Settles the questions selected by `where` whose turn is gone: nobody waits any more. An in-turn answer that nobody
// picked up starts exactly one `answer` turn (never lost, never doubled); an unanswered question stays pending, marked
// expired, for a later answer. One IMMEDIATE transaction.
function settleOrphans(db: Database, queue: QueueService, now: number, where: string, ...params: unknown[]): boolean {
  return db
    .transaction((): boolean => {
      const rows = db
        .prepare(`SELECT * FROM chat_sessions WHERE question_text IS NOT NULL AND ${where}`)
        .all(...params) as Row[];
      for (const row of rows) {
        const session = toChatSession(row);
        if (row.question_answer !== null) {
          startAnswerTurn(db, queue, session, session.question!, row.question_answer as string);
        } else {
          db.prepare(
            'UPDATE chat_sessions SET question_expired_at = coalesce(question_expired_at, ?) WHERE id = ?',
          ).run(now, session.id);
        }
      }
      return rows.length > 0;
    })
    .immediate();
}

// The turn that asked has ended (finished, cancelled, crashed or interrupted).
export function expireQuestionsOfRun(db: Database, queue: QueueService, runId: number, now: number): boolean {
  return settleOrphans(db, queue, now, 'question_run_id = ?', runId);
}

// Recovery: a question whose Run is not running cannot be waited on.
export function expireOrphanedQuestions(db: Database, queue: QueueService, now: number): boolean {
  return settleOrphans(
    db,
    queue,
    now,
    `(question_expired_at IS NULL OR question_answer IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = chat_sessions.question_run_id AND r.status = 'running')`,
  );
}

export function clearQuestion(db: Database, sessionId: number): void {
  db.prepare(`UPDATE chat_sessions SET ${CLEAR_QUESTION} WHERE id = ?`).run(sessionId);
}

// Called by the dashboard (any Run of the Chat identifies it).
export function answerQuestion(
  db: Database,
  queue: QueueService,
  input: { runId: number; answer: string; now: number },
): Result<{ delivered: 'in-turn' } | { delivered: 'new-turn'; runId: number }> {
  return db
    .transaction((): Result<{ delivered: 'in-turn' } | { delivered: 'new-turn'; runId: number }> => {
      const run = db.prepare('SELECT chat_session_id FROM runs WHERE id = ?').get(input.runId) as
        { chat_session_id: number | null } | undefined;
      if (run === undefined) return err({ code: 'NOT_FOUND' });
      if (run.chat_session_id === null) {
        return err({ code: 'INVALID_INPUT', field: 'run', message: 'Only Interactive Chats ask questions' });
      }
      const sessionRow = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(run.chat_session_id);
      if (sessionRow === undefined) return err({ code: 'NOT_FOUND' });
      const session = toChatSession(sessionRow);
      if (session.closedAt !== null || session.closeRequestedAt !== null) {
        return err({ code: 'INVALID_INPUT', field: 'run', message: 'This chat is closed' });
      }
      const text = input.answer.trim();
      if (text === '') return err({ code: 'INVALID_INPUT', field: 'answer', message: 'Answer is required' });
      if (text.length > MAX_FOLLOW_UP_CHARS) {
        return err({
          code: 'INVALID_INPUT',
          field: 'answer',
          message: `Answer is too long (max ${MAX_FOLLOW_UP_CHARS} characters)`,
        });
      }
      const question = session.question;
      if (question === null) return err({ code: 'INVALID_STATE', state: 'finished', action: 'answerQuestion' });

      const waiting =
        question.runId === null
          ? undefined
          : (db.prepare("SELECT 1 FROM runs WHERE id = ? AND status = 'running'").get(question.runId) as
              { 1: number } | undefined);
      const raw = sessionRow as Row;
      if (question.expiredAt === null && waiting !== undefined) {
        if (raw.question_answer !== null) {
          return err({ code: 'INVALID_STATE', state: 'running', action: 'answerQuestion' });
        }
        db.prepare('UPDATE chat_sessions SET question_answer = ?, last_activity_at = ? WHERE id = ?').run(
          text,
          input.now,
          session.id,
        );
        return ok({ delivered: 'in-turn' });
      }

      const turn = startAnswerTurn(db, queue, session, question, text);
      return ok({ delivered: 'new-turn', runId: turn.id });
    })
    .immediate();
}
