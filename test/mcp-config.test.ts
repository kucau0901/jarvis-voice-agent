import { readFileSync } from "node:fs";
import { MASK, expandTemplate, maskForUi, resolveConfigured, restoreMasked, sane, unexpand } from "../src/worker/lib/mcp-config.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

/** The real seed, read from disk: these tests are about the file that ships. */
const SEED = (JSON.parse(readFileSync(new URL("../config/mcp-servers.json", import.meta.url), "utf8")) as {
  servers: unknown[];
}).servers;

/** Exactly what KV held on 23 September 2026, when the panel showed nothing. */
const LIVE_KV = { servers: [] };

const HA = { label: "home-assistant", url: "${HA_MCP_URL}", allowedTools: ["ha_search"], enabled: true };
const OTHER = { label: "weather", url: "https://example.com/mcp", enabled: true };

console.log("the case that was broken");
{
  const r = resolveConfigured(LIVE_KV, SEED);
  check("an empty saved list resolves to the defaults", r.source === "default", r.source);
  check("so the panel shows the Home Assistant server", r.servers.length === 1 && r.servers[0]!.label === "home-assistant", r.servers);
  check("with its URL as a placeholder, not the secret", r.servers[0]!.url === "${HA_MCP_URL}");
  check("and its tool allowlist", r.servers[0]!.allowedTools?.length === 11, r.servers[0]!.allowedTools);
}

console.log("\nresolution");
{
  check("nothing saved is the defaults", resolveConfigured(null, SEED).source === "default");
  check("a saved list wins", resolveConfigured({ servers: [OTHER] }, SEED).source === "saved");
  check("and replaces the defaults rather than adding to them",
    JSON.stringify(resolveConfigured({ servers: [OTHER] }, SEED).servers.map((s) => s.label)) === '["weather"]');
  // How a server is switched off. If this fell back to the defaults, unticking
  // the only server would silently turn it back on.
  const off = resolveConfigured({ servers: [{ ...HA, enabled: false }] }, SEED);
  check("a saved list holding one DISABLED server is honoured, not replaced",
    off.source === "saved" && off.servers[0]!.enabled === false, off);
  check("a saved list of nothing usable is the defaults",
    resolveConfigured({ servers: [{ label: "x", url: "http://insecure" }] }, SEED).source === "default");
  check("garbage in KV is the defaults",
    resolveConfigured("nonsense", SEED).source === "default" &&
    resolveConfigured({ servers: "nope" }, SEED).source === "default");
}

console.log("\nmasking for the panel");
{
  const inline = { ...OTHER, headers: { Authorization: "Bearer sk-live-secret" } };
  const placeholder = { ...OTHER, headers: { Authorization: "Bearer ${WEATHER_TOKEN}" } };
  const [a] = maskForUi(sane([inline]));
  const [b] = maskForUi(sane([placeholder]));
  check("an inline secret is masked", a!.headers!.Authorization === "***", a);
  check("a placeholder is shown — it names a secret, it is not one", b!.headers!.Authorization === "Bearer ${WEATHER_TOKEN}", b);
  const src = sane([inline]);
  maskForUi(src);
  check("masking does not touch the input", src[0]!.headers!.Authorization === "Bearer sk-live-secret");
}

console.log("\nsaving what the panel now shows keeps the safety allowlist");
{
  /*
   * HA offers 86 tools; the seed allows 11, because the rest are config, file
   * and system administration. Now that the panel shows the seed, pressing
   * Save writes it to KV — so the round trip must carry the allowlist, or one
   * innocent Save would open all 86 to the car.
   */
  const shown = maskForUi(resolveConfigured(LIVE_KV, SEED).servers);
  const saved = sane(JSON.parse(JSON.stringify(shown)));
  const after = resolveConfigured({ servers: saved }, SEED);
  check("after a Save it is the saved list", after.source === "saved");
  check("the allowlist survives the round trip",
    JSON.stringify(after.servers[0]!.allowedTools) === JSON.stringify(resolveConfigured(null, SEED).servers[0]!.allowedTools),
    after.servers[0]!.allowedTools);
  check("the URL is still the placeholder", after.servers[0]!.url === "${HA_MCP_URL}");
}

console.log("\nthe Test button and secret-backed URLs");
{
  const env = { HA_MCP_URL: "https://hooks.nabu.casa/gAAAAABsecretwebhookpath", SHORT: "abc" };
  // The seeded server is "${HA_MCP_URL}". Its Test button used to reject it
  // outright, because only headers were expanded, not the URL.
  check("a placeholder URL expands to the real one",
    expandTemplate("${HA_MCP_URL}", env) === env.HA_MCP_URL);
  check("an unset secret expands to empty, never the literal placeholder",
    expandTemplate("${NOT_SET}", env) === "");
  check("text around a placeholder is kept",
    expandTemplate("https://x/${SHORT}/mcp", env) === "https://x/abc/mcp");

  // Nabu Casa webhook URLs ARE the credential. A probe error quoting the
  // address must not carry it back to the panel.
  const leaked = `Error POSTing to endpoint ${env.HA_MCP_URL} (HTTP 404)`;
  const safe = unexpand(leaked, "${HA_MCP_URL}", env);
  check("an error quoting the expanded URL is scrubbed", !safe.includes("gAAAAABsecret"), safe);
  check("and says which secret it was instead", safe === "Error POSTing to endpoint ${HA_MCP_URL} (HTTP 404)", safe);
  check("text with no secret in it is untouched",
    unexpand("fetch failed", "${HA_MCP_URL}", env) === "fetch failed");
  check("a plain https URL has nothing to scrub",
    unexpand("boom https://example.com", "https://example.com", env) === "boom https://example.com");
  // Very short values would match ordinary text all over a message.
  check("values too short to be secrets are not scrubbed",
    unexpand("abc abc", "${SHORT}", env) === "abc abc");
}

console.log("\na pasted token survives a save from the panel");
{
  const TOKEN = "Bearer pasted-token-9f8e7d6c5b4a";
  const stored = sane([
    { label: "weather", url: "https://example.com/mcp", headers: { Authorization: TOKEN, "X-Extra": "extra-secret-value" } },
    HA,
  ]);

  // Exactly what the panel holds and sends back: masked values, via JSON.
  const shown = JSON.parse(JSON.stringify(maskForUi(stored))) as typeof stored;
  check("the panel only ever sees the mask", shown[0]!.headers!.Authorization === MASK);
  const saved = restoreMasked(sane(shown), stored);
  check("THE BUG: saving what the panel shows keeps the token", saved[0]!.headers!.Authorization === TOKEN, saved[0]);
  check("and every other masked header on that server", saved[0]!.headers!["X-Extra"] === "extra-secret-value");
  check("a literal mask is never what gets stored", !JSON.stringify(saved).includes(MASK));

  // What the panel used to send: the masked header filtered out entirely.
  const oldPayload = sane(shown.map((x) => ({ ...x, headers: {} })));
  check("(the old payload, with the header dropped, lost it — why the mask must travel)",
    !restoreMasked(oldPayload, stored)[0]!.headers!.Authorization);

  const edited = sane([{ ...shown[0]!, headers: { Authorization: "Bearer new-token-0000" } }]);
  check("typing a new token replaces the old one", restoreMasked(edited, stored)[0]!.headers!.Authorization === "Bearer new-token-0000");

  const cleared = sane([{ ...shown[0]!, headers: {} }]);
  check("clearing the field removes the token", !("Authorization" in restoreMasked(cleared, stored)[0]!.headers!));

  const renamed = sane([{ ...shown[0]!, label: "forecast" }]);
  check("renaming a server keeps its token (matched by URL)", restoreMasked(renamed, stored)[0]!.headers!.Authorization === TOKEN);

  const moved = sane([{ ...shown[0]!, url: "https://example.org/v2/mcp" }]);
  check("moving it keeps its token (matched by label)", restoreMasked(moved, stored)[0]!.headers!.Authorization === TOKEN);

  const stranger = sane([{ label: "new", url: "https://new.example/mcp", headers: { Authorization: MASK } }]);
  check("a mask with nothing behind it is dropped, not stored",
    !("Authorization" in restoreMasked(stranger, stored)[0]!.headers!));

  const placeholder = sane([{ label: "p", url: "https://p.example/mcp", headers: { Authorization: "Bearer ${P_TOKEN}" } }]);
  check("a placeholder passes through untouched",
    restoreMasked(placeholder, stored)[0]!.headers!.Authorization === "Bearer ${P_TOKEN}");

  // Editing a DIFFERENT server must not cost this one its token either.
  const both = sane([shown[0]!, { ...HA, enabled: false }]);
  check("editing another server leaves this one's token alone", restoreMasked(both, stored)[0]!.headers!.Authorization === TOKEN);

  check("the input list is not mutated", shown[0]!.headers!.Authorization === MASK);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
