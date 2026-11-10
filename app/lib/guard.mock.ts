// Test double for ./guard: every check passes, as the signed-in user 1.
const allow = async () => ({ ok: true as const, userId: 1 });
const yes = async () => true;

export const allowAll = {
  requireAdmin: allow,
  requireWriteOnRepository: allow,
  requireWriteOnWatch: allow,
  requireWriteOnRun: allow,
  canReadWatch: yes,
  canReadRun: yes,
  canReadGlobally: yes,
};
