import { getTranslations } from 'next-intl/server';
import { CredentialsManager } from '../components/CredentialsManager';
import { TokensManager } from '../components/TokensManager';
import { getCore } from '../lib/core';
import { credentialNames } from '../lib/credentialNames';
import { currentUser } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await currentUser();
  if (user === null) return null;
  const t = await getTranslations('Account');
  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">
        {t.rich('intro', {
          username: user.username,
          header: 'Authorization: Bearer <token>',
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <TokensManager tokens={getCore().users.listTokens(user.id)} />
      <h2>{t('credentials')}</h2>
      <p className="muted">{t('credentialsIntro')}</p>
      <CredentialsManager names={credentialNames()} stored={getCore().credentials.names(user.id)} />
    </>
  );
}
