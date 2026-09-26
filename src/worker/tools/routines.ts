import type { Tool } from "./registry";
import { stateStub } from "../lib/state-client.ts";
import { localeOf } from "../lib/locale.ts";
import { describeAction, describeTrigger, whenSaid, type Routine } from "../lib/routines.ts";

/**
 * Making routines by voice (lib/routines.ts). The routine keeps the caller's
 * grants, so a device can never schedule something it could not do itself.
 */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function said(r: Routine, tz: string): string {
  const next = r.nextAt ? ` Next: ${whenSaid(r.nextAt, tz)}.` : "";
  return `"${r.name}" — ${describeTrigger(r.trigger, tz)}; ${describeAction(r.action)}.${next}`;
}

export const routineAdd: Tool = {
  name: "routine_add",
  scope: "routines",
  pace: "fast",
  description:
    "Set up something Jarvis does later, by itself. " +
    "A reminder at a time ('remind me at five to call Mum', 'in 20 minutes tell me to move " +
    "the car'): when=once with local_time or in_minutes, and say. " +
    "Something every day or on some weekdays ('every weekday at 7:30 tell me my first " +
    "meeting and the traffic to work'): when=daily with time and days; use ask when the " +
    "answer has to be looked up at the time, say when it is a fixed message. " +
    "Warnings about when to set off for calendar events ('tell me when to leave for my " +
    "appointments'): when=leave. " +
    "Something to do when another system sends an event ('when I get home, remind me to take " +
    "the bins out'): when=event with a short name like arrived_home — and tell the user it " +
    "fires when their home automation or phone sends that event to Jarvis, which they set up " +
    "once. " +
    "Something to watch for in the house ('tell me if the gate stays open for ten minutes', " +
    "'let me know when the car has finished charging', 'tell me when the washer is done'): " +
    "when=watch with condition, a Home Assistant template that is TRUE WHILE the thing is " +
    "happening, and for_minutes, how long it must stay true first (0 for at once). Find the " +
    "entity id with the house tools first, never guess it. Forms: " +
    "{{ is_state('cover.main_gate', 'open') }}, {{ states('sensor.car_battery') | float(0) >= 80 }}, " +
    "{{ is_state('sensor.washer_state', 'idle') }}. It is checked every minute, at no cost, and " +
    "says its message once each time the condition comes true. " +
    "Afterwards read back what was set and when it will next happen.",
  parameters: {
    type: "object",
    properties: {
      name: { type: ["string", "null"], description: "A few words to title it by. Null to use the message." },
      when: { type: "string", enum: ["once", "daily", "event", "leave", "watch"] },
      local_time: {
        type: ["string", "null"],
        description: "once: the user's local date and time, YYYY-MM-DDTHH:MM, from RIGHT NOW in the instructions.",
      },
      in_minutes: { type: ["integer", "null"], description: "once: or this many minutes from now." },
      time: { type: ["string", "null"], description: "daily: time of day, HH:MM, 24-hour." },
      days: {
        type: ["array", "null"],
        items: { type: "string", enum: DAYS },
        description: "daily: which days. Null for every day.",
      },
      event: { type: ["string", "null"], description: "event: its name, lower case, e.g. arrived_home." },
      buffer_min: { type: ["integer", "null"], description: "leave: minutes to spare on top of the drive. Null for 10." },
      condition: {
        type: ["string", "null"],
        description: "watch: a Home Assistant template, true while the thing is happening, with real entity ids.",
      },
      for_minutes: { type: ["integer", "null"], description: "watch: how long it must stay true first. Null or 0 for at once." },
      say: { type: ["string", "null"], description: "A fixed message to send. Exactly one of say or ask." },
      ask: {
        type: ["string", "null"],
        description: "A request for Jarvis to carry out at the time, with the answer sent to the user.",
      },
    },
    required: ["name", "when", "local_time", "in_minutes", "time", "days", "event", "buffer_min", "condition", "for_minutes", "say", "ask"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Routines cannot be kept on this deployment: it has no state object.";
    const r = await state.addRoutine(
      {
        name: args.name,
        when: args.when,
        localTime: args.local_time,
        inMinutes: args.in_minutes,
        time: args.time,
        days: args.days,
        event: args.event,
        bufferMin: args.buffer_min,
        condition: args.condition,
        forMinutes: args.for_minutes,
        say: args.say,
        ask: args.ask,
      },
      { who: "voice", grants: ctx.grants },
    );
    if (typeof r === "string") return `Not set up: ${r}.`;
    const tz = localeOf(ctx.env).timeZone;
    const extra =
      r.trigger.kind === "event"
        ? ` It runs when something sends the event "${r.trigger.event}" to Jarvis (POST /api/v1/trigger) — a Home Assistant automation or a phone shortcut, set up once.`
        : r.trigger.kind === "leave" && !(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET)
          ? " Google Calendar is not connected yet, so there is nothing to warn about until it is."
          : r.trigger.kind === "watch"
            ? " Home Assistant is checked every minute, at no cost; it speaks once each time the condition comes true."
            : "";
    return `Set up: ${said(r, tz)}${extra} It will reach the user as an alert.`;
  },
};

export const routineList: Tool = {
  name: "routine_list",
  scope: "routines",
  pace: "fast",
  description: "List the routines and reminders that are set up, with ids, for 'what reminders do I have' or before removing one.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "No routines on this deployment.";
    const all = await state.listRoutines();
    if (!all.length) return "No routines are set up.";
    const tz = localeOf(ctx.env).timeZone;
    return all.map((r) => `${r.id}: ${r.enabled ? "" : "(off) "}${said(r, tz)}`).join("\n");
  },
};

export const routineRemove: Tool = {
  name: "routine_remove",
  scope: "routines",
  pace: "fast",
  description: "Remove a routine or reminder. Call routine_list first for its id; confirm which one if more than one fits.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The id from routine_list." } },
    required: ["id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "No routines on this deployment.";
    return (await state.removeRoutine(String(args.id ?? ""))) ? "Removed." : "No routine has that id.";
  },
};

export const routineTools: Tool[] = [routineAdd, routineList, routineRemove];
