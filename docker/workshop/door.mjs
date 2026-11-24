// The one way into the workshop (runner.mjs): it lives in Jarvis's own network, where nothing is published, and passes
// on to the workshop's Unix socket only what Jarvis asks, with their shared token.
//
// Jarvis's browser shares that network, and a page it opened can send a request to 127.0.0.1. A browser says so of
// itself (Origin, Sec-Fetch-Site…), and cannot be told not to: such a request is refused, token or not. Not
// Sec-Fetch-Mode, which Node says of its own.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

export const PORT = 9377;
const MIN_TOKEN = 24;

const digest = (s) => createHash("sha256").update(s).digest();

/** Why a request is turned away; null when it may pass. */
export function refusal(req, token) {
  const h = req.headers;
  if (h.origin !== undefined || h.referer !== undefined || Object.keys(h).some((k) => k.startsWith("sec-") && k !== "sec-fetch-mode")) return [403, "not for a browser"];
  if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(h.host ?? "")) return [403, "not by that name"];
  const said = /^Bearer (.+)$/.exec(h.authorization ?? "")?.[1] ?? "";
  if (token.length < MIN_TOKEN || !timingSafeEqual(digest(said), digest(token))) return [401, "the workshop's token is missing or wrong"];
  return null;
}

export function door({ socket, token }) {
  return (req, res) => {
    const no = refusal(req, token);
    const json = (status, error) => {
      if (res.headersSent || res.destroyed) return res.destroy();
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error }));
    };
    if (no) return json(...no);
    const { authorization: _a, host: _h, connection: _c, ...headers } = req.headers;
    const up = request({ socketPath: socket, path: req.url, method: req.method, headers: { ...headers, host: "workshop" } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.on("error", () => res.destroy()).pipe(res);
    });
    up.on("error", () => json(502, "the workshop is not running"));
    // Whoever asked has gone: the workshop is told (runner.mjs stops what it ran).
    res.on("close", () => !res.writableEnded && up.destroy());
    req.on("error", () => up.destroy()).pipe(up);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env.WORKSHOP_TOKEN ?? "";
  if (token.length < MIN_TOKEN) {
    console.error(`workshop door: set WORKSHOP_TOKEN, ${MIN_TOKEN} characters or more, in .env`);
    process.exit(1);
  }
  const server = createServer(door({ socket: "/run/workshop/sock", token }));
  server.requestTimeout = 0;
  server.listen(PORT, "127.0.0.1", () => console.log("workshop door: open"));
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(0));
}
