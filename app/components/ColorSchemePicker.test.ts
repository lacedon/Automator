import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test, vi } from 'vitest';
import { COLOR_SCHEMES, type ColorScheme } from '@core/index';
import en from '../../messages/en.json';
import { ColorSchemePicker } from './ColorSchemePicker';

vi.mock('next/navigation', () => ({ unstable_rethrow: vi.fn() }));

const render = (props: Partial<Parameters<typeof ColorSchemePicker>[0]>) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: en,
      children: createElement(ColorSchemePicker, {
        schemes: COLOR_SCHEMES,
        value: 'dark',
        label: 'Scheme',
        action: async () => ({ ok: true as const }),
        ...props,
      }),
    }),
  );

test('shows each registered scheme with its three main colors and marks the chosen one', () => {
  const html = render({ value: 'light' });
  for (const scheme of COLOR_SCHEMES) {
    expect(html).toContain(scheme.label);
    for (const color of Object.values(scheme.colors)) expect(html).toContain(`background:${color}`);
  }
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-pressed="true"[^>]*>(<span[^>]*>(<span[^>]*><\/span>)+<\/span>)Light/);
});

test('a scheme added to the registry appears without any picker change', () => {
  const sepia: ColorScheme = {
    id: 'sepia',
    label: 'Sepia',
    colors: { bg: '#f4ecd8', text: '#5b4636', primary: '#8a5a2b' },
  };
  const html = render({ schemes: [...COLOR_SCHEMES, sepia] });
  expect(html).toContain('Sepia');
  expect(html).toContain('background:#f4ecd8');
});

test('offers "use application default" only when allowed, selected when there is no own choice', () => {
  expect(render({})).not.toContain('Use application default');
  const html = render({ allowDefault: true, value: null });
  expect(html).toContain('Use application default');
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-pressed="true"[^>]*>Use application default/);
});
