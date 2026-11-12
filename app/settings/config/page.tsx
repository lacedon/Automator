import Link from 'next/link';
import path from 'node:path';
import { getTranslations } from 'next-intl/server';
import { readEditableConfig } from '@core/index';
import { ConfigForm } from '../../components/ConfigForm';
import { ErrorBox } from '../../components/ErrorBox';
import { RestartApplicationButton } from '../../components/RestartApplicationButton';
import { UpgradeAndRestartButton } from '../../components/UpgradeAndRestartButton';
import { SettingsDialog } from '../../components/SettingsDialog';
import { SettingsTable, SettingsTableRow } from '../../components/SettingsTable';
import { providerLabel } from '../../lib/providerLabel';

export const dynamic = 'force-dynamic';

function configPath(): string {
  return path.resolve(process.env.AUTOMATOR_CONFIG ?? 'automator.config.json');
}

export default async function ConfigurationSettingsPage() {
  const t = await getTranslations('ConfigPage');
  let loadedConfig: ReturnType<typeof readEditableConfig> | undefined;
  let error: string | null = null;
  try {
    loadedConfig = readEditableConfig(configPath());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const config = loadedConfig;
  return (
    <>
      <h1 className="page-title">{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <p>
        <Link href="/settings/agents">{t('agentSettings')}</Link>
      </p>
      <p>
        <Link href="/settings/repositories">{t('repositorySettings')}</Link>
      </p>
      {error !== null ? (
        <ErrorBox error={error} />
      ) : (
        config !== undefined && (
          <>
            <div className="settings-toolbar">
              <SettingsDialog title={t('editTitle')} trigger={t('open')} wide>
                <p className="muted">{t('restartNote')}</p>
                <ConfigForm initial={config} />
              </SettingsDialog>
            </div>
            <SettingsTable label={t('tableLabel')} headers={[t('setting'), t('value')]}>
              {Object.entries(config).map(([key, value]) => (
                <SettingsTableRow
                  key={key}
                  name={key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())}
                >
                  <span className="muted">
                    {key === 'provider'
                      ? providerLabel(config.provider)
                      : typeof value === 'object' && value !== null
                        ? t('configured', { count: Object.keys(value).length })
                        : String(value)}
                  </span>
                </SettingsTableRow>
              ))}
            </SettingsTable>
          </>
        )
      )}
      <section aria-labelledby="restart-application-heading">
        <h2 id="restart-application-heading" className="section-h">
          {t('restartHeading')}
        </h2>
        <p className="muted">{t('restartText')}</p>
        <RestartApplicationButton />
      </section>
      <section aria-labelledby="upgrade-application-heading">
        <h2 id="upgrade-application-heading" className="section-h">
          {t('upgradeHeading')}
        </h2>
        <p className="muted">{t.rich('upgradeText', { code: (chunks) => <code>{chunks}</code> })}</p>
        <UpgradeAndRestartButton />
      </section>
    </>
  );
}
