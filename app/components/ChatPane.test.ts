import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test, vi } from 'vitest';
import type { ThreadView } from '@core/index';
import en from '../../messages/en.json';
import { ChatPane, canClose } from './ChatPane';

vi.mock('../actions/chat', () => ({ sendRunMessage: async () => null }));
vi.mock('../actions/runs', () => ({ closeRun: async () => ({ ok: true }) }));

const run = { status: 'finished', outcome: null, error: null, closedAt: null } as const;

test('canClose is true only for open finished Needs you or Error Runs', () => {
  expect(canClose({ ...run, outcome: 'needs-you' })).toBe(true);
  expect(canClose({ ...run, error: { code: 'x', message: 'm' } })).toBe(true);
  expect(canClose({ ...run, outcome: 'acted' })).toBe(false);
  expect(canClose({ ...run, outcome: 'needs-you', closedAt: 1 })).toBe(false);
  expect(canClose({ ...run, status: 'running', outcome: 'needs-you' })).toBe(false);
});

function render(outcome: 'needs-you' | 'acted', closedAt: number | null) {
  const thread: ThreadView = {
    runs: [
      {
        id: 1,
        status: 'finished',
        outcome,
        request: 'r',
        ticketKey: null,
        summary: 's',
        error: null,
        closedAt,
        queuedAt: 1,
        endedAt: 2,
      },
    ],
    replyToRunId: null,
    replyBlockedReason: null,
  };
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: en,
      children: createElement(ChatPane, { thread, currentRunId: 1 }),
    }),
  );
}

test('renders the close button after the file links, only for a Needs you Run', () => {
  const markup = render('needs-you', null);
  expect(markup).toContain('Close chat');
  expect(markup.indexOf('Close chat')).toBeGreaterThan(markup.indexOf('Result JSON'));
  expect(render('acted', null)).not.toContain('Close chat');
  const closed = render('needs-you', 1);
  expect(closed).not.toContain('Close chat');
  expect(closed).toContain('Done');
});
