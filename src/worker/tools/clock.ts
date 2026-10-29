import type { Tool } from "./registry.ts";
import { timeAt } from "../lib/locale.ts";

/**
 * "What time is it in London?" The router is told the time where the user is
 * (lib/router-prompt.ts nowLine), and once worked London's out from it as
 * 8:56 pm when it was 7:56 am. Another place's time comes from here instead.
 */
export const timeIn: Tool = {
  name: "time_in",
  pace: "fast",
  description:
    "The day and time now somewhere else, by its IANA time zone. Use it for any question about the " +
    "time or date in another city or country; never work it out yourself: daylight saving changes it.",
  parameters: {
    type: "object",
    properties: {
      zone: { type: "string", description: "An IANA time zone, e.g. 'Europe/London', 'America/New_York', 'Asia/Tokyo'." },
    },
    required: ["zone"],
    additionalProperties: false,
  },
  async run(args) {
    const zone = String(args.zone ?? "").trim();
    return timeAt(zone) ?? `Not a time zone: "${zone}". Use an IANA name, such as Europe/London.`;
  },
};
