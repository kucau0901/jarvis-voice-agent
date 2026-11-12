// A made-up school, as a Jarvis component (docs/components.md): who is absent,
// the timetable, and relief when a teacher is on leave. It shows the whole
// contract in one file with no dependencies:
//
//   tools     an MCP server, hand-written JSON-RPC over one POST each
//   manifest  the resource jarvis://manifest, naming the event it reports
//   reports   "a teacher filed leave", posted to its address at Jarvis, with
//             the relief plan as a suggested action
//
//   node school.mjs          Node 20 or newer; see README.md beside this file
//
// Everything in it is invented: the teachers, the classes, the timetable.

const TEACHERS = { T1: "Mr Lim", T2: "Ms Devi", T3: "Mr Hassan", T4: "Ms Wong", T5: "Mr Kumar" };
/** The same every school day: for each period, who teaches which class. Anyone not named is free. */
const TIMETABLE = {
  1: { T1: "4A Maths", T2: "4B Science", T3: "5A History" },
  2: { T1: "5A Maths", T4: "4A English", T5: "4B PE" },
  3: { T2: "4A Science", T3: "4B History", T4: "5A English" },
  4: { T1: "4B Maths", T5: "5A PE", T2: "4A Science" },
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What Jarvis reads once, when an admin has it ask what this component offers, and pins when they approve. */
export const MANIFEST = { jarvis: 1, events: [{ type: "leave_filed", says: "A teacher filed leave" }] };

const date = { type: "string", description: "The school day, YYYY-MM-DD." };
/**
 * The tools. Names say what each does: a tool that only looks something up
 * starts with get_ or find_, and says so too (readOnlyHint), so Jarvis offers
 * it wherever reading is allowed. apply_relief changes the timetable, so its
 * name does not read like a look-up, and Jarvis asks someone before using it
 * with nobody there, unless the owner said it may run by itself.
 */
export const TOOLS = [
  { name: "get_absent", description: "Who is absent on a school day.", inputSchema: { type: "object", properties: { date }, required: ["date"] }, annotations: { readOnlyHint: true } },
  {
    name: "get_timetable",
    description: "A teacher's lessons on a school day, with any relief they are covering. Leave teacher out for whoever is asking.",
    inputSchema: { type: "object", properties: { teacher: { type: "string", description: "A teacher's id (T1) or name." }, date }, required: ["date"] },
    annotations: { readOnlyHint: true },
  },
  { name: "find_relief", description: "The relief plans for a school day's absences: who could cover each lesson. Changes nothing.", inputSchema: { type: "object", properties: { date }, required: ["date"] }, annotations: { readOnlyHint: true } },
  {
    name: "apply_relief",
    description: "Put a relief plan into force for a school day: plan A or B, as find_relief names them. Checks the absences again as it acts, and is safe to call twice.",
    inputSchema: { type: "object", properties: { date, plan: { type: "string", enum: ["A", "B"] } }, required: ["date", "plan"] },
    annotations: { readOnlyHint: false },
  },
];

const named = (id) => `${TEACHERS[id]} (${id})`;
const lessonsOf = (id) => Object.entries(TIMETABLE).flatMap(([period, who]) => (who[id] ? [{ period: Number(period), lesson: who[id] }] : []));
const teacherOf = (said) => Object.keys(TEACHERS).find((id) => id === String(said).toUpperCase() || TEACHERS[id].toLowerCase() === String(said).toLowerCase());

/**
 * One school. `key`: what Jarvis must present (the key typed in Settings →
 * Components); `office`: the staff who may apply relief, by their own ids;
 * `jarvis`: where it reports, and the token of its address there.
 */
export function createSchool({ key = "", office = ["T1"], jarvis = null } = {}) {
  /** date → the ids of who is on leave. */
  const absent = new Map();
  /** date → the plan in force. */
  const applied = new Map();
  const away = (day) => [...(absent.get(day) ?? [])];

  /** The two plans for a day: for each lesson of someone absent, a teacher who is free then and is here. */
  function plans(day) {
    const gone = away(day);
    const lessons = gone.flatMap((id) => lessonsOf(id).map((l) => ({ ...l, for: id })));
    const plan = (pick) =>
      lessons.map((l) => {
        const free = Object.keys(TEACHERS).filter((id) => !gone.includes(id) && !TIMETABLE[l.period][id]);
        // Plan A asks least of the busiest: whoever teaches least that day. Plan B is the next choice.
        free.sort((a, b) => lessonsOf(a).length - lessonsOf(b).length || a.localeCompare(b));
        return { ...l, relief: free[Math.min(pick, free.length - 1)] ?? null };
      });
    return { A: plan(0), B: plan(1) };
  }
  const planSaid = (rows) => rows.map((r) => `period ${r.period} ${r.lesson}: ${r.relief ? named(r.relief) : "nobody is free"} for ${TEACHERS[r.for]}`).join("; ");

  const tools = {
    get_absent({ date: day }) {
      return away(day).length ? `Absent on ${day}: ${away(day).map(named).join(", ")}.` : `Nobody is absent on ${day}.`;
    },
    // Who is asking, when someone is: the id an admin mapped for them in Jarvis (X-Jarvis-Person).
    get_timetable({ teacher, date: day }, person) {
      const id = teacherOf(teacher ?? person ?? "");
      if (!id) throw new Error(teacher ? `No teacher is called ${teacher}.` : "Say which teacher: nobody is asking as one.");
      const own = lessonsOf(id).map((l) => `period ${l.period} ${l.lesson}`);
      const cover = applied.has(day) ? plans(day)[applied.get(day)].filter((r) => r.relief === id).map((r) => `period ${r.period} ${r.lesson} (relief for ${TEACHERS[r.for]})`) : [];
      if (away(day).includes(id)) return `${named(id)} is on leave on ${day}.`;
      return `${named(id)} on ${day}: ${[...own, ...cover].join("; ") || "no lessons"}.`;
    },
    find_relief({ date: day }) {
      if (!away(day).length) return `Nobody is absent on ${day}: no relief is needed.`;
      const p = plans(day);
      return `Plan A: ${planSaid(p.A)}.\nPlan B: ${planSaid(p.B)}.${applied.has(day) ? `\nIn force: plan ${applied.get(day)}.` : ""}`;
    },
    /**
     * The one that acts. Jarvis may call it long after the plan was found
     * (a card someone approves the next morning), and may call it by
     * itself, so it trusts nothing it was told earlier: it reads the
     * absences again now, and calling it twice changes nothing the second time.
     */
    apply_relief({ date: day, plan }, person) {
      // The school's own rule, kept here and not in Jarvis: with someone asking, only the office may.
      if (person && !office.includes(person)) throw new Error(`Only the timetable office may apply relief, and ${person} is not in it.`);
      if (plan !== "A" && plan !== "B") throw new Error("plan is A or B.");
      if (!away(day).length) throw new Error(`Nobody is absent on ${day} any more: nothing was applied.`);
      const rows = plans(day)[plan];
      const gap = rows.find((r) => !r.relief);
      if (gap) throw new Error(`Plan ${plan} no longer covers period ${gap.period} ${gap.lesson}: nothing was applied.`);
      if (applied.get(day) === plan) return `Plan ${plan} is already in force for ${day}: nothing changed.`;
      const was = applied.get(day);
      applied.set(day, plan);
      return `Plan ${plan} is in force for ${day}${was ? `, in place of plan ${was}` : ""}: ${planSaid(rows)}.`;
    },
  };

  /** One tool call: its words, or an error the tool reports. */
  function call(name, args, person) {
    const tool = tools[name];
    if (!tool) return { content: [{ type: "text", text: `No tool is called ${name}.` }], isError: true };
    if (!DATE.test(String(args.date ?? ""))) return { content: [{ type: "text", text: "date is YYYY-MM-DD." }], isError: true };
    try {
      return { content: [{ type: "text", text: tool(args, person) }], isError: false };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  }

  const reply = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
  const refuse = (id, code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

  /**
   * The MCP endpoint: Streamable HTTP without the stream. Each POST carries
   * one JSON-RPC message and is answered with one JSON object; no session is
   * kept. Jarvis sends its key with every request, follows no redirect, and
   * never reads `instructions`, so none are sent.
   */
  async function handle(request) {
    if (key && request.headers.get("authorization") !== `Bearer ${key}`) return new Response("unauthorized", { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const msg = await request.json().catch(() => null);
    if (!msg || msg.jsonrpc !== "2.0") return refuse(null, -32600, "one JSON-RPC 2.0 message per request");
    // A notification, or the client's answer to something: nothing to say back.
    if (msg.id === undefined || typeof msg.method !== "string") return new Response(null, { status: 202 });
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        // Jarvis needs `tools` here; `resources` is for the manifest.
        return reply(msg.id, { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "school", version: "1.0.0" } });
      case "ping":
        return reply(msg.id, {});
      case "tools/list":
        return reply(msg.id, { tools: TOOLS });
      case "tools/call":
        return reply(msg.id, call(String(params.name), params.arguments ?? {}, request.headers.get("x-jarvis-person")));
      case "resources/list":
        return reply(msg.id, { resources: [{ uri: "jarvis://manifest", name: "Jarvis manifest", mimeType: "application/json" }] });
      case "resources/read":
        if (params.uri !== "jarvis://manifest") return refuse(msg.id, -32602, "Resource not found");
        return reply(msg.id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(MANIFEST) }] });
      default:
        return refuse(msg.id, -32601, `no method ${msg.method}`);
    }
  }

  /**
   * A teacher files leave (the school's own front desk does this, not
   * Jarvis). The school records it, then tells Jarvis: an event, in the
   * school's words, with plan A as something Jarvis may do about it. Jarvis
   * decides who hears it, and whether to ask someone first. What Jarvis
   * answered comes back, or null when it has no address at Jarvis.
   */
  async function fileLeave(teacher, day) {
    const id = teacherOf(teacher);
    if (!id || !DATE.test(day)) throw new Error("a teacher (T1, or a name) and a date (YYYY-MM-DD) are needed");
    absent.set(day, new Set([...away(day), id]));
    // The plan in force was made for other absences: it is decided again.
    applied.delete(day);
    const covered = plans(day).A.every((r) => r.relief);
    const event = {
      type: "leave_filed",
      // The same leave told twice (a retry) is taken once.
      id: `leave-${id}-${day}`,
      level: "notice",
      text: `${TEACHERS[id]} is on leave on ${day}. ${lessonsOf(id).length ? `Periods ${lessonsOf(id).map((l) => l.period).join(", ")} need cover.` : "No lessons need cover."}`,
      ...(covered && lessonsOf(id).length ? { actions: [{ tool: "apply_relief", args: { date: day, plan: "A" } }] } : {}),
    };
    if (!jarvis) return { event, answer: null };
    const r = await fetch(jarvis.events, { method: "POST", headers: { authorization: `Bearer ${jarvis.token}`, "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) });
    return { event, answer: r.ok ? await r.json() : { ok: false, status: r.status } };
  }

  /** Leave withdrawn: the day's plan no longer stands either. */
  function withdrawLeave(teacher, day) {
    const id = teacherOf(teacher);
    absent.set(day, new Set(away(day).filter((x) => x !== id)));
    applied.delete(day);
  }

  return { handle, fileLeave, withdrawLeave, inForce: (day) => applied.get(day) ?? null };
}

/* ---------- run as a program: the MCP endpoint at /mcp, and the front desk at /leave ---------- */

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { createServer } = await import("node:http");
  const env = process.env;
  const school = createSchool({
    key: env.SCHOOL_KEY ?? "",
    office: (env.SCHOOL_OFFICE ?? "T1").split(","),
    jarvis: env.JARVIS_EVENTS && env.JARVIS_TOKEN ? { events: env.JARVIS_EVENTS, token: env.JARVIS_TOKEN } : null,
  });
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = async (r) => {
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    };
    try {
      if (req.url === "/mcp") {
        return await send(await school.handle(new Request(`http://school${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) })));
      }
      // The front desk: POST /leave {"teacher": "T1", "date": "2026-11-13"}, with the school's key.
      if (req.url === "/leave" && req.method === "POST" && (!env.SCHOOL_KEY || req.headers.authorization === `Bearer ${env.SCHOOL_KEY}`)) {
        const { teacher, date: day } = JSON.parse(body.toString() || "{}");
        return await send(Response.json(await school.fileLeave(teacher, day)));
      }
      await send(new Response("not found", { status: 404 }));
    } catch (e) {
      await send(Response.json({ error: e.message }, { status: 400 }));
    }
  }).listen(Number(env.PORT ?? 8787), () => console.log(`school: listening on ${env.PORT ?? 8787} (MCP at /mcp, the front desk at /leave)`));
}
