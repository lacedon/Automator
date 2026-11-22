import type { RunRow } from '@core/index';
import type { NavChatStatus } from '../components/Sidebar';

// The left-menu badge of a Chat. Waiting for you comes first: the Chat needs an answer whatever its latest Run did.
export function chatStatus(run: RunRow): NavChatStatus | null {
  if (run.chatState === 'waiting') return 'waiting';
  if (run.closedAt !== null || run.interrupted !== null) return null;
  if (run.outcome === 'needs-you') return 'needs-you';
  if (run.resultStatus === 'error') return 'error';
  if (run.outcome !== null) return null;
  return run.status === 'running' || run.status === 'queued' ? run.status : null;
}
