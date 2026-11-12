import { getTranslations } from 'next-intl/server';
import { AccessManager } from '../../components/AccessManager';
import { getCore } from '../../lib/core';
import { currentUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

export default async function AccessPage() {
  const core = getCore();
  const t = await getTranslations('Access');
  const user = await currentUser();
  if (user === null || !core.access.canAdminister(user.id)) return <p className="muted">{t('needsPermission')}</p>;
  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">{t.rich('intro', { b: (chunks) => <b>{chunks}</b> })}</p>
      <AccessManager
        users={core.users.list()}
        roles={core.access.listRoles()}
        assignments={core.access.listAssignments()}
        projects={core.projects.list().map((p) => ({ id: p.id, name: p.name }))}
        currentUserId={user.id}
      />
    </>
  );
}
