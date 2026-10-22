import type { WatchKind } from '@core/index';
import { Pill } from './Pill';

export const KIND_NAME: Record<WatchKind, string> = { mr: 'GitLab MR', jira: 'Jira issue', free: 'Free-form' };

export function KindBadge({ kind }: { kind: WatchKind }) {
  return <Pill variant="info">{KIND_NAME[kind]}</Pill>;
}
