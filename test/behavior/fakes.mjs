// Stand-ins for OpenAI and Home Assistant, for the behavior checks
// (test/behavior/check.mjs): the whole of Jarvis runs locally, with nothing
// real behind it. The fake OpenAI is scripted: it reads the last thing the
// user said and calls the tool a real model would, if Jarvis offered it that
// tool — so a person who may not use a tool is never given it, exactly as live.
// It records which tools each question was offered, which is how a change to
// what a person may reach shows up in a comparison.
import http from "node:http";

const log = [];
const note = (s) => {
  log.push(s);
  if (log.length > 500) log.shift();
};

/* ---------- OpenAI (Responses API, as much as Jarvis uses) ------------------ */

let n = 0;
const responses = new Map();
const id = (p) => `${p}_${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function lastUserLine(input) {
  const users = (input ?? []).filter((i) => i.role === "user");
  for (let k = users.length - 1; k >= 0; k--) {
    const c = users[k].content;
    const text = typeof c === "string" ? c : (c ?? []).map((x) => x.text ?? "").join("\n");
    if (text.startsWith("Conversation so far:")) {
      const lines = text.split("\n").filter((l) => l.startsWith("User: "));
      return lines.length ? lines[lines.length - 1].slice(6) : "";
    }
  }
  return "";
}

/** What the fake model does with a request: a tool call if one fits and is offered, else words. */
function decide(text, tools) {
  const has = (name) => tools.some((t) => t.name === name);
  const call = (name, args) => (has(name) ? { name, args } : { say: `I can't do that for you (no ${name}).` });
  let m;
  const t = text.trim();
  if (/^ask hermes/i.test(t)) return call("ask_hermes", { question: t });
  if ((m = /^remind (everyone|\w+) to (.+?)(?: in (\d+) minutes?)?(?: within (\d+) minutes?)?$/i.exec(t)))
    return call("pass_on", { to: m[1], kind: "remind", text: m[2], local_time: null, in_minutes: m[3] ? +m[3] : null, when_home: /when (she|he|they) gets? home/i.test(t), answer_within_minutes: m[4] ? +m[4] : null });
  if ((m = /^remind (\w+) when (?:she|he|they) gets? home to (.+)$/i.exec(t)))
    return call("pass_on", { to: m[1], kind: "remind", text: m[2], local_time: null, in_minutes: null, when_home: true, answer_within_minutes: null });
  if ((m = /^ask (everyone|\w+) (.+)$/i.exec(t)))
    return call("pass_on", { to: m[1], kind: "ask", text: m[2], local_time: null, in_minutes: null, when_home: null, answer_within_minutes: null });
  if ((m = /^tell (everyone|\w+) (.+)$/i.exec(t)))
    return call("pass_on", { to: m[1], kind: "tell", text: m[2], local_time: null, in_minutes: null, when_home: null, answer_within_minutes: null });
  if (/^done\b/i.test(t)) return call("answer_message", { id: null, status: "done", answer: null });
  if ((m = /^answer: (.+)$/i.exec(t))) return call("answer_message", { id: null, status: "answered", answer: m[1] });
  if ((m = /^remember for the family that (.+)$/i.exec(t))) return call("remember", { text: m[1], kind: "note", place: null, replaces: null, pin: null, more: null, for_family: true });
  if ((m = /^remember that (.+)$/i.exec(t))) return call("remember", { text: m[1], kind: "note", place: null, replaces: null, pin: null, more: null, for_family: null });
  if ((m = /^recall (.+)$/i.exec(t))) return call("recall", { query: m[1], limit: 5 });
  if ((m = /^open the (.+)$/i.exec(t))) return has("use_pass") ? call("use_pass", { thing: m[1], action: "open" }) : { say: "The house tools would do that." };
  if (/still open|did .* get my/i.test(t)) return call("family_messages", {});
  if ((m = /^every day at (\d\d:\d\d) ask (\w+) (.+?)(?:, and tell the family)?(?: within (\d+) minutes?)?$/i.exec(t)))
    return call("routine_add", { name: null, when: "daily", local_time: null, in_minutes: null, time: m[1], days: null, event: null, buffer_min: null, condition: null, for_minutes: null, say: null, ask: m[3], pass_to: [m[2]], pass_kind: "ask", points: null, escalate: /tell the family/i.test(t), answer_within_minutes: m[4] ? +m[4] : null });
  if ((m = /^every day at (\d\d:\d\d) remind (\w+) and (\w+) in turn to (.+?), (\d+) points$/i.exec(t)))
    return call("routine_add", { name: null, when: "daily", local_time: null, in_minutes: null, time: m[1], days: null, event: null, buffer_min: null, condition: null, for_minutes: null, say: m[4], ask: null, pass_to: [m[2], m[3]], pass_kind: "remind", points: +m[5], escalate: null, answer_within_minutes: null });
  if (/points/i.test(t)) return call("chore_points", {});
  if ((m = /^(?:is|where is) (.+?)(?: charged| now)?\??$/i.exec(t)) && /car/i.test(t)) return call("car_state", { what: "battery", car: /mum|sara/i.test(t) ? "Sara's car" : null });
  if (/^unlock (.+)$/i.test(t)) return call("car_command", { command: "unlock", value: null, temperature: null, percent: null, car: t.replace(/^unlock /i, "") });
  return { say: `Fake answer to: ${t}` };
}

function responseOf(body) {
  const tools = (body.tools ?? []).filter((t) => t.type === "function");
  const outputs = (Array.isArray(body.input) ? body.input : []).filter((i) => i.type === "function_call_output");
  let output;
  let text = "";
  if (outputs.length) {
    // After the tools: say what they said.
    text = outputs.map((o) => String(o.output).split("\n")[0]).join(" | ");
    output = [{ type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
  } else {
    const said = lastUserLine(body.input);
    const d = decide(said, tools);
    note({ said, did: d.name ?? "says", offered: tools.map((t) => t.name).sort() });
    if (d.name) {
      output = [{ type: "function_call", id: id("fc"), call_id: id("call"), name: d.name, arguments: JSON.stringify(d.args), status: "completed" }];
    } else {
      text = d.say;
      output = [{ type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
    }
  }
  const r = {
    id: id("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? "fake",
    output,
    output_text: text,
    usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1240 },
  };
  responses.set(r.id, r);
  return r;
}

const openai = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : {};
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const url = req.url ?? "";
  if (url.startsWith("/v1/models")) return send(200, { object: "list", data: ["gpt-6-luna", "gpt-6-sol", "gpt-live-1"].map((id) => ({ id, object: "model" })) });
  if (url === "/v1/responses" && req.method === "POST") return send(200, responseOf(body));
  const got = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(url);
  if (got) return send(200, responses.get(got[1]) ?? { id: got[1], status: "cancelled", output: [] });
  if (url === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dim = body.dimensions ?? 256;
    return send(200, { data: inputs.map((s, i) => ({ index: i, embedding: Array.from({ length: dim }, (_, k) => Math.sin((String(s).length + 1) * (k + 1))) })) });
  }
  if (url === "/__log") return send(200, log);
  send(404, { error: { message: `fake openai has no ${url}` } });
});

/* ---------- Home Assistant -------------------------------------------------- */

const presence = { "person.aisyah": false, "person.sara": true };
const calls = [];
const states = [
  { entity_id: "cover.main_gate", state: "closed", attributes: { friendly_name: "Main gate" } },
  { entity_id: "cover.garage_door", state: "closed", attributes: { friendly_name: "Garage door" } },
  { entity_id: "switch.garden_lights", state: "off", attributes: { friendly_name: "Garden lights" } },
  { entity_id: "light.porch", state: "off", attributes: { friendly_name: "Porch light" } },
  { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
  { entity_id: "sensor.outside_temperature", state: "31", attributes: { friendly_name: "Outside" } },
];

const ha = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : {};
  const url = req.url ?? "";
  const send = (status, data, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof data === "string" ? data : JSON.stringify(data));
  };
  if (url === "/__presence" && req.method === "POST") {
    presence[body.entity] = !!body.home;
    return send(200, presence);
  }
  if (url === "/__calls") return send(200, calls);
  if (req.headers.authorization !== "Bearer fake-ha-token") return send(401, { message: "401: Unauthorized" });
  if (url === "/api/") return send(200, { message: "API running." });
  if (url === "/api/states") {
    const people = Object.entries(presence).map(([entity_id, home]) => ({ entity_id, state: home ? "home" : "not_home", attributes: { friendly_name: entity_id } }));
    return send(200, [...states, ...people]);
  }
  const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url);
  if (svc) {
    calls.push({ at: Date.now(), domain: svc[1], service: svc[2], entity: body.entity_id });
    note({ house: `${svc[1]}.${svc[2]}`, entity: body.entity_id });
    return send(200, []);
  }
  if (url === "/api/template") {
    const m = /is_state\('([^']+)',\s*'home'\)/.exec(body.template ?? "");
    const v = m ? (presence[m[1]] ? "True" : "False") : "False";
    return send(200, v, "text/plain");
  }
  if (url === "/api/conversation/process") {
    // Assist understands nothing here, so questions go on to the (fake) model.
    return send(200, { response: { response_type: "error", data: { code: "no_intent_match" }, speech: { plain: { speech: "Sorry" } } } });
  }
  send(404, { message: "not found" });
});

const OPENAI_PORT = Number(process.env.FAKE_OPENAI_PORT ?? 8791);
const HA_PORT = Number(process.env.FAKE_HA_PORT ?? 8792);
openai.listen(OPENAI_PORT, "127.0.0.1", () => console.log(`fake OpenAI on ${OPENAI_PORT}`));
ha.listen(HA_PORT, "127.0.0.1", () => console.log(`fake Home Assistant on ${HA_PORT}`));
