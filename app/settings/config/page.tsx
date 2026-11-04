import Link from 'next/link';
import path from 'node:path';
import { readEditableConfig } from '@core/index';
import { ConfigForm } from '../../components/ConfigForm';
import { ErrorBox } from '../../components/ErrorBox';
import { RestartApplicationButton } from '../../components/RestartApplicationButton';

export const dynamic = 'force-dynamic';

function configPath(): string {
  return path.resolve(process.env.AUTOMATOR_CONFIG ?? 'automator.config.json');
}

export default function ConfigurationSettingsPage() {
  let config;
  let error: string | null = null;
  try {
    config = readEditableConfig(configPath());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

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
      {error !== null ? <ErrorBox error={error} /> : config !== undefined && <ConfigForm initial={config} />}
      <section aria-labelledby="restart-application-heading">
        <h2 id="restart-application-heading" className="section-h">
          Restart application
        </h2>
        <p className="muted">Saved settings take effect after a restart. Active work will drain first.</p>
        <RestartApplicationButton />
      </section>
    </>
  );
}
