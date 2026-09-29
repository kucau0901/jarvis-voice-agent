// A Live session that has ended must let go of its connection and the mic, and
// say nothing more (src/app/session.ts). GPT-Live bills every second a session
// is open, and main.ts can only close the one it holds: one it has let go of
// and that carries on anyway bills until the tab closes.
import { JarvisSession, type ServerEvent } from "../src/app/session.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : ""); }
}

/** A promise settled by hand, so a stop can land while start() waits on it. */
function later<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
/** Lets start() run on until it waits on something that is not settled. */
const settle = () => new Promise((r) => setTimeout(r, 0));

class Track { kind = "audio"; stopped = false; stop() { this.stopped = true; } }
class Mic { track = new Track(); getTracks() { return [this.track]; } }

class Channel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  send() {}
  close() { this.readyState = "closed"; }
}

/** Every peer connection made, newest last. */
const peers: Peer[] = [];
/** What ICE gathering is doing when a peer connection is made. */
let gathering = "complete";
class Peer {
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = gathering;
  localDescription: { sdp: string } | null = null;
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  dc = new Channel();
  closed = false;
  answered = false;
  listeners = new Set<() => void>();
  constructor() { peers.push(this); }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() { return this.dc; }
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() {
    // As the browser does.
    if (this.closed) throw new DOMException("The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
    this.answered = true;
  }
  addEventListener(_: string, f: () => void) { this.listeners.add(f); }
  removeEventListener(_: string, f: () => void) { this.listeners.delete(f); }
  close() { this.closed = true; this.connectionState = "closed"; this.dc.close(); }
  /** ICE gathering finishes. */
  gathered() { this.iceGatheringState = "complete"; for (const f of this.listeners) f(); }
  /** The network, on its own. */
  becomes(state: string) { this.connectionState = state; this.onconnectionstatechange?.(); }
}
Object.assign(globalThis, { RTCPeerConnection: Peer });

let getMic: () => Promise<Mic> = async () => new Mic();
Object.assign(navigator, { mediaDevices: { getUserMedia: () => getMic() } });

/** Each /api/session post made, and whether it was taken back. */
const posts: { url: string; signal?: AbortSignal | null }[] = [];
let reply: () => Promise<Response> = async () => Response.json({ sdp: "v=0 answer", sessionId: "s_test" });
globalThis.fetch = ((url: string, init?: RequestInit) => {
  posts.push({ url: String(url), signal: init?.signal });
  // As fetch does: taken back, it fails, whatever the answer.
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    reply().then(resolve, reject);
  });
}) as typeof fetch;

/** A session, and what it told main.ts. */
function session() {
  const heard = { states: [] as string[], events: [] as ServerEvent[], dropped: [] as string[], mics: 0 };
  const s = new JarvisSession("TESTKEY", {
    onEvent: (ev) => heard.events.push(ev),
    onState: (st, detail) => heard.states.push(detail ? `${st}: ${detail}` : st),
    onDiagnostic: () => {},
    onDropped: (reason) => heard.dropped.push(reason),
    onRemoteStream: () => {},
    onLocalStream: () => heard.mics++,
  });
  return { s, heard };
}

console.log("a connection given up on stays closed, even if it heals");
{
  const mic = new Mic();
  getMic = async () => mic;
  const { s, heard } = session();
  await s.start();
  const pc = peers.at(-1)!;
  const dc = pc.dc;
  dc.readyState = "open";
  dc.onopen?.();
  check("it went live", s.live && heard.states.at(-1) === "live", heard.states);

  // A tunnel: disconnected, and still so when the grace it is given runs out.
  const graces: (() => void)[] = [];
  const setTimeoutWas = globalThis.setTimeout;
  globalThis.setTimeout = ((f: () => void) => graces.push(f)) as typeof setTimeout;
  pc.becomes("disconnected");
  globalThis.setTimeout = setTimeoutWas;
  graces.forEach((f) => f());
  check("it is dropped", heard.dropped.join() === "connection lost", heard.dropped);
  check("its peer connection is closed", pc.closed);
  check("its mic is let go", mic.track.stopped);
  check("it is not live", !s.live);

  // Out of the tunnel. Left open, ICE would come back and the channel carry on.
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  dc.onmessage?.({ data: JSON.stringify({ type: "session.output_transcript.delta", delta: "hello again" }) });
  dc.onclose?.();
  check("nothing it says reaches main.ts", heard.events.length === 0, heard.events);
  check("not even that it closed: main.ts has moved on", heard.states.at(-1) === "live", heard.states);
  check("the drop is reported once", heard.dropped.length === 1, heard.dropped);
}

console.log("\nended while the browser asks for the mic");
{
  const asked = later<Mic>();
  getMic = () => asked.promise;
  const made = peers.length, posted = posts.length;
  const { s, heard } = session();
  const started = s.start();
  s.stop("ended by user");
  const mic = new Mic();
  asked.resolve(mic);
  await started;
  check("the mic it is given afterwards is let go", mic.track.stopped);
  check("no peer connection is made", peers.length === made, peers.length - made);
  check("no session is asked for", posts.length === posted);
  check("it only says it closed", heard.states.join() === "requesting-mic,closed: ended by user" && heard.mics === 0, heard.states);
}
getMic = async () => new Mic();

console.log("\nended while gathering ICE");
{
  gathering = "gathering";
  const posted = posts.length;
  const { s, heard } = session();
  const started = s.start();
  await settle();
  const pc = peers.at(-1)!;
  s.stop("hidden for 60s");
  pc.gathered();
  await started;
  gathering = "complete";
  check("its peer connection is closed", pc.closed);
  check("no session is asked for", posts.length === posted, posts.length - posted);
  check("no error is shown for it", heard.states.at(-1) === "closed: hidden for 60s", heard.states);
}

console.log("\nended while the offer is posted");
{
  const answer = later<Response>();
  reply = () => answer.promise;
  const posted = posts.length;
  const { s, heard } = session();
  const started = s.start();
  await settle();
  check("it is waiting on the post", posts.length === posted + 1, posts.length - posted);
  const pc = peers.at(-1)!;
  s.stop("ended by user");
  check("the post is taken back", posts.at(-1)?.signal?.aborted === true);
  answer.resolve(Response.json({ sdp: "v=0 answer", sessionId: "s_test" }));
  await started;
  check("the answer is not applied", !pc.answered);
  check("no error is shown for it", heard.states.at(-1) === "closed: ended by user", heard.states);
}

console.log("\na start that fails on its own still says why");
{
  reply = async () => Response.json({ error: "unauthorized" }, { status: 401 });
  const { s, heard } = session();
  await s.start();
  const pc = peers.at(-1)!;
  check("its peer connection is closed", pc.closed);
  check("the error is shown", heard.states.at(-1) === "error: unauthorized — the access key is missing or wrong", heard.states);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
