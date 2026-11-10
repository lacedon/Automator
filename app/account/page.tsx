import { TokensManager } from '../components/TokensManager';
import { getCore } from '../lib/core';
import { currentUser } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await currentUser();
  if (user === null) return null;
  return (
    <>
      <h1 className="page-title">Access tokens</h1>
      <p className="muted">
        Tokens let the CLI and API clients act as {user.username} with your permissions. Send one as{' '}
        <code>Authorization: Bearer &lt;token&gt;</code>. A token is shown only once; regenerate it if you lose it.
      </p>
      <TokensManager tokens={getCore().users.listTokens(user.id)} />
    </>
  );
}
