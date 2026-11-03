import Link from 'next/link';
import path from 'node:path';
import { readEditableConfig } from '@core/index';
import { ConfigForm } from '../../components/ConfigForm';
import { ErrorBox } from '../../components/ErrorBox';

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
      {error !== null ? <ErrorBox error={error} /> : config !== undefined && <ConfigForm initial={config} />}
    </>
  );
}
