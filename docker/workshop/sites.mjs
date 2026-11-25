// The sites folder: what a background job built and its person published with a tap. Two faces. One, a Unix socket that
// only the workshop's door reaches (door.mjs), is how Jarvis puts a site there. The other is what anyone on the network
// may open: static files, read only.
//
// A site is put in place whole: written aside, then the folder renamed, with the one before kept to put back. What its
// folder should hold is written down first, and the folders are made so (settle): cut short anywhere, it is finished as
// it starts again. Its pages may have been made from what a stranger wrote, so they load nothing from elsewhere
// (Content-Security-Policy), and share no address with Jarvis: a port of its own is an origin of its own. One site is
// not kept from another: they share that origin, and a page may lead whoever opens it anywhere.
import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { extname, join } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";

export const PORT = 8090;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SEGMENT = /^[\p{L}\p{N}_()+@,-][\p{L}\p{N} ._()+@,-]*$/u;
const MAX_FILES = 300;
const MAX_EACH = 5_000_000;
const MAX_TOTAL = 10_000_000;
const MAX_SITES = 50;
/** A site's files as they come, in base64. */
const MAX_BODY = 16_000_000;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".wasm": "application/wasm", ".zip": "application/zip",
};
const HEADERS = {
  "content-security-policy": "default-src 'self' data: blob: 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-cache",
};

class Refused extends Error {}
const refuse = (why) => {
  throw new Refused(why);
};
const exists = (p) => fs.lstat(p).then(() => true, () => false);

/** `root`: the folder. `address`: where it is seen, if its owner said. */
export function sites({ root, address = "", now = Date.now }) {
  const OWN = join(root, ".jarvis");
  const at = (name) => join(root, name);
  const held = (name, id) => join(OWN, "held", `${name}.${id}`);
  const meta = (name) => join(OWN, `${name}.json`);
  /*
   * A site, as it should be: `versions`, the one there (or, `down`, the one that was) and the one before it, each
   * {id, at, files, bytes, sum?}; `here`, the one its folder held when that was last made so. A version that is not
   * in its folder is held aside, under its id.
   */
  const read = async (name) => {
    try {
      return JSON.parse(await fs.readFile(meta(name), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`sites: ${name}: what is written of it cannot be read:`, e);
      return null;
    }
  };
  const write = async (name, m) => {
    const aside = `${meta(name)}.new`;
    const f = await fs.open(aside, "w");
    try {
      await f.writeFile(JSON.stringify(m));
      await f.sync();
    } finally {
      await f.close();
    }
    await fs.rename(aside, meta(name));
  };
  const named = async () => (await fs.readdir(OWN)).sort().flatMap((e) => /^([a-z0-9-]+)\.json$/.exec(e)?.[1] ?? []);
  // One change at a time, whichever screen asks.
  let last = Promise.resolve();
  const inTurn = (fn) => {
    const done = last.then(fn);
    last = done.catch(() => {});
    return done;
  };
  const TAKEN = "there is a folder of that name there, which was not put there from here";
  /** Its folder made to hold what it should: done again from anywhere it was cut short, it ends the same. */
  const settle = async (name, m) => {
    const want = m.down ? null : m.versions[0].id;
    if (m.here !== want) {
      if (m.here && (await exists(at(name))) && !(await exists(held(name, m.here)))) await fs.rename(at(name), held(name, m.here));
      if (want && (await exists(held(name, want)))) {
        // Not one of its own, so not its to move.
        if (await exists(at(name))) refuse(TAKEN);
        await fs.rename(held(name, want), at(name));
      }
      m = { ...m, here: want };
      await write(name, m);
    }
    const keep = new Set(m.versions.map((v) => `${name}.${v.id}`));
    for (const e of await fs.readdir(join(OWN, "held"))) if (e.startsWith(`${name}.`) && !keep.has(e)) await fs.rm(join(OWN, "held", e), { recursive: true, force: true });
    return m;
  };
  /** Why the folder cannot be used at all; "" while it can. */
  let broken = "";
  const ready = (async () => {
    await fs.mkdir(join(OWN, "held"), { recursive: true });
    for (const e of await fs.readdir(OWN)) if (e.startsWith("stage-")) await fs.rm(join(OWN, e), { recursive: true, force: true });
    const all = new Set(await named());
    for (const name of all) {
      try {
        await settle(name, await read(name));
      } catch (e) {
        console.error(`sites: ${name}:`, e);
      }
    }
    // Written aside for a site that was never written down.
    for (const e of await fs.readdir(join(OWN, "held"))) if (!all.has(e.split(".")[0])) await fs.rm(join(OWN, "held", e), { recursive: true, force: true });
  })().catch((e) => {
    console.error("sites: the folder cannot be used:", e);
    broken = "the sites folder cannot be written: it must be one that user 1000 may write";
  });

  const known = async (name) => {
    const m = typeof name === "string" && NAME.test(name) ? await read(name) : null;
    // One left half done by an error is finished first.
    return m ? settle(name, m) : refuse("there is no such site");
  };
  const become = async (name, m) => {
    await write(name, m);
    await settle(name, m);
  };
  const ops = {
    async list() {
      const all = await named();
      const out = [];
      for (const name of all) {
        const m = await read(name);
        if (!m) continue;
        const [v, before] = m.versions;
        out.push({ name, at: v.at, files: v.files, bytes: v.bytes, ...(m.down ? { down: true } : {}), ...(before ? { before: before.at } : {}) });
      }
      // Folders that are not its own: names it cannot use.
      const taken = (await fs.readdir(root)).filter((e) => NAME.test(e) && !all.includes(e)).sort().slice(0, 500);
      return { address: address || null, sites: out, taken };
    },
    async publish({ name, files, sum }) {
      if (typeof name !== "string" || !NAME.test(name)) refuse("that is not a site's name");
      if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) refuse(`a site is 1 to ${MAX_FILES} files`);
      const was = (await read(name)) && (await known(name));
      if (!was && (await named()).length >= MAX_SITES) refuse(`there are ${MAX_SITES} sites already`);
      // Never in the place of what its owner keeps there.
      if (!was?.here && (await exists(at(name)))) refuse(TAKEN);
      const seen = new Set();
      let bytes = 0;
      const id = randomBytes(8).toString("hex");
      const stage = join(OWN, `stage-${id}`);
      try {
        for (const f of files) {
          const parts = typeof f?.path === "string" ? f.path.split("/") : [];
          if (!parts.length || parts.length > 10 || f.path.length > 200 || parts.some((p) => !SEGMENT.test(p))) refuse("it holds a name that cannot be published");
          const k = f.path.normalize("NFC").toLowerCase();
          if (seen.has(k)) refuse(`${f.path} is in it twice`);
          seen.add(k);
          const data = Buffer.from(typeof f.data === "string" ? f.data : "", "base64url");
          bytes += data.length;
          if (data.length > MAX_EACH || bytes > MAX_TOTAL) refuse("it is too large");
          const to = join(stage, ...parts);
          await fs.mkdir(join(to, ".."), { recursive: true });
          await fs.writeFile(to, data, { flag: "wx" });
        }
        if (!(await exists(join(stage, "index.html")))) refuse("it has no index.html");
        await fs.rename(stage, held(name, id));
        const v = { id, at: now(), files: files.length, bytes, ...(/^[0-9a-f]{64}$/.test(sum) ? { sum } : {}) };
        await become(name, { here: was?.here ?? null, versions: [v, ...(was?.versions.slice(0, 1) ?? [])] });
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
      return { address: address || null };
    },
    /**
     * The one before in the place of the one there, and that one kept; with none before, it is not there. Taken down, it is
     * there again. With `sum`, only while what that put there is what is there: a card's Put back undoes its own card.
     */
    async back({ name, sum }) {
      const m = await known(name);
      const [there, before] = m.versions;
      if (sum !== undefined && (m.down || there.sum !== sum)) refuse("what that published is not what is there now, so nothing was changed");
      if (m.down) {
        if (await exists(at(name))) refuse(TAKEN);
        const { down: _, ...up } = m;
        await become(name, up);
        return { address: address || null };
      }
      if (!before) return { ...(await ops.down({ name })), address: address || null, down: true };
      if (!(await exists(held(name, before.id)))) refuse("the one before it is not there any more");
      await become(name, { ...m, versions: [before, there] });
      return { address: address || null };
    },
    async down({ name }) {
      const m = await known(name);
      if (m.down) refuse("there is no such site");
      await become(name, { ...m, down: true });
      return {};
    },
  };

  /** What Jarvis asks, through the door. */
  async function api(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      await ready;
      if (broken) refuse(broken);
      const op = /^\/v1\/sites\/([a-z]+)$/.exec(req.url ?? "")?.[1];
      if (req.method !== "POST" || !op || !Object.hasOwn(ops, op)) return json(404, { error: "no such thing here" });
      const chunks = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        if (n > MAX_BODY) refuse("it is too large");
        chunks.push(c);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        refuse("that is not JSON");
      }
      json(200, await inTurn(() => ops[op](body ?? {})));
    } catch (e) {
      if (!(e instanceof Refused)) console.error("sites:", e);
      json(e instanceof Refused ? 400 : 500, { error: e instanceof Refused ? e.message : "that failed" });
    }
  }

  /** What anyone may open: one file, or a folder's index.html. */
  async function serve(req, res) {
    const end = (status, text, headers = {}) => {
      res.writeHead(status, { ...HEADERS, "content-type": "text/plain; charset=utf-8", ...headers });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return end(405, "read only");
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return end(400, "not an address");
    }
    const parts = path.split("/").filter(Boolean);
    if (!parts.length || !NAME.test(parts[0]) || parts.some((p) => !SEGMENT.test(p))) return end(404, "not here");
    try {
      let file = root;
      let stat = null;
      for (const p of parts) {
        file = join(file, p);
        // No link is followed, at any step: what is served is what was published, and nothing it points at.
        stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) return end(404, "not here");
      }
      if (stat.isDirectory()) {
        if (!path.endsWith("/")) return end(301, "", { location: `${parts.map(encodeURIComponent).reduce((a, p) => `${a}/${p}`, "")}/` });
        file = join(file, "index.html");
        stat = await fs.lstat(file);
      }
      if (!stat.isFile()) return end(404, "not here");
      res.writeHead(200, { ...HEADERS, "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": stat.size });
      if (req.method === "HEAD") return res.end();
      // Closed with whoever asked: a page turned away from half way leaves nothing open here.
      pipeline(createReadStream(file), res, () => {});
    } catch {
      end(404, "not here");
    }
  }
  /** When what is being changed is changed. */
  const idle = () => ready.then(() => last);
  return { api, serve, idle };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const s = sites({ root: "/sites", address: process.env.SITES_ADDRESS ?? "" });
  const socket = "/run/sites/sock";
  await fs.rm(socket, { force: true });
  const api = createServer((q, r) => void s.api(q, r)).listen(socket, () => void fs.chmod(socket, 0o660));
  createServer((q, r) => void s.serve(q, r)).listen(PORT, () => console.log("sites: open"));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => api.close(() => void s.idle().then(() => process.exit(0))));
}
