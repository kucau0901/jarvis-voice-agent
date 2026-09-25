import type { Env } from "../types";
import { json } from "../lib/http";
import { updateRepo, versionInfo } from "../lib/version";
import pkg from "../../../package.json";

/** This copy's version: package.json's, set by `npm run release` (docs/RELEASING.md). */
export const JARVIS_VERSION: string = pkg.version;

/** GET /api/version: the running version, and whether a newer release is out (lib/version.ts). */
export async function handleVersion(env: Env): Promise<Response> {
  const repo = updateRepo(env.UPDATE_REPO, pkg.repository?.url);
  return json(await versionInfo(env.CONFIG, JARVIS_VERSION, repo));
}
