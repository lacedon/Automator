import { beforeEach, expect, test, vi } from 'vitest';

const session = vi.hoisted(() => ({ currentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const core = vi.hoisted(() => ({
  settings: { setApplicationColorScheme: vi.fn(), setUserColorScheme: vi.fn() },
}));
vi.mock('../lib/core', () => ({ getCore: () => core }));
vi.mock('../lib/session', () => session);
vi.mock('../lib/guard', () => guard);
vi.mock('../lib/audit', () => ({ audit: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { setApplicationColorScheme, setUserColorScheme } = await import('./colorScheme');

beforeEach(() => {
  vi.clearAllMocks();
  session.currentUser.mockResolvedValue({ id: 7 });
  guard.requireAdmin.mockResolvedValue({ ok: true, userId: 1 });
  core.settings.setApplicationColorScheme.mockReturnValue({ ok: true, value: undefined });
  core.settings.setUserColorScheme.mockReturnValue({ ok: true, value: undefined });
});

test('only administrators change the application default', async () => {
  guard.requireAdmin.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(await setApplicationColorScheme('light')).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(core.settings.setApplicationColorScheme).not.toHaveBeenCalled();

  guard.requireAdmin.mockResolvedValue({ ok: true, userId: 1 });
  expect(await setApplicationColorScheme('light')).toEqual({ ok: true });
  expect(core.settings.setApplicationColorScheme).toHaveBeenCalledWith('light');
  // The application default always names a scheme.
  expect((await setApplicationColorScheme(null)).ok).toBe(false);
});

test('a user stores their own scheme, or clears it with null, for themselves only', async () => {
  expect(await setUserColorScheme('light')).toEqual({ ok: true });
  expect(core.settings.setUserColorScheme).toHaveBeenCalledWith(7, 'light');
  expect(await setUserColorScheme(null)).toEqual({ ok: true });
  expect(core.settings.setUserColorScheme).toHaveBeenLastCalledWith(7, null);
});

test('signed-out callers cannot choose a scheme', async () => {
  session.currentUser.mockResolvedValue(null);
  expect(await setUserColorScheme('dark')).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(core.settings.setUserColorScheme).not.toHaveBeenCalled();
});
