import 'server-only';
import { bootstrap, type Core } from '@core/index';

// Stored on globalThis so Next dev HMR reuses one DB connection instead of opening a new one per reload.
const holder = globalThis as typeof globalThis & { __automatorCore?: Core };

export function getCore(): Core {
  holder.__automatorCore ??= bootstrap();
  return holder.__automatorCore;
}
