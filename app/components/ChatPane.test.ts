import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test, vi } from 'vitest';
import type { ThreadView } from '@core/index';
import en from '../../messages/en.json';
import { formatFullDateTime } from '../lib/format';
import { ChatPane, canClose } from './ChatPane';

vi.mock('../actions/chat', () => ({
  sendRunMessage: async () => null,
  branchRun: async () => null,
  closeChat: async () => ({ ok: true }),
  answerQuestion: async () => null,
  cancelChatTimer: async () => ({ ok: true }),
}));
vi.mock('../actions/runs', () => ({ closeRun: async () => ({ ok: true }) }));

const run = { status: 'finished', outcome: null, error: null, interrupted: null, closedAt: null } as const;

test('canClose is true only for open finished Needs you or Error Runs', () => {
  expect(canClose({ ...run, outcome: 'needs-you' })).toBe(true);
  expect(canClose({ ...run, error: { code: 'x', message: 'm' } })).toBe(true);
  expect(canClose({ ...run, outcome: 'acted' })).toBe(false);
  expect(canClose({ ...run, outcome: 'needs-you', closedAt: 1 })).toBe(false);
  expect(canClose({ ...run, interrupted: 'timeout', error: { code: 'x', message: 'm' } })).toBe(false);
  expect(canClose({ ...run, status: 'running', outcome: 'needs-you' })).toBe(false);
});

function render(
  outcome: 'needs-you' | 'acted' | 'done',
  closedAt: number | null,
  branchedFromRunId: number | null = null,
  chat: ThreadView['chat'] = {
    mode: 'follow-up',
    sessionId: null,
    state: null,
    canClose: false,
    question: null,
    timer: null,
    nativeTimers: false,
  },
  runOverrides: Partial<ThreadView['runs'][number]> = {},
) {
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
        interrupted: null,
        closedAt,
        queuedAt: 1,
        endedAt: 2,
        trigger: 'adhoc',
        transcript: null,
        ...runOverrides,
      },
    ],
    replyToRunId: null,
    replyBlockedReason: null,
    branchedFromRunId,
    chat,
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

test('offers a Branch action on a finished response and links a branched chat to its origin', () => {
  expect(render('acted', null)).toContain('>Branch<');
  expect(render('acted', null)).not.toContain('Branched from');
  const branched = render('acted', null, 7);
  expect(branched).toContain('Branched from Run #7');
  expect(branched).toContain('href="/runs/7"');
});

test('shows a muted mode label for ad-hoc chats', () => {
  expect(render('acted', null)).toContain('Follow-up mode');
});

const interactive = (state: 'live' | 'stopped' | 'closing' | 'closed', canClose: boolean): ThreadView['chat'] => ({
  mode: 'interactive',
  sessionId: 3,
  state,
  canClose,
  question: null,
  timer: null,
  nativeTimers: false,
});

test('interactive chats show the session state and a Close chat button while closable', () => {
  const live = render('done', null, null, interactive('live', true));
  expect(live).toContain('Session running');
  expect(live).toContain('Close chat');
  expect(live).toContain('Replied');
  expect(render('done', null, null, interactive('stopped', true))).toContain('it resumes on your next message');
  expect(render('done', null, null, interactive('closing', false))).toContain('Closing…');
  const closed = render('done', null, null, interactive('closed', false));
  expect(closed).toContain('Chat closed');
  expect(closed).not.toContain('Close chat');
  expect(render('done', null, null, interactive('live', false))).not.toContain('Close chat');
});

test('Follow-up chats show no session state or Close chat for a done Run', () => {
  const markup = render('acted', null);
  expect(markup).not.toContain('Session running');
  expect(markup).not.toContain('Close chat');
});

const question = (overrides: Partial<NonNullable<ThreadView['chat']['question']>> = {}) => ({
  text: 'Which <b>color</b>?',
  options: ['Red', 'Blue'] as string[] | null,
  source: 'automator' as const,
  requestId: 'q1',
  runId: 1,
  askedAt: 1,
  expiresAt: 2,
  expiredAt: null as number | null,
  ...overrides,
});

const waiting = (q: ReturnType<typeof question>): ThreadView['chat'] => ({
  ...interactive('live', false),
  question: q,
});

test('a pending question replaces the composer with choice buttons and an Other answer input', () => {
  const markup = render('done', null, null, waiting(question()));
  expect(markup).toContain('Waiting for you');
  // Plain text node: the markup in the question is escaped, never rendered.
  expect(markup).toContain('Which &lt;b&gt;color&lt;/b&gt;?');
  expect(markup).not.toContain('<b>color</b>');
  expect(markup).toContain('>Red</button>');
  expect(markup).toContain('>Blue</button>');
  expect(markup).toContain('Other answer');
  expect(markup).toContain('Send answer');
  expect(markup).not.toContain('id="chat-message"');
});

test('the question card is labelled by the question text and its field by its own label, with generated ids', () => {
  const markup = render('done', null, null, waiting(question()));
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
  expect(labelledBy).toBeDefined();
  expect(markup).toMatch(new RegExp(`<p id="${labelledBy!.replace(/:/g, ':')}"[^>]*>Which`));
  const htmlFor = /<label for="([^"]+)"/.exec(markup)?.[1];
  expect(markup).toContain(`id="${htmlFor}"`);
  expect(htmlFor).not.toBe('question-answer');
  expect(markup).toContain('tabindex="-1"');
});

test('a free-text question shows a text field and no choice buttons', () => {
  const markup = render('done', null, null, waiting(question({ options: null })));
  expect(markup).toContain('Waiting for you');
  expect(markup).toContain('Your answer');
  expect(markup).not.toContain('Other answer');
  expect(markup).not.toContain('>Red</button>');
  expect(markup).toContain('Send answer');
});

test('an expired question says the answer starts a new turn', () => {
  const markup = render('done', null, null, waiting(question({ expiredAt: 5 })));
  expect(markup).toContain('stopped waiting');
  expect(render('done', null, null, waiting(question()))).toContain('is waiting for your answer');
});

test('without a question the composer is not replaced', () => {
  const thread = render('done', null, null, interactive('live', false));
  expect(thread).not.toContain('Waiting for you');
  expect(thread).not.toContain('Send answer');
});

const FIRE_AT = Date.parse('2026-10-21T15:30:00');
const withTimer = (overrides: Partial<ThreadView['chat']> = {}): ThreadView['chat'] => ({
  ...interactive('live', true),
  timer: { fireAt: FIRE_AT, message: 'check <b>the build</b>', createdAt: 1 },
  ...overrides,
});

test('a pending wake-up is listed with its fire time, message and a Cancel action', () => {
  const markup = render('done', null, null, withTimer());
  expect(markup).toContain('Wake-up scheduled');
  expect(markup).toContain(formatFullDateTime(FIRE_AT, 'en'));
  // Plain text node: never rendered as HTML.
  expect(markup).toContain('check &lt;b&gt;the build&lt;/b&gt;');
  expect(markup).not.toContain('<b>the build</b>');
  expect(markup).toContain('>Cancel wake-up</button>');
  expect(markup).toContain('Cancel this wake-up?'); // the ConfirmDialog message
});

test('without a pending wake-up no timer card is shown', () => {
  expect(render('done', null, null, interactive('live', true))).not.toContain('Wake-up scheduled');
});

test('the native-timer warning is shown only for providers with native timers', () => {
  const warned = render('done', null, null, { ...interactive('live', true), nativeTimers: true });
  expect(warned).toContain('are lost if this session&#x27;s process stops');
  expect(warned).toContain('Automator wake-ups');
  expect(render('done', null, null, interactive('live', true))).not.toContain('are lost if this session');
  expect(render('acted', null)).not.toContain('are lost if this session');
});

test('agent and timer turns are labelled', () => {
  const agent = render('done', null, null, interactive('live', true), { trigger: 'agent', request: null });
  expect(agent).toContain('Started by the agent (built-in timer)');
  const timer = render('done', null, null, interactive('live', true), {
    trigger: 'timer',
    request: 'Scheduled wake-up (set 2026-10-21T10:00:00.000Z):\n\ncheck the build',
  });
  expect(timer).toContain('Scheduled wake-up');
  expect(timer).toContain('check the build');
  const plain = render('done', null, null, interactive('live', true));
  expect(plain).not.toContain('Started by the agent');
});
