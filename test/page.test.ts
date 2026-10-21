// Pages Jarvis made (lib/pages.ts, lib/page-template.ts, routes/page.ts,
// tools/page.ts): each person's own, opened only by a link that carries its
// proof, drawn escaped with no script, and served sandboxed.
import { KEEP_PAGES, PAGE_ID, PAGE_KEEP_MS, Pages, VIEW_MS } from "../src/worker/lib/pages.ts";
import { renderPage } from "../src/worker/lib/page-template.ts";
import { handlePage, handlePageMeta } from "../src/worker/routes/page.ts";
import { makePage } from "../src/worker/tools/page.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { asSaid } from "../src/worker/lib/conversation.ts";

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

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

const T = 1_790_000_000_000;
const doc = { title: "Home chargers", subtitle: "Three to compare", sections: [{ heading: "Prices", body: "- **Pulsar** at RM3,000\n- See [the maker](https://maker.example/p)", table: { columns: ["Model", "Price"], rows: [["Pulsar", "RM3,000"]] } }] };

console.log("keeping them, and who may open one");
{
  const st = fakeStorage();
  const p = new Pages(st);
  const id = await p.put("u_sara", doc, T);
  check("an id that cannot be guessed", PAGE_ID.test(id));
  check("theirs, and nobody else's", (await p.mine("u_sara", id, T))?.title === "Home chargers" && (await p.mine("u_adam", id, T)) === null);
  const view = (await p.viewToken("u_sara", id, T))!;
  check("a view link opens it, for an hour", (await p.open(id, view, T + VIEW_MS - 1))?.title === "Home chargers" && (await p.open(id, view, T + VIEW_MS + 1)) === null);
  check("not someone else's to mint", (await p.viewToken("u_adam", id, T)) === null);
  const other = await p.put("u_sara", doc, T);
  check("a link for one page opens no other", (await p.open(other, view, T)) === null);
  const tampered = view.slice(0, -2) + (view.endsWith("A") ? "BB" : "AA");
  check("a changed link opens nothing", (await p.open(id, tampered, T)) === null && (await p.open(id, `${T + 99999999}.${view.split(".")[1]}`, T)) === null);
  check("a share token before sharing opens nothing", (await p.open(id, "x".repeat(32), T)) === null);
  const shared = (await p.share("u_sara", id, T))!;
  check("shared: its link opens it, and only its hash is kept", (await p.open(id, shared, T + 5 * 86_400_000))?.title === "Home chargers" && !JSON.stringify([...st._m.values()]).includes(shared));
  const again = (await p.share("u_sara", id, T))!;
  check("shared again: the old link is dead", (await p.open(id, shared, T)) === null && (await p.open(id, again, T)) !== null);
  check("stopped: dead too", (await p.unshare("u_sara", id, T)) && (await p.open(id, again, T)) === null);
  check(`gone after ${PAGE_KEEP_MS / 86_400_000} days`, (await p.open(id, (await p.viewToken("u_sara", id, T))!, T + PAGE_KEEP_MS + 1)) === null);
  for (let i = 0; i < KEEP_PAGES + 3; i++) await p.put("u_many", doc, T + i);
  check(`each person's newest ${KEEP_PAGES}`, [...st._m.keys()].filter((k) => k.startsWith("page:")).length === 2 + KEEP_PAGES);
  await p.clear("u_sara");
  check("all of theirs gone with the chat", (await p.mine("u_sara", other, T)) === null);
}

console.log("\ndrawn");
{
  const html = renderPage({ who: "u", at: T, title: "<script>alert(1)</script>", sections: [
    { heading: "A <b>", body: "Hi <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://ok.example/x) **bold**", table: { columns: ["<i>c</i>"], rows: [["<script>"]] } },
    { heading: "Two", body: "- one\n- two", table: null },
  ] });
  check("no script, no tag from the words", !/<script/i.test(html) && !/<img/i.test(html) && !/<i>/.test(html) && !/<b>/.test(html), html.slice(0, 200));
  check("links to https pages only", html.includes('href="https://ok.example/x"') && !/href="javascript/i.test(html) && html.includes("[bad](javascript:alert(1))"));
  check("bold and lists, as words allow", html.includes("<strong>bold</strong>") && html.includes("<li>one</li>"));
  check("tabs and theme in CSS, and it says it was made by an AI", html.includes('type="radio"') && html.includes('id="dark"') && html.includes("AI-generated") && html.includes("Made by Jarvis"));
}

console.log("\nserved");
{
  const st = fakeStorage();
  const p = new Pages(st);
  const id = await p.put("u_sara", doc, Date.now());
  const calls: string[] = [];
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => {
    calls.push(String(m));
    if (m === "pageOpen") return p.open(a[0] as string, a[1] as string, a[2] as number);
    if (m === "pageMine") return p.mine(a[0] as string, a[1] as string, a[2] as number);
    if (m === "pageView") return p.viewToken(a[0] as string, a[1] as string, a[2] as number);
    if (m === "pageShare") return p.share(a[0] as string, a[1] as string, a[2] as number);
    return undefined;
  }) });
  const env = { STATE: { idFromName: () => "j", get: () => stub } } as never;
  const sara = { kind: "member", id: "u_sara", role: "adult", scopes: ["*"], session: "s" } as never;
  const meta = await handlePageMeta(new Request(`https://j.test/api/page?id=${id}`), env, sara);
  const { viewUrl } = (await meta.json()) as { viewUrl: string };
  check("theirs: a link to open it", meta.status === 200 && viewUrl.startsWith(`https://j.test/api/v1/p/${id}?k=`));
  const r = await handlePage(new Request(viewUrl), env);
  const csp = r.headers.get("content-security-policy") ?? "";
  check("the page, sandboxed, with no script allowed", r.status === 200 && (await r.text()).includes("Home chargers") && /\bsandbox\b/.test(csp) && csp.includes("default-src 'none'") && !/allow-scripts|allow-same-origin/.test(csp), csp);
  check("not kept, not indexed", r.headers.get("cache-control") === "no-store" && /noindex/.test(r.headers.get("x-robots-tag") ?? ""));
  calls.length = 0;
  const bad = await handlePage(new Request(`https://j.test/api/v1/p/${id}?k=nope`), env);
  check("a link of the wrong shape: the same 404, and the state not asked", bad.status === 404 && !calls.length);
  check("someone else's: no such page", (await handlePageMeta(new Request(`https://j.test/api/page?id=${id}`), env, { kind: "member", id: "u_adam", role: "adult", scopes: ["*"], session: "s" } as never)).status === 404);
  const share = (who: unknown) => handlePageMeta(new Request("https://j.test/api/page/share", { method: "POST", body: JSON.stringify({ id }) }), env, who as never);
  check("sharing is for those who run the house", (await share(sara)).status === 403 && (await share({ kind: "member", id: "u_sara", role: "admin", scopes: ["*"], session: "s" })).status === 200);
  check("scopes: a screen's to open from the app, a person's to share", requiredScope("/api/page", "GET") === "screen" && requiredScope("/api/page/share", "POST") === "person");
}

console.log("\nthe tool, and the conversation");
{
  const shown: Record<string, unknown>[] = [];
  const put: unknown[] = [];
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => (m === "pagePut" ? (put.push(a), "p0123456789abcdefghjk") : undefined)) });
  const ctx = { env: { JARVIS_PERSON: "u_sara", STATE: { idFromName: () => "j", get: () => stub } }, display: (x: Record<string, unknown>) => void shown.push(x), progress() {}, grants: ["*"], signal: new AbortController().signal } as never;
  const said = String(await makePage.run({ title: "Chargers", subtitle: null, sections: [{ heading: "Prices", body: "x", table: { columns: ["a", "b"], rows: [["1", "2", "3"]] } }, { heading: "", body: "dropped", table: null }] }, ctx));
  const kept = (put[0] as [string, { sections: { table: { rows: string[][] } | null }[] }])[1];
  check("made as theirs, its rows as wide as its columns, an empty heading dropped", (put[0] as unknown[])[0] === "u_sara" && kept.sections.length === 1 && kept.sections[0]!.table!.rows[0]!.length === 2, kept);
  check("shown as a card, by its id", shown[0]?.kind === "page" && shown[0].page === "p0123456789abcdefghjk" && /made and shown/.test(said));
  check("needs a screen", makePage.scope === "screen");
  const a = asSaid({ id: "c_abcdef1", role: "assistant", text: "Here it is", page: { id: "p0123456789abcdefghjk", title: "Chargers" } }, 5);
  check("kept with the answer that made it", a?.page?.id === "p0123456789abcdefghjk");
  check("…not a made-up id, nor on a question", !asSaid({ id: "c_abcdef2", role: "assistant", text: "x", page: { id: "../x", title: "t" } }, 5)?.page && !asSaid({ id: "c_abcdef3", role: "user", text: "x", page: { id: "p0123456789abcdefghjk", title: "t" } }, 5)?.page);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
