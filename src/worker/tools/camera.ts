import type { Tool } from "./registry";
import { localeOf } from "../lib/locale.ts";
import { camerasConfigured, dataUrl, listCameras, pickCamera, snapshot } from "../lib/cameras.ts";

/**
 * The user's cameras: Home Assistant's, and any listed by snapshot address
 * (lib/cameras.ts).
 *
 * show_camera puts one on the screen. look_at_camera is Jarvis actually
 * looking: the frame goes to the router model as a picture, beside the
 * question, and it answers from what it sees — "is the gate open?". The frame
 * is also shown on screen where there is one, as the evidence.
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
    "Look at one of the user's cameras right now and answer from what it shows: 'is the " +
    "gate open', 'is there a car in the driveway', 'did the parcel arrive', 'who is at the " +
    "door', 'is the garage door shut'. You are given the current picture, and it is put on " +
    "the screen too — so do not call show_camera as well. Say only what is actually " +
    "visible; if it is too dark, blurred or blocked to tell, say so rather than guess. For " +
    "several cameras, call it once for each. To list cameras, call with an empty camera.",
  parameters: {
    type: "object",
    properties: {
      camera: { type: "string", description: "Which camera, in the user's own words. Empty string lists them." },
      question: { type: "string", description: "What to find out from the picture, as the user asked it." },
    },
    required: ["camera", "question"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const list = await listCameras(ctx.env);
    if (!list.length) return "I cannot reach any cameras at the moment.";
    const want = String(args.camera ?? "").trim();
    if (!want) return `Cameras available: ${list.map((c) => c.name).join(", ")}.`;
    const cam = pickCamera(list, want);
    if (!cam) return unknownCamera(want, list.map((c) => c.name));

    ctx.progress(`looking at the ${cam.name}`);
    // 1024 pixels wide: enough to read a number plate or a parcel label, a
    // fraction of what a 4K frame would cost to look at.
    let snap = await snapshot(ctx.env, cam.id, 1024);
    // Cameras behind Home Assistant now and then stall on one frame (about one
    // in thirty, measured) and answer the next at once. One more try, so a
    // single hiccup is not reported as the camera being down.
    if (!snap.ok && /took too long/.test(snap.error)) {
      ctx.progress(`the ${cam.name} is slow, trying again`);
      snap = await snapshot(ctx.env, cam.id, 1024);
    }
    if (!snap.ok) return `I could not get a picture from the ${cam.name} camera: ${snap.error}.`;

    ctx.display({ kind: "camera", entity: cam.id, label: cam.name });
    const at = new Intl.DateTimeFormat("en-GB", {
      timeZone: localeOf(ctx.env).timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date());
    const question = String(args.question ?? "").trim() || "What does it show?";
    return {
      text:
        `This is the ${cam.name} camera, just now (${at}). Answer "${question}" from what you ` +
        `can see in it. Only what is visible: if it is too dark, blurred or blocked to tell, say so.`,
      images: [{ url: dataUrl(snap.bytes, snap.mime), detail: "auto" }],
    };
  },
};

export const cameraTools: Tool[] = [showCamera, lookAtCamera];
