import type { Tool } from "./registry.ts";
import { localeOf } from "../lib/locale.ts";
import { camerasConfigured, dataUrl, laterFrames, listCameras, pickCamera, snapshot } from "../lib/cameras.ts";

/**
 * The user's cameras: Home Assistant's, and any listed by snapshot address
 * (lib/cameras.ts).
 *
 * show_camera puts one on the screen. look_at_camera is Jarvis actually
 * looking: the frame goes to the router model as a picture, beside the
 * question, and it answers from what it sees — "did the parcel arrive?". Asked
 * about movement ("is that car pulling in or out?"), it takes a few frames a
 * few seconds apart instead, and answers from what changed. The camera is also
 * shown on screen where there is one, as the evidence.
 */

const unknownCamera = (want: string, names: string[]) =>
  // Naming what exists is more useful than refusing, and stops the model
  // inventing a camera that does not.
  `There is no camera matching "${want}". There is: ${names.join(", ")}.`;

export const showCamera: Tool = {
  name: "show_camera",
  scope: "home",
  pace: "fast",
  available: camerasConfigured,
  description:
    "Put one of the user's cameras on the screen — the gate, the porch, the doorbell, " +
    "the back garden. Use when they ask to SEE a camera. The view refreshes on its own, " +
    "so say one short sentence and stop. To answer a question about what a camera shows, " +
    "use look_at_camera instead. To list what cameras exist, call it with an empty name.",
  parameters: {
    type: "object",
    properties: {
      camera: {
        type: "string",
        description: "Which camera, in the user's own words — 'the gate', 'front porch'. Empty string lists what is available.",
      },
    },
    required: ["camera"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const list = await listCameras(ctx.env);
    if (!list.length) return "I cannot reach any cameras at the moment.";
    const want = String(args.camera ?? "").trim();
    if (!want) return `Cameras available: ${list.map((c) => c.name).join(", ")}.`;
    const cam = pickCamera(list, want);
    if (!cam) return unknownCamera(want, list.map((c) => c.name));
    ctx.display({ kind: "camera", entity: cam.id, label: cam.name });
    return `Showing the ${cam.name} camera.`;
  },
};

export const lookAtCamera: Tool = {
  name: "look_at_camera",
  scope: "home",
  pace: "fast",
  available: camerasConfigured,
  description:
    // Not "is the gate open": given that as an example, the router looked at a
    // picture of a gate that has a sensor, and read it differently twice running.
    "Look at one of the user's cameras right now and answer from what it shows: 'is there " +
    "a car in the driveway', 'did the parcel arrive', 'who is at the door', 'how many cars " +
    "are outside'. Whether a gate, door or garage is open or closed, or a lock locked, is " +
    "read from the house's own state when it has a device for it — certain, and faster " +
    "than a picture; look only when there is no such device or the user asks to see. " +
    "You are given the current picture, and it is put on " +
    "the screen too — so do not call show_camera as well. Say only what is actually " +
    "visible; if it is too dark, blurred or blocked to tell, say so rather than guess. For " +
    "several cameras, call it once for each. To list cameras, call with an empty camera.",
  parameters: {
    type: "object",
    properties: {
      camera: { type: "string", description: "Which camera, in the user's own words. Empty string lists them." },
      question: { type: "string", description: "What to find out from the picture, as the user asked it." },
      movement: {
        type: ["boolean", "null"],
        description:
          "True only when the answer turns on movement: whether someone or something is arriving " +
          "or leaving, coming or going, pulling in or out, or which way it is heading, or when the " +
          "user asks you to watch it for a moment. Then several pictures are taken a few seconds " +
          "apart, which is slower. Seconds only, not a wait for something to happen: that is a " +
          "routine. Null otherwise: one picture.",
      },
    },
    required: ["camera", "question", "movement"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const list = await listCameras(ctx.env);
    if (!list.length) return "I cannot reach any cameras at the moment.";
    const want = String(args.camera ?? "").trim();
    if (!want) return `Cameras available: ${list.map((c) => c.name).join(", ")}.`;
    const cam = pickCamera(list, want);
    if (!cam) return unknownCamera(want, list.map((c) => c.name));

    const watching = args.movement === true;
    ctx.progress(watching ? `watching the ${cam.name} for a few seconds` : `looking at the ${cam.name}`);
    // 540 pixels high: enough to count cars or read a gate, and small enough
    // to arrive quickly over a slow link into the house (lib/cameras.ts).
    let asked = Date.now();
    let snap = await snapshot(ctx.env, cam.id, 540);
    // A quick failure — the camera or Home Assistant hiccuping — gets one more
    // try. A timeout does not: after twenty seconds a second wait only doubles
    // the delay before saying the camera is too slow.
    if (!snap.ok && !/took too long/.test(snap.error)) {
      ctx.progress(`the ${cam.name} did not answer, trying again`);
      asked = Date.now();
      snap = await snapshot(ctx.env, cam.id, 540);
    }
    if (!snap.ok) return `I could not get a picture from the ${cam.name} camera: ${snap.error}.`;
    const later = watching ? await laterFrames(ctx.env, cam.id, 540, { bytes: snap.bytes, at: asked }, ctx.signal) : [];

    // After the frames: a screen refreshing the same camera would only compete with them.
    ctx.display({ kind: "camera", entity: cam.id, label: cam.name });
    const at = new Intl.DateTimeFormat("en-GB", {
      timeZone: localeOf(ctx.env).timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date());
    const question = String(args.question ?? "").trim() || "What does it show?";
    const lead = !watching
      ? `This is the ${cam.name} camera, just now (${at}). Answer "${question}" from what you can see in it.`
      : later.length
        ? `These are ${later.length + 1} pictures from the ${cam.name} camera, oldest first, over about ` +
          `${Math.round((later.at(-1)!.at - asked) / 1000)} seconds up to just now (${at}). Answer "${question}" ` +
          `from what changes between them: who or what arrived, left or moved, and which way. If nothing moved, say so.`
        : `This is the ${cam.name} camera, just now (${at}); only this one picture came, so movement cannot be ` +
          `seen. Answer "${question}" from what you can see in it, and say you could not watch it move.`;
    return {
      text: `${lead} Only what is visible: if it is too dark, blurred or blocked to tell, say so.`,
      images: [snap, ...later].map((f) => ({ url: dataUrl(f.bytes, f.mime), detail: "auto" as const })),
    };
  },
};

export const cameraTools: Tool[] = [showCamera, lookAtCamera];
