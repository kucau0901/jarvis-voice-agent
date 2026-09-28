// The screen half of the behavior checks (test/behavior/check.mjs): the app is
// opened in headless Chrome as three people (an admin, an adult, a guest), and
// each panel, and each section of a panel with a menu, is read as text and
// photographed. The text is compared between runs; the pictures are for a
// person to look at when the text differs.
//
// Plain Node and the Chrome already on the machine, driven over the DevTools
// protocol: nothing to install.
//
//   node test/behavior/ui.mjs <base url> <tokens.json> <out dir>
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [BASE, TOKENS, OUT] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CHROME_PORT ?? 9333);
const PANELS = ["openFamily", "openMemory", "openRoutines", "openJobs", "openChat", "openDevices", "openSettings"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "jarvis-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1200,900", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++next;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

/** Text that has stopped changing (a panel filling in from the server). */
async function settled(expression, maxMs = 8000) {
  let last = null;
  let same = 0;
  for (let t = 0; t < maxMs; t += 300) {
    const now = await js(expression);
    same = now === last ? same + 1 : 0;
    if (same >= 2) return now;
    last = now;
    await sleep(300);
  }
  return last;
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, "screens", `${name}.png`), Buffer.from(data, "base64"));
}

await send("Page.enable");
await send("Runtime.enable");
mkdirSync(join(OUT, "screens"), { recursive: true });

const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
const seen = {};
for (const [person, token] of Object.entries(tokens)) {
  await send("Page.navigate", { url: BASE });
  await sleep(1500);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("jarvis.key", ${JSON.stringify(token)}); true`);
  await send("Page.navigate", { url: BASE });
  await sleep(3500);
  const out = {};
  out.home = await settled(`(() => {
    const menu = [...document.querySelectorAll("#topbtns button")].filter((b) => !b.hidden).map((b) => b.textContent.trim());
    return JSON.stringify({ title: document.getElementById("title")?.textContent ?? "", status: document.getElementById("status")?.textContent ?? "", menu });
  })()`);
  await shot(`${person}-home`);
  for (const id of PANELS) {
    const offered = await js(`(() => { const b = document.getElementById(${JSON.stringify(id)}); return !!b && !b.hidden; })()`);
    if (!offered) continue;
    await js(`document.getElementById(${JSON.stringify(id)}).click(); true`);
    const text = await settled(`document.querySelector(".panel.open")?.innerText ?? ""`);
    const panel = { text };
    // Chat's conversations are listed in the family's storage order, which follows random ids: kept as a set.
    if (id === "openChat") {
      panel.text = await js(`document.querySelector(".panel.open .msgs")?.innerText ?? ""`);
      panel.conversations = await js(`[...document.querySelectorAll(".panel.open .convo")].map((b) => b.innerText).sort()`);
    }
    // A panel with a menu (sections.ts): each section in turn.
    const navs = await js(`[...document.querySelectorAll(".panel.open .setnav button")].map((b) => b.dataset.for)`);
    if (navs?.length) {
      panel.sections = {};
      for (const sec of navs) {
        await js(`document.querySelector('.panel.open .setnav button[data-for="${sec}"]')?.click(); true`);
        panel.sections[await js(`document.querySelector('.panel.open .setnav button[data-for="${sec}"]')?.textContent ?? ""`)] =
          await settled(`document.querySelector(".panel.open .setbody [data-section].active")?.innerText ?? ""`, 3000);
      }
    }
    await shot(`${person}-${id.slice(4).toLowerCase()}`);
    out[id.slice(4)] = panel;
    await js(`(() => { const p = document.querySelector(".panel.open"); p?.querySelector(".close")?.click(); p?.classList.remove("open"); return true; })()`);
    await sleep(300);
  }
  seen[person] = out;
}

writeFileSync(join(OUT, "ui.raw.json"), JSON.stringify(seen, null, 1));
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(`ui: ${Object.keys(seen).length} people, screens in ${join(OUT, "screens")}`);
