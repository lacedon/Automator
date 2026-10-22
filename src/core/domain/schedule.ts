import type { Config } from '../config/schema';
import type { Watch } from './types';

type WorkingHours = Config['schedule']['workingHours'];

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function isWithinWorkingHours(t: number, wh: WorkingHours): boolean {
  const d = new Date(t);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return wh.days.includes(d.getDay()) && minutes >= minutesOf(wh.start) && minutes < minutesOf(wh.end);
}

export function nextWindowStart(t: number, wh: WorkingHours): number {
  if (isWithinWorkingHours(t, wh)) return t;
  const start = minutesOf(wh.start);
  if (start >= minutesOf(wh.end)) throw new Error(`Working hours ${wh.start}-${wh.end} define no window`);
  const from = new Date(t);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + offset,
      Math.floor(start / 60),
      start % 60,
    );
    if (wh.days.includes(candidate.getDay()) && candidate.getTime() > t) return candidate.getTime();
  }
  throw new Error('Working hours define no working days');
}

export function intervalFor(watch: Pick<Watch, 'kind' | 'intervalMs'>, config: Config): number {
  if (watch.intervalMs !== null) return watch.intervalMs;
  return watch.kind === 'mr' ? config.schedule.intervals.mr : config.schedule.intervals.default;
}
