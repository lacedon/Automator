import { beforeEach, expect, test, vi } from 'vitest';

const guard = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const core = vi.hoisted(() => ({
  users: { create: vi.fn(), setDisabled: vi.fn() },
  access: { assign: vi.fn(), deleteRole: vi.fn() },
}));
vi.mock('../lib/core', () => ({ getCore: () => core }));
vi.mock('../lib/guard', () => guard);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createUser, setUserDisabled, assignRole, deleteRole } = await import('./access');

let log: { mock: { calls: unknown[][] } };
const lines = () => log.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  guard.requireAdmin.mockResolvedValue({ ok: true, userId: 1 });
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

test('a successful change is audited with its operation, targets and outcome', async () => {
  core.access.assign.mockReturnValue({ ok: true, value: 5 });
  await assignRole(2, 3, null);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toMatch(/audit: role assigned actor=1 user=2 role=3 project=null outcome="success"$/);
});

test('a failed or rejected change records the failure, not success', async () => {
  core.access.deleteRole.mockReturnValue({ ok: false, error: { code: 'NOT_FOUND' } });
  await deleteRole(9);
  await setUserDisabled(1, true);
  await deleteRole(-1);
  expect(lines()[0]).toContain('role deleted actor=1 role=9 outcome="rejected:NOT_FOUND"');
  expect(lines()[1]).toContain('user disabled actor=1 user=1 outcome="rejected:INVALID_INPUT"');
  expect(lines()[2]).toContain('outcome="rejected:INVALID_INPUT"');
  expect(core.users.setDisabled).not.toHaveBeenCalled();
});

test('the password never reaches the log', async () => {
  core.users.create.mockReturnValue({ ok: true, value: 4 });
  await createUser('alice', 'hunter2-secret');
  expect(lines()[0]).toContain('user created actor=1 username="alice"');
  expect(lines().join('\n')).not.toContain('hunter2-secret');
});

test('nothing is audited for a caller who is not an administrator', async () => {
  guard.requireAdmin.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(await deleteRole(1)).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(log).not.toHaveBeenCalled();
});
