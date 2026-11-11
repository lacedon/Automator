import Link from 'next/link';
import path from 'node:path';
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

export default function ConfigurationSettingsPage() {
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
      <h1 className="page-title">Configuration</h1>
      <p className="muted">
        Edit non-secret application settings. Credential values and environment bindings are managed outside this form.
      </p>
      <p>
        <Link href="/settings/agents">Open Agent Settings →</Link>
      </p>
      <p>
        <Link href="/settings/repositories">Open Repository Settings →</Link>
      </p>
      {error !== null ? (
        <ErrorBox error={error} />
      ) : (
        config !== undefined && (
          <>
            <div className="settings-toolbar">
              <SettingsDialog title="Edit Configuration" trigger="Open configuration" wide>
                <p className="muted">Saved application settings take effect after a restart.</p>
                <ConfigForm initial={config} />
              </SettingsDialog>
            </div>
            <SettingsTable label="Configuration" headers={['Setting', 'Value']}>
              {Object.entries(config).map(([key, value]) => (
                <SettingsTableRow
                  key={key}
                  name={key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())}
                >
                  <span className="muted">
                    {key === 'provider'
                      ? providerLabel(config.provider)
                      : typeof value === 'object' && value !== null
                        ? `${Object.keys(value).length} configured settings`
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
          Restart application
        </h2>
        <p className="muted">Saved settings take effect after a restart. Active work will drain first.</p>
        <RestartApplicationButton />
      </section>
      <section aria-labelledby="upgrade-application-heading">
        <h2 id="upgrade-application-heading" className="section-h">
          Upgrade application
        </h2>
        <p className="muted">
          Runs <code>npm run upgrade-and-restart</code> in the Automator checkout. Not available while Runs are active
          or queued.
        </p>
        <UpgradeAndRestartButton />
      </section>
    </>
  );
}
