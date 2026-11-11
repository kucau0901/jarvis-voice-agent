// Docker only: makes wrangler's dev proxy send a lost request once more.
//
// `wrangler dev` answers on the public port with a small proxy and runs Jarvis
// in a second process behind it. The connection between the two is closed
// after five seconds of quiet, and a request sent at that moment is lost
// before Jarvis sees it ("Network connection lost"). wrangler sends a lost GET
// again by itself, but not anything else, so now and then a question, a tap
// or an event from the house failed with a 500
// (https://github.com/cloudflare/workers-sdk/issues/14641).
//
// This gives every other method one more try, and only when the loss came
// within a second of sending: that is the closed connection, not Jarvis
// failing part way through an answer, which must not be run twice.
//
// It replaces exact text in the wrangler version the lockfile pins, and fails
// loudly when that text is not there: after a wrangler update, look at its
// ProxyWorker.js again. test/proxy-retry.test.ts checks it against the
// installed copy.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EDITS = [
  [
    `const attemptUserWorkerFetch = (attempt = 0) => void fetch(userWorkerUrl, new Request(request, { headers })).then(`,
    `const again = request.method === "GET" || request.method === "HEAD";
      // The first try uses up what was sent with the request: keep a copy for the second.
      const spare = again ? null : request.clone();
      let sentAt = 0;
      const attemptUserWorkerFetch = (attempt = 0) => void (sentAt = Date.now(), fetch(userWorkerUrl, new Request(attempt > 0 && spare ? spare : request, { headers }))).then(`,
  ],
  [
    `) && (request.method === "GET" || request.method === "HEAD") && attempt < 2) {`,
    `) && (again ? attempt < 2 : attempt < 1 && Date.now() - sentAt < 1e3 && /connection lost/i.test(String(error?.message)))) {`,
  ],
];

/** wrangler's ProxyWorker.js, with the second try for what is not a GET. */
export function withRetry(source) {
  let out = source;
  for (const [from, to] of EDITS) {
    if (out.split(from).length !== 2) throw new Error(`proxy-retry: wrangler's proxy has changed; expected once: ${from}`);
    out = out.replace(from, () => to);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  writeFileSync(file, withRetry(readFileSync(file, "utf8")));
  console.log(`proxy-retry: patched ${file}`);
}
