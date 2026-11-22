import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test } from 'vitest';
import type { RunRow } from '@core/index';
import en from '../../messages/en.json';
import { RunsTable } from './RunsTable';

const row = (overrides: Partial<RunRow>): RunRow => ({
  id: 1,
  watchId: null,
  watchTitle: null,
  adhocPrompt: 'hi',
  ticket: null,
  repository: 'pages',
  provider: 'pi',
  trigger: 'adhoc',
  status: 'finished',
  queuedAt: 1,
  startedAt: 1,
  endedAt: 2,
  tookMs: 1,
  outcome: 'done',
  resultStatus: 'success',
  interrupted: null,
  closedAt: null,
  summary: 's',
  error: null,
  transcriptPath: null,
  resultPath: null,
  chatState: null,
  ...overrides,
});

const render = (runs: RunRow[]) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: en,
      children: createElement(RunsTable, { runs }),
    }),
  );

test('a Chat waiting for an answer shows the Waiting for you pill instead of its outcome', () => {
  const html = render([row({ id: 1, chatState: 'waiting' }), row({ id: 2, chatState: 'idle' })]);
  expect(html.match(/pill-needs-you">Waiting for you/g)).toHaveLength(1);
  expect(html).toContain('pill-good">Replied');
});
