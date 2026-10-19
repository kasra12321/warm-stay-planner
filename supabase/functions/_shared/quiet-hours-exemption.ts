// Five-day exception requested for Star Wars Retreat on October 19, 2026.
const EXEMPT_HOME_ID = "01bdad24-80e3-4246-aef8-f5a93f26b2bf";
const STARTS_AT = Date.parse("2026-10-19T22:49:35Z");
const EXPIRES_AT = Date.parse("2026-10-24T22:49:35Z");

export function hasQuietHoursExemption(homeId: string, now = Date.now()): boolean {
  return homeId === EXEMPT_HOME_ID && now >= STARTS_AT && now < EXPIRES_AT;
}