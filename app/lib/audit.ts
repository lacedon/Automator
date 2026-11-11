// Security events go to the process log only; they are deliberately not stored in the database or shown in the UI.
export function audit(event: string, details: Record<string, string | number | null> = {}): void {
  const fields = Object.entries(details).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`${new Date().toISOString()} audit: ${[event, ...fields].join(' ')}`);
}
