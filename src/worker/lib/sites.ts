import { WorkshopError, workshopAsk, type WorkshopConfig } from "./workshop.ts";
import type { ZipFile } from "./zip.ts";
import { b64u } from "./webauthn.ts";

/**
 * The sites folder (docker/workshop/sites.mjs): where a site a job built is
 * published, by a tap (tools/publish.ts), reached through the workshop's door.
 * A program in the workshop cannot reach it: it has no network, and not this
 * one's socket.
 */

export interface SiteView {
  name: string;
  /** When what is there was put there. */
  at: number;
  files: number;
  bytes: number;
  /** Taken down, with its last version kept. */
  down?: true;
  /** A version before this one, to put back, and when it was put there. */
  before?: number;
}

/** A site's name: the last part of its address. */
export const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const within = (seconds: number, stop?: AbortSignal) => (stop ? AbortSignal.any([AbortSignal.timeout(seconds * 1000), stop]) : AbortSignal.timeout(seconds * 1000));

/** What is published, and where it is seen; `taken`, names its folder has that are not its own. Null where there is no sites folder. */
export async function sitesOf(cfg: WorkshopConfig, stop?: AbortSignal): Promise<{ address: string | null; sites: SiteView[]; taken: string[] } | null> {
  try {
    return await workshopAsk<{ address: string | null; sites: SiteView[]; taken: string[] }>(cfg, "sites/list", {}, within(10, stop));
  } catch (e) {
    if (e instanceof WorkshopError) return null;
    throw e;
  }
}

/** Put there, whole or not at all; what was there is kept, to put back. `sum`: the zip it came from. Its address, where one is known. */
export async function sitePublish(cfg: WorkshopConfig, name: string, files: readonly ZipFile[], sum: string): Promise<{ address: string | null }> {
  return workshopAsk(cfg, "sites/publish", { name, sum, files: files.map((f) => ({ path: f.name, data: b64u(f.bytes) })) }, within(90));
}

/**
 * As it was before, which may be not there (`down`); what is there now is kept in its place, so this too can be put back.
 * `sum`: only while what that zip put there is what is there (a card's Put back, which is its card's alone).
 */
export async function siteBack(cfg: WorkshopConfig, name: string, sum?: string): Promise<{ address: string | null; down?: true }> {
  return workshopAsk(cfg, "sites/back", { name, ...(sum ? { sum } : {}) }, within(30));
}

/** Taken down, and kept, to put back. */
export async function siteDown(cfg: WorkshopConfig, name: string): Promise<void> {
  await workshopAsk(cfg, "sites/down", { name }, within(30));
}
