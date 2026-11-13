import { getTranslations } from 'next-intl/server';
import { COLOR_SCHEMES } from '@core/index';
import { setUserColorScheme } from '../actions/colorScheme';
import { ColorSchemePicker } from '../components/ColorSchemePicker';
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
  const tScheme = await getTranslations('ColorScheme');
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
      <h2>{tScheme('own')}</h2>
      <p className="muted">{tScheme('ownIntro')}</p>
      <ColorSchemePicker
        schemes={COLOR_SCHEMES}
        value={getCore().settings.userColorScheme(user.id)}
        allowDefault
        label={tScheme('own')}
        action={setUserColorScheme}
      />
      <TokensManager tokens={getCore().users.listTokens(user.id)} />
      <h2>{t('credentials')}</h2>
      <p className="muted">{t('credentialsIntro')}</p>
      <CredentialsManager names={credentialNames()} stored={getCore().credentials.names(user.id)} />
    </>
  );
}
