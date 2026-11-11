import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { localeOf } from "../lib/locale.ts";
import { describeAction, describeTrigger, whenSaid, type Routine } from "../lib/routines.ts";
import { callerWho, mayWork, OWNER } from "../lib/context.ts";
import { MAX_ASK } from "../lib/habits.ts";
import { asQuotedData, tidy } from "../lib/quote.ts";
import { findSpot, placeEvent } from "../lib/spots.ts";
import { PRESENCE } from "../lib/later.ts";
import { haConfig } from "../lib/ha.ts";
import { allows } from "../lib/scopes.ts";

/**
 * Making routines by voice (lib/routines.ts). The routine keeps the caller's
 * grants, so a device can never schedule something it could not do itself.
 */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Arriving home or leaving it: minutes there first, so a phone's position wavering at the gate says it once. */
const HOME_FOR_MIN = 2;

/**
 * Whether the person is home, or away, by their Home Assistant person (Family,
 * "Getting home"): a watch said on the change. While Home Assistant starts up
 * the person is unknown, which a watch counts as not read, not as leaving.
 */
export const homeCondition = (presence: string, arrive: boolean): string =>
  `{% set s = states('${presence}') %}{{ 'unknown' if s in ['unknown', 'unavailable'] else s ${arrive ? "==" : "!="} 'home' }}`;

function said(r: Routine, tz: string): string {
  const next = r.nextAt ? ` Next: ${whenSaid(r.nextAt, tz)}.` : "";
  return `"${r.name}" — ${describeTrigger(r.trigger, tz)}; ${describeAction(r.action)}.${next}`;
}

const routineAdd: Tool = {
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
    "What daily cannot say ('at 8 and at 12', 'every 6 hours', 'on the 1st of every month'): " +
    "when=cron with cron, five fields in the user's zone (minute hour day month weekday), at most hourly. " +
    "Warnings about when to set off for calendar events ('tell me when to leave for my " +
    "appointments'): when=leave. " +
    "When the user gets home or leaves it ('when I get home, remind me to take the bins out', " +
    "'when I leave home, tell me to lock the gate'): when=arrive_home or leave_home, with for_minutes null; " +
    "Jarvis watches their Home Assistant person and says it each time they arrive or leave, not now. Only the " +
    "user's own: for someone else ('tell me when Adam gets home') use when=watch on that person's entity. " +
    "Something to do when another system sends an event ('when my phone shortcut runs, …'): when=event " +
    "with a short name — and tell the user it fires when their home automation or phone sends that " +
    "event to Jarvis, which they set up once. " +
    "Something to watch for in the house ('tell me if the gate stays open for ten minutes', " +
    "'let me know when the car has finished charging', 'tell me when the washer is done'): " +
    "when=watch with condition, a Home Assistant template that is TRUE WHILE the thing is " +
    "happening, and for_minutes, how long it must stay true first (0 for at once). Find the " +
    "entity id with the house tools first, never guess it. Forms: " +
    "{{ is_state('cover.main_gate', 'open') }}, {{ states('sensor.car_battery') | float(0) >= 80 }}, " +
    "{{ is_state('sensor.washer_state', 'idle') }}. It is checked every minute, at no cost, and " +
    "says its message once each time the condition comes true. " +
    "A watch can do anything you can, not only say something: give ask in place of say, written as what to " +
    "do when it comes true, checks first ('when someone is seen outside at night, look at that camera and, " +
    "only if there really is a person, announce it on the kitchen and bedroom speakers'; 'when the freezer " +
    "goes above -10, check whether its door is open and tell me'; 'when everyone has left, turn off the " +
    "lights still on and tell me which'). The ask runs then with the user's tools (the house, its cameras, " +
    "its speakers through Home Assistant, the car, messages), with no screen; it is not told which part of " +
    "the condition came true, so it checks first (which sensor is on). With notify=if-important it answers " +
    "NOTHING when its checks find nothing worth it, and nothing is said. A condition can join several " +
    "things and a time of day: {{ (now().hour >= 23 or now().hour < 6) and (expand(['binary_sensor.a', " +
    "'binary_sensor.b']) | selectattr('state', 'eq', 'on') | list | count > 0) }}. Each time it comes " +
    "true is one paid answer. For a condition outside the house (mail, the calendar, the web), use cron " +
    "with ask and notify=if-important, the check in the ask ('every hour, if the school has emailed, tell " +
    "me what it says'). Never say a routine cannot check something before it acts: its ask can. " +
    "For someone else in the family, on a schedule, give pass_to (their names from THE FAMILY): " +
    "a chore rota ('every Saturday at ten, remind Aisyah and Adam in turn to wash the car, 5 " +
    "points': pass_to both, points 5), a check-in on a grandparent ('every day at ten ask Grandma " +
    "if she is well': pass_kind ask, escalate true), medicine ('at eight and eight remind Grandpa " +
    "to take his tablets': escalate true). say is then the words for them; escalate tells the whole " +
    "family if it goes unanswered for an hour. " +
    "When the user wants to hear only if something turns up ('every morning, tell me only if there is " +
    "urgent email', 'check the news and only tell me if there is a storm warning'), use ask with " +
    "notify=if-important: a run with nothing worth saying sends nothing, and Routines shows it ran. " +
    "A brief of their day ('every weekday at seven, brief me on my day', 'at six tonight, brief me on tomorrow'): " +
    "when=daily or once with brief=true and neither say nor ask. Jarvis gathers the calendar, the weather, the car, " +
    "mail and what waits for their OK itself; before 3 PM it covers the rest of the day, after it, tomorrow. At most two each. " +
    "Meetings emailed to them put in their calendar ('every hour on workdays, add meetings sent to me to my calendar'): " +
    "when=cron (or daily) with meetings=true and neither say nor ask; code finds mail sent to them by name with a meeting link, " +
    "adds each with a reminder, and says only when it added one. " +
    "A look around during the day ('check on me during the day', 'tell me if anything needs me'): when=cron (or daily) with " +
    "notice=true and neither say nor ask, e.g. '0 10,13,16 * * *'; Jarvis reads what a brief reads and speaks only when " +
    "something is worth the interruption, at most four times a day. One each: another replaces its schedule, so 'check " +
    "less often' or 'more often' is a new schedule, and 'stop checking' is routine_remove. Each look costs a small answer. " +
    "At a place that is not home ('when I get to the supermarket, tell me my shopping list', 'when I leave the " +
    "office, tell me the best way home'): when=arrive_place or leave_place with place, its name as they said it, and " +
    "say or ask. Their phone tells Jarvis when they arrive at or leave a place they saved in the Jarvis app there, " +
    "with location turned on in its settings; nothing else knows where they are. place=null is anywhere they arrive " +
    "or leave, for 'when I get somewhere, tell me one useful thing about it or stay quiet' (ask, with " +
    "notify=if-important): the ask is then given the place's name. " +
    "Afterwards read back what was set and when it will next happen.",
  parameters: {
    type: "object",
    properties: {
      name: { type: ["string", "null"], description: "A few words to title it by. Null to use the message." },
      when: { type: "string", enum: ["once", "daily", "cron", "event", "leave", "watch", "arrive_home", "leave_home", "arrive_place", "leave_place"] },
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
      cron: {
        type: ["string", "null"],
        description: "cron: minute hour day month weekday, e.g. '0 8,12 * * *' or '0 9 1 * *'. One number for the minute. Only when daily cannot say it.",
      },
      event: { type: ["string", "null"], description: "event: its name, lower case, e.g. doorbell." },
      place: {
        type: ["string", "null"],
        description: "arrive_place, leave_place: the place's name as the user said it, one they saved in the Jarvis app on their phone. Null for anywhere they arrive or leave. Null otherwise.",
      },
      buffer_min: { type: ["integer", "null"], description: "leave: minutes to spare on top of the drive. Null for 10." },
      condition: {
        type: ["string", "null"],
        description: "watch: a Home Assistant template, true while the thing is happening, with real entity ids.",
      },
      for_minutes: { type: ["integer", "null"], description: "watch: how long it must stay true first. Null or 0 for at once. arrive_home, leave_home: null for two." },
      say: { type: ["string", "null"], description: "A fixed message to send. Exactly one of say or ask, unless brief or meetings." },
      ask: {
        type: ["string", "null"],
        description: "A request for Jarvis to carry out at the time, with the answer sent to the user.",
      },
      brief: { type: ["boolean", "null"], description: "true for a brief of their day in place of say or ask; daily or once only. Null otherwise." },
      meetings: { type: ["boolean", "null"], description: "true to put meetings emailed to them in their calendar, in place of say or ask; cron, daily or once. Null otherwise." },
      notice: { type: ["boolean", "null"], description: "true for a look around that speaks only when something is worth it, in place of say or ask; cron, daily or once. Null otherwise." },
      notify: {
        type: ["string", "null"],
        description: "With ask: \"if-important\" to send the answer only when something deserves attention; null or \"always\" to send it every time.",
      },
      pass_to: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Pass it on to these family members instead of the user; several take turns. Null for the user.",
      },
      pass_kind: { type: ["string", "null"], description: "With pass_to: \"remind\" (they say done) or \"ask\" (they answer)." },
      points: { type: ["integer", "null"], description: "With pass_to: a chore's points, earned on done." },
      escalate: { type: ["boolean", "null"], description: "With pass_to: tell the whole family if it goes unanswered." },
      answer_within_minutes: {
        type: ["integer", "null"],
        description: "With pass_to: how long they have to answer before the user (or family) is told; nudged halfway. Null for the family's usual (an hour). Medicine might be 20.",
      },
    },
    required: ["name", "when", "local_time", "in_minutes", "time", "days", "cron", "event", "place", "buffer_min", "condition", "for_minutes", "say", "ask", "brief", "meetings", "notice", "notify", "pass_to", "pass_kind", "points", "escalate", "answer_within_minutes"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Routines cannot be kept on this deployment: it has no state object.";
    const home = args.when === "arrive_home" || args.when === "leave_home";
    const arrive = args.when === "arrive_home";
    // Without Home Assistant, or for someone who may not read the house, getting home is an event their own automation or phone sends, as before.
    const byEvent = home && (!haConfig(ctx.env) || !allows(ctx.grants, "home"));
    const watched = home && !byEvent;
    // Somewhere else: their phone watches the places they saved in it and sends the event (lib/spots.ts).
    const elsewhere = args.when === "arrive_place" || args.when === "leave_place";
    let placeEventName: string | null = null;
    if (elsewhere) {
      const said = typeof args.place === "string" ? args.place.trim() : "";
      const spots = said ? await state.spotsList(ctx.env.JARVIS_PERSON || OWNER) : [];
      const spot = said ? findSpot(spots, said) : null;
      if (said && !spot) {
        const have = spots.length ? `The places they have saved: ${asQuotedData("places", spots.map((s) => s.name).join(", "), "THE USER'S SAVED PLACES")}` : "They have saved no places yet.";
        return (
          "Not set up: Jarvis does not know where that is. A place is saved from the Jarvis app on their phone, standing there: " +
          `Settings, Location, "Save where I am now", with location turned on there. ${have} Tell them that plainly, and offer to set this up once it is saved.`
        );
      }
      placeEventName = placeEvent(spot ? spot.slug : null, args.when === "arrive_place");
    }
    const presence = ctx.env.JARVIS_PERSON_PRESENCE ?? "";
    if (watched && !PRESENCE.test(presence)) {
      return (
        "Not set up: Jarvis does not know which Home Assistant person is the user. They set it in Family → Home → " +
        "Getting home (person.their_name), or an admin does on their page in Family. Tell them that plainly."
      );
    }
    const r = await state.addRoutine(
      {
        name: args.name,
        when: watched ? "watch" : byEvent || elsewhere ? "event" : args.when,
        localTime: args.local_time,
        inMinutes: args.in_minutes,
        time: args.time,
        days: args.days,
        cron: args.cron,
        event: placeEventName ?? (byEvent ? (arrive ? "arrived_home" : "left_home") : args.event),
        bufferMin: args.buffer_min,
        condition: watched ? homeCondition(presence, arrive) : args.condition,
        forMinutes: watched ? (args.for_minutes ?? HOME_FOR_MIN) : args.for_minutes,
        ...(watched ? { onChange: true } : {}),
        say: args.say,
        ask: args.ask,
        brief: args.brief,
        meetings: args.meetings,
        notice: args.notice,
        notify: args.notify,
        ...(Array.isArray(args.pass_to) && args.pass_to.length
          ? { passTo: args.pass_to, passKind: args.pass_kind, points: args.points, escalate: args.escalate, answerMin: args.answer_within_minutes }
          : {}),
      },
      { who: callerWho(ctx.env), grants: ctx.grants },
    );
    // A person Home Assistant does not know: a wrong id in Getting home, or Home Assistant starting up.
    if (typeof r === "string" && watched && /gave "unknown"/.test(r)) {
      return `Not set up: Home Assistant does not know ${presence} right now. Check Getting home in Family → Home, or try again in a minute if Home Assistant is restarting.`;
    }
    if (typeof r === "string") return `Not set up: ${r}.`;
    const tz = localeOf(ctx.env).timeZone;
    const forMin = r.trigger.kind === "watch" ? r.trigger.forMin : 0;
    const extra = watched
      ? ` It is said each time Home Assistant sees ${presence} ${arrive ? "get home" : "leave home"}` +
        `${forMin ? ` for ${forMin} minute${forMin === 1 ? "" : "s"}` : ""} (checked every minute), not now.`
      : r.trigger.kind === "event"
        ? ` It runs when something sends the event "${r.trigger.event}" to Jarvis (POST /api/v1/trigger) — a Home Assistant automation or a phone shortcut, set up once.`
        : r.trigger.kind === "leave" && !(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET)
          ? " Google Calendar is not connected yet, so there is nothing to warn about until it is."
          : r.trigger.kind === "watch"
            ? " Home Assistant is checked every minute, at no cost; it speaks once each time the condition comes true."
            : "";
    return r.action.kind === "relay"
      ? `Set up: ${said(r, tz)}${extra} Each time, it reaches them on their own screens and phone, and what they say comes back to the user.`
      : r.action.kind === "ask" && r.action.notify === "if-important"
        ? `Set up: ${said(r, tz)}${extra} It will reach the user as an alert only when there is something worth telling.`
        : `Set up: ${said(r, tz)}${extra} It will reach the user as an alert.`;
  },
};

const routineList: Tool = {
  name: "routine_list",
  scope: "routines",
  pace: "fast",
  description: "List the routines and reminders that are set up, with ids, for 'what reminders do I have' or before removing one.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "No routines on this deployment.";
    // This person's own: another's reminders are theirs (lib/context.ts).
    const all = (await state.listRoutines()).filter((r) => mayWork(r, ctx.env, ctx.grants));
    if (!all.length) return "No routines are set up.";
    const tz = localeOf(ctx.env).timeZone;
    return all.map((r) => `${r.id}: ${r.enabled ? "" : "(off) "}${said(r, tz)}`).join("\n");
  },
};

const routineRemove: Tool = {
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
    const id = String(args.id ?? "");
    const r = (await state.listRoutines()).find((x) => x.id === id);
    if (!r || !mayWork(r, ctx.env, ctx.grants)) return "No routine has that id.";
    return (await state.removeRoutine(id)) ? "Removed." : "No routine has that id.";
  },
};

/** A habit's routine (lib/habits.ts), as its card was offered: what to ask, when, on which days. Null when it is not one. */
function habitArgs(args: Record<string, unknown>): { ask: string; time: string; days: number[] } | null {
  const ask = typeof args.ask === "string" ? tidy(args.ask) : "";
  const time = typeof args.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(args.time) ? args.time : "";
  const days = Array.isArray(args.days) && args.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) ? (args.days as number[]) : null;
  return ask && ask.length <= MAX_ASK && time && days ? { ask, time, days } : null;
}

/**
 * Making a routine from a habit: for an approval only (lib/approval.ts), never
 * offered to the router or a job. Its card is filed by code when someone asks
 * the same thing at about the same time on several days (state.ts noteAsk).
 */
export const routineMake: Tool = {
  name: "routine_make",
  scope: "routines",
  pace: "fast",
  description: "Make a routine that asks something at a time: for an approval only.",
  parameters: {
    type: "object",
    properties: { ask: { type: "string" }, time: { type: "string" }, days: { type: "array", items: { type: "integer" } } },
    required: ["ask", "time", "days"],
    additionalProperties: false,
  },
  // Reversible (it can be removed), with no kind a standing permission could name: it always waits for a tap.
  propose(args) {
    const h = habitArgs(args);
    return h ? { risk: "reversible", says: `Routine: ask "${h.ask}" ${describeTrigger({ kind: "daily", time: h.time, days: h.days }, "UTC")}, and send you the answer`, verb: "Make it a routine" } : null;
  },
  async run(args, ctx) {
    const h = habitArgs(args);
    if (!h) return "That is not a routine to make, so nothing was set up.";
    const state = stateStub(ctx.env);
    if (!state) return "Routines cannot be kept on this deployment: it has no state object.";
    const r = await state.addRoutine({ when: "daily", time: h.time, days: h.days, ask: h.ask }, { who: callerWho(ctx.env), grants: ctx.grants });
    if (typeof r === "string") return `Not set up: ${r}.`;
    ctx.done?.();
    return `Set up: ${said(r, localeOf(ctx.env).timeZone)}`;
  },
};

export const routineTools: Tool[] = [routineAdd, routineList, routineRemove];
