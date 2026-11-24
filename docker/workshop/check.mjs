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
const net = await run("python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"; python3 -c \"import socket; print(socket.gethostbyname('example.com'))\"; ls /sys/class/net");
check("it can reach nothing, and look nothing up", /unreachable/i.test(net.out) && /resol|Name or service/i.test(net.out) && /\nlo\n$/.test(net.out), net);
await run("echo secret > mine; mkdir -p d; chmod 755 . mine", B);
check("another's folder: not to be seen into, read or written", /denied/i.test((await run(`ls /work/${B}; cat /work/${B}/mine; echo x > /work/${B}/y`)).out) === true && (await run(`ls /work/${B} /work 2>/dev/null | wc -l`)).out.trim() === "0");
check("the socket it was asked through", /EACCES|denied/i.test((await run("node -e \"require('net').connect('/run/workshop/sock').on('error',e=>console.log(e.code)).on('connect',()=>console.log('OPEN'))\"")).out));
check("the runner: not to be ended, or read", /not permitted/i.test((await run("kill -9 1; cat /proc/1/environ")).out));
check("nothing that runs as somebody else", (await run("find / -xdev -perm /6000 -type f 2>/dev/null | wc -l")).out.trim() === "0");
check("no new powers, whatever it runs", /no_new_privs: 1/.test((await run("setpriv -d")).out));
check("the rest of it cannot be written", /read-only/i.test((await run("touch /x /opt/workshop/x /usr/bin/x")).out));
check("nothing is run from /tmp", /denied/i.test((await run("printf '#!/bin/sh\\necho ran' > /tmp/x$$; chmod +x /tmp/x$$; /tmp/x$$")).out));
check("no compiler, and no way to fetch one", (await run("for t in gcc cc g++ make pip pip3 npm npx yarn curl wget ssh git apt-get; do command -v $t; done | grep -v apt-get | wc -l")).out.trim() === "0");
check("no Docker, and nothing of Jarvis's", (await run("ls /var/run/docker.sock /data /app 2>&1 | grep -vc 'No such'; env | grep -ci 'token\\|secret'")).out.trim() === "0\n0");

console.log("its limits");
const t0 = Date.now();
const mem = await run("python3 -c \"a=[bytearray(10**7) for _ in range(300)]; print('GOT IT')\"", A, { seconds: 100 });
check("out of memory: ended, soon", mem.code !== 0 && !/GOT IT/.test(mem.out) && Date.now() - t0 < 90_000, { mem, ms: Date.now() - t0 });
check("…and the workshop goes on", (await run("echo still here")).out === "still here\n");
const bomb = await run("for i in $(seq 1 900); do sleep 4 & done 2>/dev/null; jobs -p | wc -l", A, { seconds: 30 });
check("a great many processes: held", Number(bomb.out) < 320 || bomb.code !== 0, bomb);
check("…and another job is not", (await run("echo fine", B)).out === "fine\n");
check("a file too big: stopped", /exceeded|too large/i.test((await run("head -c 400000000 /dev/zero > big; ls -l big | awk '{print $5}'; rm -f big")).out));
check("time: stopped", (await run("while :; do :; done", A, { seconds: 2 })).late === true);
const own = await run("kill -9 -1; echo not said");
check("it may end only its own", !/not said/.test(own.out) && (await run("echo both", B)).out === "both\n");

console.log("what there is to work with");
const py = await run("python3 -c \"import pandas, openpyxl, docx, reportlab, pypdf, matplotlib, PIL, markdown, jinja2, bs4, lxml, yaml; print('all')\"", A, { seconds: 60 });
check("Python, for tables, documents, PDFs and charts", py.out.trim().endsWith("all"), py);
const tools = await run("for t in node python3 pandoc pdftotext qpdf hugo jq rg zip unzip sqlite3 file; do command -v $t >/dev/null || echo missing $t; done; echo checked");
check("and the rest", tools.out === "checked\n", tools);
const made = await run(
  "python3 - <<'PY'\nimport pandas as pd, matplotlib.pyplot as plt\nfrom docx import Document\nfrom reportlab.pdfgen import canvas\nd = pd.DataFrame({'month': ['Jan', 'Feb'], 'kWh': [120, 98]})\nd.to_excel('power.xlsx', index=False)\nd.plot.bar(x='month', y='kWh'); plt.savefig('power.png')\nx = Document(); x.add_heading('Power'); x.save('power.docx')\nc = canvas.Canvas('power.pdf'); c.drawString(72, 720, 'Power, 218 kWh'); c.save()\nPY\npdftotext power.pdf - | head -1; hugo new site s >/dev/null 2>&1; echo '# Hi' > s/content/a.md; mkdir -p s/layouts/_default && echo '{{ .Content }}' > s/layouts/_default/single.html; (cd s && hugo --quiet && ls public/a/index.html); pandoc s/content/a.md -o a.html && ls *.xlsx *.png *.docx *.pdf a.html | wc -l",
  A, { seconds: 100 },
);
check("a spreadsheet, a chart, a document, a PDF and a small site, offline", /Power, 218 kWh/.test(made.out) && /public\/a\/index\.html/.test(made.out) && made.out.trim().endsWith("5"), made);
const gave = await send("give", { job: A, path: "power.xlsx", n: 1 });
const got = await fetch(`${BASE}/v1/given?job=${A}&n=1`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => Buffer.from(await r.arrayBuffer()));
check("given: the same bytes, as they were", gave.size === got.length && got.subarray(0, 2).toString() === "PK", { gave, n: got.length });

console.log("over");
await run("setsid sleep 700 > /dev/null 2>&1 & setsid sleep 701 > /dev/null 2>&1 &", B);
check("ended", (await send("end", { job: B })).ended === true);
const left = await run("grep -lE '^Uid:' /proc/[0-9]*/status 2>/dev/null | while read f; do grep -E '^Uid:' $f; done | awk '$2 >= 20000 {print $2}' | sort -u");
check("…with everything it left running, however", left.out.trim() === String(uid), left);
check("…and its files", (await run(`ls -d /work/${B} 2>&1 | grep -c 'No such'`)).out.trim() === "1");
await send("end", { job: A });

console.log(fail ? `\n${fail} failed` : "\nall of it");
process.exit(fail ? 1 : 0);
