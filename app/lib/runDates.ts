type RunDates =
  { ok: true; startedFrom: number | undefined; startedBefore: number | undefined } | { ok: false; error: string };

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(`${value}T00:00:00`);
  return date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day ? date : null;
}

export function runDates(from: string, to: string): RunDates {
  const first = from ? calendarDate(from) : undefined;
  const last = to ? calendarDate(to) : undefined;
  if (first === null || last === null) return { ok: false, error: 'Enter valid dates in YYYY-MM-DD format.' };
  if (first && last && first > last) return { ok: false, error: 'From must be on or before To.' };
  // Calendar arithmetic keeps the final day inclusive across daylight-saving changes.
  if (last) last.setDate(last.getDate() + 1);
  return { ok: true, startedFrom: first?.getTime(), startedBefore: last?.getTime() };
}
