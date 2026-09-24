import { authHeaders } from "./key";
import { currentClient } from "./client.ts";
import type { Turn } from "./history";

/** How long a "disconnected" peer gets to heal before we treat it as dropped. */
const DISCONNECT_GRACE_MS = 4000;

export type ServerEvent = { type: string; [k: string]: unknown };

export interface SessionHandlers {
  onEvent(ev: ServerEvent): void;
  onState(state: SessionState, detail?: string): void;
  onDiagnostic(type: string, data: Record<string, unknown>): void;
  /** The transport died on its own; the caller decides whether to retry. */
  onDropped(reason: string): void;
  onRemoteStream(stream: MediaStream): void;
  onLocalStream(stream: MediaStream): void;
}

export type SessionState =
  | "idle" | "requesting-mic" | "connecting" | "live" | "closed" | "error";

export class JarvisSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private local: MediaStream | null = null;
  private stopping = false;
  private stopReason = "";
  private dropTimer = 0;
  private dropped = false;
  sessionId: string | null = null;

  constructor(private key: string, private h: SessionHandlers) {}

  get live(): boolean {
    return this.dc?.readyState === "open";
  }

  async start(opts: { voice?: string; history?: Turn[] } = {}): Promise<void> {
    try {
      this.h.onState("requesting-mic");
      // Must be called from the user gesture that started this.
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.h.onLocalStream(this.local);

      this.h.onState("connecting");
      const pc = new RTCPeerConnection();
      this.pc = pc;

      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
      // Ask for the model's audio explicitly; some builds will not add a
      // recvonly transceiver on their own.
      pc.addTransceiver("audio", { direction: "sendrecv" });

      pc.ontrack = (ev) => {
        if (ev.streams[0]) this.h.onRemoteStream(ev.streams[0]);
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        this.h.onDiagnostic("pc.connectionState", { state: st });
        if (this.stopping) return;

        if (st === "connected") {
          clearTimeout(this.dropTimer);
          this.dropTimer = 0;
          return;
        }
        if (st === "failed") {
          clearTimeout(this.dropTimer);
          this.drop("connection failed");
          return;
        }
        if (st === "disconnected" && !this.dropTimer) {
          // A tunnel or a cell handover usually recovers within a few seconds.
          // Only give up if it does not.
          this.dropTimer = setTimeout(() => {
            this.dropTimer = 0;
            if (!this.stopping && pc.connectionState !== "connected") {
              this.drop("connection lost");
            }
          }, DISCONNECT_GRACE_MS) as unknown as number;
        }
      };
      pc.oniceconnectionstatechange = () =>
        this.h.onDiagnostic("pc.iceConnectionState", { state: pc.iceConnectionState });

      // GPT-Live carries every session event on a channel with this exact label.
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => this.h.onState("live");
      dc.onclose = () => {
        this.h.onDiagnostic("datachannel.close", { wasStopped: this.stopping });
        if (this.stopping) this.h.onState("closed", this.stopReason);
        else this.drop("data channel closed by peer");
      };
      dc.onerror = (e) =>
        this.h.onDiagnostic("datachannel.error", { detail: String((e as RTCErrorEvent).error ?? e) });
      dc.onmessage = (m) => {
        try {
          this.h.onEvent(JSON.parse(m.data as string) as ServerEvent);
        } catch {
          this.h.onEvent({ type: "__unparseable", raw: String(m.data) });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);

      const res = await fetch("/api/session", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          voice: opts.voice,
          history: opts.history,
          // Where this is running, so the model is told whose attention it is
          // spending — a driver's or a reader's.
          client: currentClient(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string; detail?: string;
        };
        throw new Error(
          res.status === 401
            ? "unauthorized — the access key is missing or wrong"
            : `${body.error ?? res.statusText}${body.detail ? ` — ${body.detail}` : ""}`,
        );
      }
      const { sdp, sessionId } = (await res.json()) as { sdp: string; sessionId: string };
      this.sessionId = sessionId;
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.stop(`start failed: ${msg}`);
      this.h.onState("error", msg);
    }
  }

  /**
   * Wait for ICE gathering, but never block on it.
   *
   * A network that silently drops STUN would otherwise hang the connect forever;
   * the host candidates already gathered are usually enough to proceed.
   */
  private waitForIce(pc: RTCPeerConnection, ms = 3000): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => pc.iceGatheringState === "complete" && done();
      const timer = setTimeout(done, ms);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  send(ev: Record<string, unknown>): boolean {
    if (this.dc?.readyState !== "open") return false;
    this.dc.send(JSON.stringify(ev));
    return true;
  }

  /** Speakable context for a delegation. Capped at 500 tokens by the API. */
  commentary(content: string, delegationId: string | null = null): boolean {
    return this.send({
      type: "session.commentary.append",
      content,
      delegation_id: delegationId,
    });
  }

  /** Silent context for a delegation. Also capped at 500 tokens. */
  thinking(content: string, delegationId: string | null = null): boolean {
    return this.send({
      type: "session.thinking.append",
      content,
      delegation_id: delegationId,
    });
  }

  /**
   * Speak text into the session as if the driver had said it.
   *
   * Replaces the outgoing microphone track with synthesised speech, then puts
   * the microphone back. This is the only way to exercise the real path —
   * transcription, intent, delegation — without a person at the wheel;
   * commentary.append hands the model something to say rather than a request
   * to act on, so it never triggers a delegation.
   */
  async injectSpeech(text: string, key: string): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "audio");
    if (!sender) throw new Error("no audio sender on the peer connection");

    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Key": key },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`tts failed: ${res.status}`);

    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);

    const synthetic = dest.stream.getAudioTracks()[0]!;
    const mic = sender.track;
    await sender.replaceTrack(synthetic);
    src.start();

    this.h.onDiagnostic("inject.speak", { text: text.slice(0, 60), seconds: +buf.duration.toFixed(1) });

    await new Promise((r) => setTimeout(r, buf.duration * 1000 + 400));
    // Hand the microphone back, or the session is deaf from here on.
    if (mic) await sender.replaceTrack(mic).catch(() => {});
    synthetic.stop();
    await ctx.close();
  }

  /**
   * Kill the transport without marking this a deliberate stop, so the real drop
   * handlers fire. Lets recovery be tested while parked instead of hoping to
   * find a tunnel at the right moment.
   */
  simulateDrop(): void {
    this.h.onDiagnostic("simulated.drop", { hadPc: !!this.pc, live: this.live });
    try { this.pc?.close(); } catch { /* already gone */ }
    this.drop("simulated drop");
  }

  /** Report a transport failure exactly once per session. */
  private drop(reason: string): void {
    if (this.dropped || this.stopping) return;
    this.dropped = true;
    clearTimeout(this.dropTimer);
    this.h.onDropped(reason);
  }

  stop(reason = "stopped"): void {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.dropTimer);
    this.stopReason = reason;
    this.h.onDiagnostic("session.stop", {
      reason,
      by: new Error().stack?.split("\n").slice(2, 4).join(" <- ").slice(0, 200),
    });
    try { this.send({ type: "session.close" }); } catch { /* channel may be gone */ }
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    // Release the mic, or the car keeps showing a recording indicator and the
    // session keeps billing at $0.05/min.
    this.local?.getTracks().forEach((t) => t.stop());
    this.dc = null; this.pc = null; this.local = null;
    this.h.onState("closed", reason);
  }
}
