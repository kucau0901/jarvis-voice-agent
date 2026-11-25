// Checks the running workshop from where Jarvis is (its container shares the door's network), in CI and by hand:
//
//   docker compose --profile workshop exec -T -e TOKEN=… jarvis node --input-type=module < docker/workshop/check.mjs
//
// What it checks is what the container itself promises: no network, a user a job, limits that hold, the tools there.
const TOKEN = process.env.TOKEN ?? "";
const BASE = process.env.WORKSHOP ?? "http://127.0.0.1:9377";
let fail = 0;
const check = (name, ok, got) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : ` ${JSON.stringify(got).slice(0, 500)}`}`);
};
const send = (what, o, headers = {}) =>
  fetch(`${BASE}/v1/${what}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: JSON.stringify(o) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const stamp = Date.now().toString(36);
const A = `jcheck${stamp}a`;
const B = `jcheck${stamp}b`;
const run = (cmd, job = A, more = {}) => send("run", { job, cmd, ...more });

console.log("who may ask");
check("Jarvis", (await fetch(`${BASE}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.status)) === 200);
check("not without the token", (await fetch(`${BASE}/v1/health`).then((r) => r.status)) === 401);
check("not a page, with it", (await send("run", { job: A, cmd: "id" }, { origin: "https://shop.example" })).status === 403);

console.log("a job is its own user, with no network");
const id = await run("id -u; id -G; pwd; umask");
const uid = Number(String(id.out).split("\n")[0]);
check("a user of its own, in no group but its own", uid >= 20000 && String(id.out).split("\n")[1] === String(uid), id);
check("another job, another user", Number((await run("id -u", B)).out) !== uid);
const net = await run("python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"; python3 -c \"import socket; print(socket.gethostbyname('example.com'))\"; for i in /sys/class/net/*; do [ $(($(cat $i/flags) & 1)) = 1 ] && echo up: ${i##*/}; done; ls /sys/class/net");
// An older kernel puts a tunnel's device (sit0) in every container: it is down, and nothing here may put it up.
check("it can reach nothing, and look nothing up", /unreachable/i.test(net.out) && /resol|Name or service/i.test(net.out) && /\nup: lo\n(?!up:)/.test(net.out), net);
const raise = await run("python3 -c \"import fcntl,socket,struct; s=socket.socket(); n=b'sit0' if 'sit0' in [x[1] for x in socket.if_nameindex()] else b'lo'; fcntl.ioctl(s, 0x8914, struct.pack('16sH14x', n, 0x41)); print('CHANGED')\"");
check("nor change its network", /not permitted/i.test(raise.out) && !/CHANGED/.test(raise.out), raise);
await run("echo secret > mine; mkdir -p d; chmod 755 . mine; chmod 755 .. ", B);
const peep = await run(`cat /work/${B}/f/mine; ls /work/${B} /work/${B}/f /work; echo x > /work/${B}/f/y; cd /work/${B}/f && echo IN`);
check("another's folder, though it opened it: not to be entered, read or written", !/secret|\bIN\b|mine\n/.test(peep.out) && /denied/i.test(peep.out), peep);
check("nor what is kept of what it gave", /denied|No such/i.test((await run(`ls /work/.given; ls -la /work`)).out));
const open = await run("find / -path /proc -prune -o -path /dev/mqueue -prune -o -type d -writable -print 2>/dev/null | grep -v '^/work/'; for d in /tmp /var/tmp /dev/shm /dev/mqueue /run /dev; do : > $d/x$$ && echo WROTE $d; done 2>/dev/null; echo none");
check("no place every job may write", open.out === "none\n", open);
await run("ipcmk -M 4096 -p 0666; ipcmk -Q -p 0666; ipcmk -S 1 -p 0666", B);
check("nor any shared memory left for another", (await run("ipcs -a | grep -c '^0x'")).out.trim() === "0");
check("the socket it was asked through", /EACCES|denied/i.test((await run("node -e \"require('net').connect('/run/workshop/sock').on('error',e=>console.log(e.code)).on('connect',()=>console.log('OPEN'))\"")).out));
check("the runner: not to be ended, or read", /not permitted/i.test((await run("kill -9 1; cat /proc/1/environ")).out));
check("nothing that runs as somebody else", (await run("find / -xdev -perm /6000 -type f 2>/dev/null | wc -l")).out.trim() === "0");
check("no new powers, whatever it runs", /no_new_privs: 1/.test((await run("setpriv -d")).out));
check("the rest of it cannot be written", /read-only/i.test((await run("touch /x /opt/workshop/x /usr/bin/x")).out));
await run("printf 'touch sourced; exec sleep 30\\n' | tee .bashrc .profile .bash_profile > .home/.bashrc; cp .bashrc .home/.profile");
const t9 = Date.now();
const rc = await send("file", { job: A, op: "list" });
check("its own start-up files are nobody's", rc.status === 200 && !JSON.stringify(rc.files).includes("sourced") && Date.now() - t9 < 10_000, rc);
await run("rm -f .bashrc .profile .bash_profile .home/.*rc .home/.profile");
const build = await run("for t in gcc cc g++ c++ cpp ld as make pip pip3 npm npx yarn corepack curl wget ssh git; do command -v $t; done; ls /usr/bin | grep -E 'gcc|g[+][+]|-ld$'; ls -d /usr/lib/gcc/*/*/cc1* 2>/dev/null; echo none");
check("no compiler, and no way to fetch one", build.out === "none\n", build);
check("no Docker, and nothing of Jarvis's", (await run("ls /var/run/docker.sock /data /app 2>&1 | grep -vc 'No such'; env | grep -ci 'token\\|secret'")).out.trim() === "0\n0");

console.log("its limits");
const t0 = Date.now();
const mem = await run("python3 -c \"a=[bytearray(10**7) for _ in range(300)]; print('GOT' + ' IT')\"", A, { seconds: 100 });
check("out of memory: ended, soon", mem.code === 137 && !/GOT IT/.test(mem.out) && Date.now() - t0 < 90_000, { mem, ms: Date.now() - t0 });
check("…and the workshop goes on", (await run("echo still here")).out === "still here\n");
const bomb = await run("for i in $(seq 1 900); do sleep 4 & done 2>/dev/null; jobs -p | wc -l", A, { seconds: 30 });
check("a great many processes: held", Number(bomb.out) < 320 || bomb.code !== 0, bomb);
check("…and another job is not, nor its own next", (await run("echo fine", B)).out === "fine\n" && (await run("echo mine")).out === "mine\n");
const dead = await run("for i in $(seq 1 200); do (setsid sleep 0.01 &) ; done; sleep 2; grep -l '^State:.Z' /proc/[0-9]*/status 2>/dev/null | wc -l");
check("the ends of those left without a parent are read", Number(dead.out) < 20, dead);
// Room taken at once, with nothing written: however fast or slow the disk, it is there before anything is looked at.
const take = (n) => `for i in $(seq ${n}); do fallocate -l 150000000 f$i || head -c 150000000 /dev/zero > f$i; done; `;
const full = await run(`${take(4)}sleep 60; echo ALL`, A, { seconds: 100 });
check("a folder too full: stopped", full.full === true && !full.emptied && full.kb > 500_000 && !/ALL/.test(full.out), full);
const more = await run("head -c 1000 /dev/zero > more; fallocate -l 1000 even; echo $(stat -c %s more even)");
check("…and may have no more written to it", /^0 0$/m.test(more.out), more);
check("…until it removes what it wrote", (await run("rm -f f* more even; echo gone")).out === "gone\n" && (await run("echo again > x; cat x")).out === "again\n" && (await send("file", { job: A, op: "write", path: "x", text: "x" })).size === 1);
const burst = await run(`mkdir d; cd d; ${take(4)}cd ..; chmod 000 d; echo ALL`);
check("…by one that ended first, and closed it: counted", /ALL/.test(burst.out) && burst.kb > 500_000 && (await run("chmod 700 d; rm -r d; echo gone")).out === "gone\n", burst);
const kept = await send("give", { job: A, path: "x" });
const far = await run(`${take(15)}echo ALL`, A, { seconds: 100 });
check("far too full: nothing of it is left", far.emptied === true && far.kb < 1000 && (await run("ls")).out === "", far);
check("…but what it gave, and another job's", (await fetch(`${BASE}/v1/given?job=${A}&sum=${kept.sha256}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text())) === "x" && (await run("cat mine", B)).out === "secret\n", kept);
check("a file too big: stopped", /exceeded|too large/i.test((await run("head -c 400000000 /dev/zero > big; ls -l big | awk '{print $5}'; rm -f big")).out));
check("time: stopped", (await run("while :; do :; done", A, { seconds: 2 })).late === true);
await run("sleep 30 & kill -9 -1; kill -9 1; true");
check("it may end only its own", (await run("echo both", B)).out === "both\n" && (await run("echo mine")).out === "mine\n");

console.log("one job at a time, and nothing outlives its turn");
const others = "for f in /proc/[0-9]*/status; do awk '/^Uid:/ {print $2}' $f; done 2>/dev/null | awk '$1 >= 20000' | sort -u";
await run("setsid sleep 700 >/dev/null 2>&1 & setsid python3 -c \"import os\nwhile True:\n  try: os.kill(-1, 9)\n  except Exception: pass\" >/dev/null 2>&1 & sleep 1");
const after = await run(others, B);
check("what a command left, however it left it, and whatever it did to stay", after.out.trim().split("\n").length === 1 && after.out.trim() !== String(uid), after);
await run("sleep 4; echo slept", A, { background: true });
const t8 = Date.now();
const seen = await run(`${others}; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' | grep -c 'slee[p] 4'`, B);
check("another job's begins when this one's has ended, and sees nothing of it", Date.now() - t8 > 2500 && seen.out.trim().split("\n").length === 2 && seen.out.trim().endsWith("0"), { seen, ms: Date.now() - t8 });

console.log("what there is to work with");
const py = await run("python3 -c \"import pandas, openpyxl, docx, reportlab, pypdf, matplotlib, PIL, markdown, jinja2, bs4, lxml, yaml, weasyprint; print('all')\"", A, { seconds: 60 });
check("Python, for tables, documents, PDFs and charts", py.out.trim().endsWith("all"), py);
const tools = await run("for t in node python3 pandoc pdftotext qpdf hugo jq rg zip unzip sqlite3 file; do command -v $t >/dev/null || echo missing $t; done; echo checked");
check("and the rest", tools.out === "checked\n", tools);
const made = await run(
  "python3 - <<'PY'\nimport pandas as pd, matplotlib.pyplot as plt\nfrom docx import Document\nfrom reportlab.pdfgen import canvas\nd = pd.DataFrame({'month': ['Jan', 'Feb'], 'kWh': [120, 98]})\nd.to_excel('power.xlsx', index=False)\nd.plot.bar(x='month', y='kWh'); plt.savefig('power.png')\nx = Document(); x.add_heading('Power'); x.save('power.docx')\nc = canvas.Canvas('power.pdf'); c.drawString(72, 720, 'Power, 218 kWh'); c.save()\nfrom weasyprint import HTML\nHTML(string='<h1>Power in all</h1>').write_pdf('page.pdf')\nPY\npdftotext power.pdf - | head -1; pdftotext page.pdf - | head -1; hugo new site s >/dev/null 2>&1; echo '# Hi' > s/content/a.md; mkdir -p s/layouts/_default && echo '{{ .Content }}' > s/layouts/_default/single.html; (cd s && hugo --quiet && ls public/a/index.html); pandoc s/content/a.md -o a.html && ls *.xlsx *.png *.docx *.pdf a.html | wc -l; ls",
  A, { seconds: 100 },
);
check("a spreadsheet, a chart, a document, a PDF and a small site, offline", /Power, 218 kWh/.test(made.out) && /Power in all/.test(made.out) && /public\/a\/index\.html/.test(made.out) && /\n6\n/.test(made.out), made);
const gave = await send("give", { job: A, path: "power.xlsx" });
const got = await fetch(`${BASE}/v1/given?job=${A}&sum=${gave.sha256}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => Buffer.from(await r.arrayBuffer()));
check("given: the same bytes, as they were", gave.size === got.length && got.subarray(0, 2).toString() === "PK", { gave, n: got.length });

console.log("over");
const wasB = Number((await run("id -u; mkdir -p keep/in; echo private > keep/in/mail.txt; chmod 000 keep/in keep", B)).out);
await run("setsid sleep 700 > /dev/null 2>&1 & sleep 60", B, { background: true });
check("ended, with what it was running, and the folders it closed", (await send("end", { job: B })).ended === true);
check("…all of it gone", (await run(`ls -d /work/${B} 2>&1 | grep -c 'No such'; ${others}`)).out.trim() === `1\n${uid}`);
const C2 = `jcheck${stamp}c`;
const next = Number((await run("id -u", C2)).out);
check("a user is never another job's", next > uid && next > wasB, { uid, wasB, next });
await send("end", { job: A });
await send("end", { job: C2 });
check("nothing is left", (await fetch(`${BASE}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())).jobs === 0);

console.log(fail ? `\n${fail} failed` : "\nall of it");
process.exit(fail ? 1 : 0);
