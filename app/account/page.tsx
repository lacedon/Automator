import { CredentialsManager } from '../components/CredentialsManager';
import { TokensManager } from '../components/TokensManager';
import { getCore } from '../lib/core';
import { credentialNames } from '../lib/credentialNames';
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
      <h2>Credentials</h2>
      <p className="muted">
        Your own secrets for the Runs you own, such as the token the agent signs in with. They are stored encrypted,
        never shown again, and used instead of the server&apos;s value; without one the server&apos;s value applies.
      </p>
      <CredentialsManager names={credentialNames()} stored={getCore().credentials.names(user.id)} />
    </>
  );
}
