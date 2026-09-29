import { readFileSync } from "node:fs";
import { MASK, aimedAnew, expandHeaderTemplates, expandTemplate, expandUrlTemplate, leftBehind, maskForUi, resolveConfigured, restoreMasked, sane, unexpand } from "../src/worker/lib/mcp-config.ts";

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
  // URLs filled as a call fills them, which is what config-store.ts passes in.
  const filled = (u: string) => expandUrlTemplate(u, { HA_MCP_URL: "https://hooks.example/api/webhook/abcdef0123456789" });
  const restore = (incoming: typeof stored) => restoreMasked(incoming, stored, filled);

  // Exactly what the panel holds and sends back: masked values, via JSON.
  const shown = JSON.parse(JSON.stringify(maskForUi(stored))) as typeof stored;
  check("the panel only ever sees the mask", shown[0]!.headers!.Authorization === MASK);
  const saved = restore(sane(shown));
  check("THE BUG: saving what the panel shows keeps the token", saved[0]!.headers!.Authorization === TOKEN, saved[0]);
  check("and every other masked header on that server", saved[0]!.headers!["X-Extra"] === "extra-secret-value");
  check("a literal mask is never what gets stored", !JSON.stringify(saved).includes(MASK));

  // What the panel used to send: the masked header filtered out entirely.
  const oldPayload = sane(shown.map((x) => ({ ...x, headers: {} })));
  check("(the old payload, with the header dropped, lost it — why the mask must travel)",
    !restore(oldPayload)[0]!.headers!.Authorization);

  const edited = sane([{ ...shown[0]!, headers: { Authorization: "Bearer new-token-0000" } }]);
  check("typing a new token replaces the old one", restore(edited)[0]!.headers!.Authorization === "Bearer new-token-0000");

  const cleared = sane([{ ...shown[0]!, headers: {} }]);
  check("clearing the field removes the token", !("Authorization" in restore(cleared)[0]!.headers!));

  const renamed = sane([{ ...shown[0]!, label: "forecast" }]);
  check("renaming a server keeps its token (matched by URL)", restore(renamed)[0]!.headers!.Authorization === TOKEN);

  const moved = sane([{ ...shown[0]!, url: "https://example.com/v2/mcp" }]);
  check("moving it, even on the same host, needs it typed again", !("Authorization" in restore(moved)[0]!.headers!));

  const stranger = sane([{ label: "new", url: "https://new.example/mcp", headers: { Authorization: MASK } }]);
  check("a mask with nothing behind it is dropped, not stored",
    !("Authorization" in restore(stranger)[0]!.headers!));

  const placeholder = sane([{ label: "p", url: "https://p.example/mcp", headers: { Authorization: "Bearer ${P_TOKEN}" } }]);
  check("a placeholder passes through untouched",
    restore(placeholder)[0]!.headers!.Authorization === "Bearer ${P_TOKEN}");

  // Editing a DIFFERENT server must not cost this one its token either.
  const both = sane([shown[0]!, { ...HA, enabled: false }]);
  check("editing another server leaves this one's token alone", restore(both)[0]!.headers!.Authorization === TOKEN);

  check("the input list is not mutated", shown[0]!.headers!.Authorization === MASK);
}

console.log("\na pasted token stays with the address it was saved for");
{
  /*
   * Every family admin can edit this list. Matched by label alone, the owner's
   * server kept under its label with a new URL took its pasted token there.
   */
  const env = { HA_MCP_URL: "https://hooks.example/api/webhook/abcdef0123456789", OTHER_MCP_URL: "https://evil.example/mcp" };
  const filled = (u: string) => expandUrlTemplate(u, env);
  const stored = sane([
    { label: "home", url: "https://ha.example.com/api/mcp", headers: { Authorization: "Bearer literal-token" } },
    { label: "hook", url: "${HA_MCP_URL}", headers: { "X-Key": "hook-key-0123456789" } },
  ]);
  const aim = (label: string, url: string, header = "Authorization", fill = filled) => {
    const incoming = sane([{ label, url, headers: { [header]: MASK } }]);
    const out = restoreMasked(incoming, stored, fill);
    return { value: out[0]!.headers![header], retype: leftBehind(incoming, out) };
  };

  const evil = aim("home", "https://evil.example/mcp");
  check("THE BUG: same label, another host: the token is not put back", evil.value === undefined, evil);
  check("and the panel is told whose to ask for again", JSON.stringify(evil.retype) === '["home"]', evil.retype);
  const same = aim("home", "https://ha.example.com/api/mcp");
  check("same label, same address: kept", same.value === "Bearer literal-token", same);
  check("with nothing to type again", same.retype.length === 0, same.retype);
  // A host can be shared: Nabu Casa's webhook host is every customer's.
  check("another address on the same host is another server", aim("home", "https://ha.example.com/api/webhook/someone-elses").value === undefined);
  check("a look-alike host is another host", aim("home", "https://ha.example.com.evil.example/api/mcp").value === undefined);
  check("so is one behind a user name", aim("home", "https://ha.example.com@evil.example/api/mcp").value === undefined);
  check("so is another port", aim("home", "https://ha.example.com:8443/api/mcp").value === undefined);
  check("a URL secret is compared once filled", aim("home", "${OTHER_MCP_URL}").value === undefined);

  check("a server whose URL is a secret keeps its header at that URL", aim("hook", "${HA_MCP_URL}", "X-Key").value === "hook-key-0123456789");
  check("even while the secret is unset: it is the same address",
    aim("hook", "${HA_MCP_URL}", "X-Key", (u) => expandUrlTemplate(u, {})).value === "hook-key-0123456789");
  check("and at the address the secret holds, written out", aim("hook", env.HA_MCP_URL, "X-Key").value === "hook-key-0123456789");
  check("but not at another host", aim("hook", "https://evil.example/mcp", "X-Key").value === undefined);
  check("nor at another webhook on the same host", aim("hook", "https://hooks.example/api/webhook/someone-elses", "X-Key").value === undefined);
}

console.log("\nthrough the route: an admin's moved server never sends the token");
{
  const { handleMcp } = await import("../src/worker/routes/mcp.ts");
  const kv = new Map<string, string>([["config:mcp-servers", JSON.stringify({ servers: [
    { label: "home", url: "https://ha.example.com/api/mcp", headers: { Authorization: "Bearer literal-token" } },
  ] })]]);
  const env = {
    CONFIG: {
      get: async (k: string, type?: string) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)) : null),
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  };
  const call = (method: string, path: string, body: unknown) =>
    handleMcp(new Request(`https://jarvis.example${path}`, { method, body: JSON.stringify(body) }), env as never, false);
  const moved = { label: "home", url: "https://evil.example/mcp", headers: { Authorization: MASK } };

  const sent: { url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input instanceof Request ? input.url : input), auth: new Headers(init?.headers).get("authorization") });
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const test = (await (await call("POST", "/api/mcp/test", moved)).json()) as { ok: boolean; error?: string };
    check("Test: nothing carries the token", !sent.some((r) => r.auth?.includes("literal-token")), sent);
    check("and the panel is told why", !test.ok && /type it again/.test(test.error ?? ""), test);

    sent.length = 0;
    await call("POST", "/api/mcp/test", { ...moved, url: "https://ha.example.com/api/mcp" });
    check("Test at its own host still sends it there",
      sent.length > 0 && sent.every((r) => new URL(r.url).host === "ha.example.com" && r.auth === "Bearer literal-token"), sent);

    const put = (await (await call("PUT", "/api/mcp", { servers: [moved] })).json()) as { retype?: string[] };
    check("Save: the token is not stored for the new host", !kv.get("config:mcp-servers")!.includes("literal-token"), kv.get("config:mcp-servers"));
    check("and the reply names the server to type it again for", JSON.stringify(put.retype) === '["home"]', put);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nthrough the route: a Worker secret goes somewhere new only for the owner");
{
  const { handleMcp } = await import("../src/worker/routes/mcp.ts");
  const GH = { label: "github", url: "https://mcp.example/sse", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };
  const kv = new Map<string, string>([["config:mcp-servers", JSON.stringify({ servers: [GH] })]]);
  const env = {
    GITHUB_TOKEN: "gh-token-0123456789abcdef",
    CONFIG: {
      get: async (k: string, type?: string) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)) : null),
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  };
  const call = (method: string, path: string, body: unknown, owner: boolean) =>
    handleMcp(new Request(`https://jarvis.example${path}`, { method, body: JSON.stringify(body) }), env as never, owner);
  const mine = { label: "mine", url: "https://evil.example/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };

  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${String(input instanceof Request ? input.url : input)} ${new Headers(init?.headers).get("authorization")}`);
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const test = (await (await call("POST", "/api/mcp/test", mine, false)).json()) as { ok: boolean; error?: string };
    check("an admin's Test: the secret is sent nowhere", !sent.some((r) => r.includes("gh-token")), sent);
    check("and the panel is told why", !test.ok && /only the person who set up the family/.test(test.error ?? ""), test);
    const diag = (await (await call("POST", "/api/mcp/call", { ...mine, tool: "x" }, false)).json()) as { ok: boolean; error?: string };
    check("an admin's /api/mcp/call: sent nowhere either", !sent.some((r) => r.includes("gh-token")) && !diag.ok, { sent, diag });

    const before = kv.get("config:mcp-servers");
    const put = await call("PUT", "/api/mcp", { servers: [GH, mine] }, false);
    check("an admin's Save is refused", put.status === 403 && kv.get("config:mcp-servers") === before, put.status);
    check("naming the server", /: mine$/.test(((await put.json()) as { error: string }).error));
    check("an admin's Save that keeps it where it was goes through",
      (await call("PUT", "/api/mcp", { servers: [{ ...GH, enabled: false }] }, false)).status === 200);

    check("the owner's Save goes through", (await call("PUT", "/api/mcp", { servers: [GH, mine] }, true)).status === 200 &&
      kv.get("config:mcp-servers")!.includes("evil.example"));
    sent.length = 0;
    await call("POST", "/api/mcp/test", mine, false);
    check("and once the owner has, an admin's Test of it runs", sent.some((r) => r.startsWith("https://evil.example/")), sent);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nonly the owner sends a Worker secret somewhere new");
{
  /*
   * A secret set with `wrangler secret put` for an MCP server has no address
   * of its own, and every admin can edit the list: one could add a server of
   * their own with "Bearer ${GITHUB_TOKEN}", or keep the owner's under its
   * label and point it elsewhere.
   */
  const env = { GITHUB_TOKEN: "gh-token-0123456789abcdef", HA_MCP_URL: "https://hooks.example/api/webhook/abcdef0123456789" };
  const filled = (u: string) => expandUrlTemplate(u, env);
  const GH = { label: "github", url: "https://mcp.example/sse", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };
  const current = sane([GH, HA]);
  const anew = (incoming: unknown[], now = current) => aimedAnew(sane(incoming), now, filled);

  check("the list as it is: nothing new", anew([GH, HA]).length === 0);
  check("renamed or turned off: nothing new", anew([{ ...GH, label: "gh", enabled: false }]).length === 0);
  check("moved, even on the same host: new (a host can be shared)", anew([{ ...GH, url: "https://mcp.example/someone-elses/sse" }]).length === 1);
  check("removed: nothing new", anew([HA]).length === 0);
  check("THE HOLE: the owner's server pointed at another host", JSON.stringify(anew([{ ...GH, url: "https://evil.example/sse" }])) === '["github"]');
  check("an admin's own server using the owner's secret", JSON.stringify(anew([GH, { label: "mine", url: "https://evil.example/mcp", headers: { "X-Key": "${GITHUB_TOKEN}" } }])) === '["mine"]');
  check("or putting it inside a URL", JSON.stringify(anew([{ label: "mine", url: "https://evil.example/${GITHUB_TOKEN}/sse" }])) === '["mine"]');
  check("removing the owner's first does not help", JSON.stringify(anew([{ ...GH, url: "https://evil.example/sse" }], sane([HA]))) === '["github"]');
  check("a look-alike host is another host", anew([{ ...GH, url: "https://mcp.example.evil.example/sse" }]).length === 1);
  check("a token typed in as-is is not a Worker secret", anew([{ label: "mine", url: "https://evil.example/mcp", headers: { Authorization: "Bearer typed-token" } }]).length === 0);
  check("a setting keeps to its own addresses already, by fillable()", anew([{ label: "mine", url: "https://evil.example/mcp", headers: { Authorization: "Bearer ${HA_TOKEN}", "X-Tz": "${TIMEZONE}" } }]).length === 0);
  check("a URL that is one placeholder only goes where it points", anew([{ label: "mine", url: "${OTHER_MCP_URL}" }]).length === 0);
  check("the repo defaults saved as they are: nothing new", anew(SEED, sane(SEED)).length === 0);
}

console.log("\n${NAME} never hands one of Jarvis's own keys to a server that is not already sent it");
{
  const env: Record<string, unknown> = {
    HA_MCP_URL: "https://hooks.example/api/webhook/abcdef0123456789",
    HA_BASE_URL: "https://home.example",
    HA_TOKEN: "ha-token-0123456789abcdef",
    OPENAI_API_KEY: "sk-openai-0123456789abcdef",
    HERMES_BASE_URL: "https://hermes.example",
    HERMES_API_KEY: "hermes-key-0123456789",
    JARVIS_SHARED_SECRET: "OWNERKEY23456789",
    JARVIS_PERSON: "u_adam",
    GITHUB_TOKEN: "gh-token-0123456789abcdef",
    TIMEZONE: "Asia/Kuala_Lumpur",
  };
  const h = (v: string, url: string) => expandHeaderTemplates({ Authorization: v }, env, url).Authorization;
  const EVIL = "https://evil.example/mcp";
  check("a secret set for MCP is filled, as before", h("Bearer ${GITHUB_TOKEN}", EVIL) === "Bearer gh-token-0123456789abcdef");
  check("a setting that is not a secret is filled", h("${TIMEZONE}", EVIL) === "Asia/Kuala_Lumpur");
  check("the OpenAI key: not for another server", h("Bearer ${OPENAI_API_KEY}", EVIL) === "Bearer ");
  check("the Hermes key: not for another server", h("${HERMES_API_KEY}", EVIL) === "");
  check("the Hermes key: for a server on Hermes's own address, yes", h("${HERMES_API_KEY}", "https://hermes.example/mcp") === "hermes-key-0123456789");
  check("the Home Assistant token: for Home Assistant's own MCP server", h("Bearer ${HA_TOKEN}", "https://home.example/api/mcp") === "Bearer ha-token-0123456789abcdef");
  check("the Home Assistant token: not for a look-alike host", h("Bearer ${HA_TOKEN}", "https://home.example.evil.example/api/mcp") === "Bearer ");
  check("the owner key: never, wherever", h("${JARVIS_SHARED_SECRET}", "https://home.example/api/mcp") === "");
  check("the per-request values: never", h("${JARVIS_PERSON}", EVIL) === "");

  const u = (t: string) => expandUrlTemplate(t, env);
  check("a URL that is the placeholder alone is filled (the seeded Home Assistant server)", u("${HA_MCP_URL}") === "https://hooks.example/api/webhook/abcdef0123456789");
  check("a credential URL put inside another address is not", u("https://evil.example/?u=${HA_MCP_URL}") === "https://evil.example/?u=");
  check("nor a key in a path", u("https://evil.example/${OPENAI_API_KEY}/sse") === "https://evil.example//sse");
  check("a secret set for MCP in a path is filled, as before", u("https://mcp.example/${GITHUB_TOKEN}/sse") === "https://mcp.example/gh-token-0123456789abcdef/sse");
  check("a key as a whole URL is not an https address, so no server is called", !/^https:\/\//.test(u("${OPENAI_API_KEY}")));
}

console.log("\na header typed as a number does not break the list");
{
  const list = sane([{ label: "x", url: "https://mcp.example/sse", headers: { "X-Port": 8123, "X-On": true, "X-Obj": { a: 1 }, Authorization: "Bearer ${GITHUB_TOKEN}" } }]);
  check("numbers and true/false are kept as text; anything else is dropped", JSON.stringify(list[0]!.headers) === JSON.stringify({ "X-Port": "8123", "X-On": "true", Authorization: "Bearer ${GITHUB_TOKEN}" }), list[0]!.headers);
  const filled = expandHeaderTemplates(list[0]!.headers, { GITHUB_TOKEN: "gh-token-0123456789abcdef" }, "https://mcp.example/sse");
  check("and filling in placeholders works on them", filled["X-Port"] === "8123" && filled.Authorization === "Bearer gh-token-0123456789abcdef", filled);
  check("a list of headers is not headers", sane([{ label: "y", url: "https://mcp.example/sse", headers: ["a"] }])[0]!.headers === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
