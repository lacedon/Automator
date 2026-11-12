import { useTranslations } from 'next-intl';
import type { WatchKind } from '@core/index';
import { Pill } from './Pill';

export const KIND_NAME: Record<WatchKind, string> = { mr: 'Merge/pull request', jira: 'Jira issue', free: 'Free-form' };

export function KindBadge({ kind }: { kind: WatchKind }) {
  const t = useTranslations('Kind');
  return <Pill variant="info">{t(kind)}</Pill>;
}
