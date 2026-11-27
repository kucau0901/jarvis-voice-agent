import { api } from "./key.ts";
import { desktop } from "./desktop.ts";

/**
 * Linking this computer for Jarvis to use (docs/DESIGN.md, "The Mac"). When
 * its person turns on "Let Jarvis control this Mac" in the desktop app, the
 * app asks this page, signed in as them, for a device of theirs that marks
 * the computer as one of their Macs. Its token is handed to the app once and
 * kept there, in the main process: this page never holds what runs commands.
 */

/** A name none of theirs has yet: "Mac mini", else "Mac mini 2", and so on. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const base = name.replace(/\s+/g, " ").trim().slice(0, 56) || "Mac";
  const have = new Set(taken.map((t) => t.toLowerCase()));
  if (!have.has(base.toLowerCase())) return base;
  let n = 2;
  while (have.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** Answers the desktop app's asking, where it asks (an app from before has no such call). */
export function linkComputers(key: () => string): void {
  const d = desktop;
  if (!d?.onLinkComputer || !d.computerLinked) return;
  const linked = d.computerLinked.bind(d);
  d.onLinkComputer((name) => {
    void (async () => {
      try {
        const now = (await api(key(), "GET", "/api/v1/devices")) as { devices: { name: string; revokedAt?: number }[]; scopes: string[] };
        if (!now.scopes.includes("*") && !now.scopes.includes("computer")) {
          return linked({ error: "Using your Mac has not been given to you: an admin gives it in Family." });
        }
        const made = (await api(key(), "POST", "/api/v1/devices", {
          name: uniqueName(name, now.devices.filter((x) => !x.revokedAt).map((x) => x.name)),
          scopes: ["alerts", "computer"],
        })) as { token?: unknown };
        if (typeof made.token !== "string") throw new Error("no token came back");
        linked({ token: made.token });
      } catch (e) {
        linked({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}
