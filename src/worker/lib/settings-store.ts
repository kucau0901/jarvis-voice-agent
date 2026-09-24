import type { Env } from "../types";
import { stateStub } from "./state-client.ts";
import { effectiveEnv, type Changes, type SavedSettings } from "./settings.ts";

/**
 * Reading and writing the settings saved in the panel.
 *
 * Every authenticated request needs them, so they are cached per isolate for a
 * few seconds rather than fetched from the Durable Object each time. The
 * isolate that saves refreshes its own copy at once; others catch up within
 * CACHE_MS. That is the whole of the delay after pressing Save.
 */
const CACHE_MS = 15_000;
let cache: { at: number; saved: SavedSettings } | null = null;

export async function loadSaved(env: Env): Promise<SavedSettings> {
  const state = stateStub(env);
  if (!state) return {};
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.saved;
  try {
    const saved = await state.getSettings();
    cache = { at: Date.now(), saved };
    return saved;
  } catch (e) {
    // A storage blip must not take every request down: use the last copy this
    // isolate saw, else run on the deployment's own values.
    console.warn("settings unavailable:", e instanceof Error ? e.message : String(e));
    return cache?.saved ?? {};
  }
}

/** The environment every route sees: the Worker's own, with saved settings on top. */
export async function withSettings(env: Env): Promise<Env> {
  return effectiveEnv(env, await loadSaved(env));
}

export async function saveSettings(env: Env, changes: Changes): Promise<SavedSettings> {
  const state = stateStub(env);
  if (!state) throw new Error("settings storage is not bound (STATE)");
  const saved = await state.putSettings(changes);
  cache = { at: Date.now(), saved };
  return saved;
}

/** For tests: forget the cached copy. */
export function _resetSettingsCache(): void {
  cache = null;
}
