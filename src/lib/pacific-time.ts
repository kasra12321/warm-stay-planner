/**
 * All business logic uses America/Los_Angeles timezone.
 */

export function getPacificNow(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  );
}

export function getPacificHour(): number {
  return getPacificNow().getHours();
}

export function getTodayPacific(): string {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export function isSameDayWarning(dateStr: string): boolean {
  const today = getTodayPacific();
  if (dateStr !== today) return false;
  return getPacificHour() >= 12;
}

export function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
