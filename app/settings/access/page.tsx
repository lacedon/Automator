import { AccessManager } from '../../components/AccessManager';
import { getCore } from '../../lib/core';
import { currentUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

export default async function AccessPage() {
  const core = getCore();
  const user = await currentUser();
  if (user === null || !core.access.canAdminister(user.id))
    return <p className="muted">Managing users and roles needs the global write permission.</p>;
  return (
    <>
      <h1 className="page-title">Users &amp; roles</h1>
      <p className="muted">
        A role is a set of permissions: <b>read</b> (see everything in a Project) and <b>write</b> (do actions with
        everything; includes read). Assign roles globally or per Project; a user holds a permission if any of their
        roles grants it. Managing users and roles needs a global write.
      </p>
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
