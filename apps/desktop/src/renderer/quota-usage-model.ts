// Subscription usage presentation: meter percentages, clock times, the
// even-pace reference, the warning tone and the chart inks.
import { uiFormatLocale } from './i18n';
import { localDayKey } from './usage-stats-model';

/** A meter reading or a share of the limit: tenths below 10 %, whole above. */
export function quotaPercent(value: unknown): string {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount)) return '—';
  const rounded = Math.abs(amount) < 10 ? Math.round(amount * 10) / 10 : Math.round(amount);
  return `${rounded.toLocaleString(uiFormatLocale())}%`;
}

/** A clock time, dated once it is not today. */
export function quotaClock(time: number, now: number): string {
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (localDayKey(time) !== localDayKey(now)) {
    options.month = 'short';
    options.day = 'numeric';
  }
  return new Intl.DateTimeFormat(uiFormatLocale(), options).format(new Date(time));
}

/** Where an even pace through a window stands at `now`, in percent. */
export function quotaPace(startMs: number, endMs: number, now: number): number | null {
  if (!(endMs > startMs)) return null;
  return Math.min(100, Math.max(0, ((now - startMs) / (endMs - startMs)) * 100));
}

export type QuotaTone = '' | 'warning' | 'danger';

/** Danger once the window is nearly used up or forecast to run out before
 *  its reset; warning once it is past 70 % or well ahead of an even pace. */
export function quotaTone(used: number, paceDelta: number | null, runsOut: boolean): QuotaTone {
  if (runsOut || used >= 90) return 'danger';
  if (used >= 70 || (paceDelta !== null && paceDelta >= 10)) return 'warning';
  return '';
}

/** Chart ink of a model by its rank in the period: six inks, then one. */
export function quotaSeries(index: number): string {
  return index >= 0 && index < 6 ? String(index) : 'other';
}
