import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import register from "../src/index";

/**
 * The event union differs between the two hosts this extension runs on, and
 * `ExtensionAPI.on` is a permissive `on(event: string, handler)` at runtime on
 * BOTH of them: registering an event the host never emits fails silently. A
 * handler that quietly never fires is worse than no handler, so the set of
 * registered events is pinned here.
 *
 * OMP's own union is read from the installed package when it is present, so a
 * future OMP release that drops one of these events fails this test instead of
 * silently disabling the behaviour.
 */

/** Events both hosts emit — these must stay on the typed `pi.on` overloads. */
const PORTABLE_EVENTS = ["session_start", "turn_start", "session_shutdown"];
/** Emitted by legacy Pi only; OMP removed it. */
const PI_ONLY_EVENTS = ["model_select"];
/** Emitted by OMP only; legacy Pi has no equivalent. */
const OMP_ONLY_EVENTS = ["credential_disabled"];

function registeredEvents(): string[] {
  const events: string[] = [];
  const pi = {
    on(event: string) {
      events.push(event);
    },
    registerCommand() {},
    registerTool() {},
  };
  register(pi as unknown as Parameters<typeof register>[0]);
  return events;
}

describe("host event registration", () => {
  const events = registeredEvents();

  test("registers every portable event", () => {
    for (const event of PORTABLE_EVENTS) expect(events).toContain(event);
  });

  test("registers the host-specific events", () => {
    for (const event of [...PI_ONLY_EVENTS, ...OMP_ONLY_EVENTS]) {
      expect(events).toContain(event);
    }
  });

  test("registers no event outside the pinned set", () => {
    const known = new Set([
      ...PORTABLE_EVENTS,
      ...PI_ONLY_EVENTS,
      ...OMP_ONLY_EVENTS,
    ]);
    expect(events.filter((event) => !known.has(event))).toEqual([]);
  });

  test("OMP still emits the events we rely on", () => {
    let types: string;
    try {
      types = readFileSync(
        join(
          import.meta.dir,
          "..",
          "node_modules",
          "@oh-my-pi",
          "pi-coding-agent",
          "dist",
          "types",
          "extensibility",
          "extensions",
          "types.d.ts",
        ),
        "utf8",
      );
    } catch {
      return; // OMP not installed in this checkout; nothing to verify against.
    }

    const declared = new Set(
      [...types.matchAll(/on\(event: "([^"]+)"/g)].map((m) => m[1] as string),
    );
    expect(declared.size).toBeGreaterThan(0);

    for (const event of [...PORTABLE_EVENTS, ...OMP_ONLY_EVENTS]) {
      expect(declared).toContain(event);
    }
    // Guards the reason `model_select` is registered through the untyped path.
    for (const event of PI_ONLY_EVENTS) {
      expect(declared).not.toContain(event);
    }
  });
});
