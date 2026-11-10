import { beforeEach, expect, test, vi } from 'vitest';

const session = vi.hoisted(() => ({ sessionUser: vi.fn(), currentUser: vi.fn() }));
const core = vi.hoisted(() => ({
  users: { createToken: vi.fn(), regenerateToken: vi.fn(), revokeToken: vi.fn() },
}));
vi.mock('../lib/core', () => ({ getCore: () => core }));
vi.mock('../lib/session', () => session);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createToken, regenerateToken, revokeToken } = await import('./tokens');

beforeEach(() => {
  vi.clearAllMocks();
  session.sessionUser.mockResolvedValue(null);
  session.currentUser.mockResolvedValue({ id: 1 });
});

test('a bearer-token caller (no session) cannot create, regenerate or revoke tokens', async () => {
  for (const result of [await createToken('x', null), await regenerateToken(1), await revokeToken(1)]) {
    expect(result).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  }
  expect(core.users.createToken).not.toHaveBeenCalled();
  expect(core.users.regenerateToken).not.toHaveBeenCalled();
  expect(core.users.revokeToken).not.toHaveBeenCalled();
});
