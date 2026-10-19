import { describe, expect, it } from "vitest";
import { hasQuietHoursExemption } from "../../supabase/functions/_shared/quiet-hours-exemption";

describe("temporary quiet-hours exemption", () => {
  const starWars = "01bdad24-80e3-4246-aef8-f5a93f26b2bf";
  const start = Date.parse("2026-10-19T22:49:35Z");
  const end = Date.parse("2026-10-24T22:49:35Z");

  it("lifts restrictions for Star Wars Retreat for exactly five days", () => {
    expect(end - start).toBe(5 * 24 * 60 * 60 * 1000);
    expect(hasQuietHoursExemption(starWars, start)).toBe(true);
    expect(hasQuietHoursExemption(starWars, end - 1)).toBe(true);
    expect(hasQuietHoursExemption(starWars, start - 1)).toBe(false);
    expect(hasQuietHoursExemption(starWars, end)).toBe(false);
  });

  it("does not exempt other properties", () => {
    expect(hasQuietHoursExemption("other-home", start)).toBe(false);
  });
});