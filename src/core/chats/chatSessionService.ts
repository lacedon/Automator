import type { Database } from '../db/open';
import { toChatSession } from '../db/rows';
import type { ChatMode, ChatSession, Clock, ProviderName } from '../domain/types';

export class ChatSessionService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  // Runs inside the caller's transaction, so the session and its first Run appear together.
  create(input: { repository: string; provider: ProviderName; model: string; agentId: number | null }): ChatSession {
    const now = this.clock.now();
    return toChatSession(
      this.db
        .prepare(
          `INSERT INTO chat_sessions (mode, repository, provider, model, agent_id, created_at, last_activity_at)
           VALUES ('interactive', ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(input.repository, input.provider, input.model, input.agentId, now, now),
    );
  }

  get(id: number): ChatSession | null {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
    return row === undefined ? null : toChatSession(row);
  }

  forRun(runId: number): ChatSession | null {
    const row = this.db
      .prepare('SELECT s.* FROM chat_sessions s JOIN runs r ON r.chat_session_id = s.id WHERE r.id = ?')
      .get(runId);
    return row === undefined ? null : toChatSession(row);
  }

  modeOfRun(runId: number): ChatMode {
    return this.forRun(runId) === null ? 'follow-up' : 'interactive';
  }
}
