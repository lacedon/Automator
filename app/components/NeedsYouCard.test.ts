import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test, vi } from 'vitest';
import type { Watch } from '@core/index';
import en from '../../messages/en.json';
import { NeedsYouCard } from './NeedsYouCard';

vi.mock('../actions/watches', () => ({ resumeWatch: async () => null }));

test('links the scheduled Repository error result from the Needs you card', () => {
  const watch: Watch = {
    id: 1,
    kind: 'mr',
    targetUrl: 'https://gitlab.example.com/team/app/-/merge_requests/1',
    normalizedTarget: 'gitlab:gitlab.example.com/team/app!1',
    repository: 'app',
    name: null,
    title: 'Update app',
    state: 'needs_you',
    instructions: null,
    intervalMs: null,
    model: null,
    agentId: null,
    initialReview: null,
    mrSourceBranch: null,
    cursor: null,
    nextCheckAt: null,
    checkFailures: 0,
    needsYouReason:
      'Repository "app" is invalid: Folder does not exist: /work/app\n\nError result: /files/attempt/2026-11-03T20-00-00.000Z-123.json',
    needsYouSince: 1,
    needsYouRunId: null,
    precheckInstructions: null,
    precheckScript: null,
    precheckOutput: null,
    precheckProblem: null,
    resolutionNote: null,
    closedReason: null,
    closedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };

  const markup = renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: en,
      children: createElement(NeedsYouCard, { watch, event: null }),
    }),
  );

  expect(markup).toContain('Folder does not exist: /work/app');
  expect(markup).toContain('href="/files/attempt/2026-11-03T20-00-00.000Z-123.json"');
  expect(markup).toContain('View error result');
});
