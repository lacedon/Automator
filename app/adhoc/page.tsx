import { getTranslations } from 'next-intl/server';
import { ActionErrorProvider } from '../components/ActionButton';
import { AdhocForm } from '../components/AdhocForm';
import { getCore } from '../lib/core';
import { currentScope } from '../lib/scope';

export const dynamic = 'force-dynamic';

export default async function AdhocPage() {
  const core = getCore();
  const t = await getTranslations('Adhoc');
  const scope = await currentScope();
  const { repositories, provider, models, defaultModel, byRepository, agents, agentAssignments } =
    core.read.formOptions(scope);
  return (
    <ActionErrorProvider>
      <h1 className="page-title">{t('title')}</h1>
      <AdhocForm options={{ repositories, provider, models, defaultModel, byRepository, agents, agentAssignments }} />
    </ActionErrorProvider>
  );
}
