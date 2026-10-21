/**
 * What typed chat shows while Jarvis works: one short pill per tool call
 * (lib/router.ts runCalls sends a `tool` event as each starts and ends), in
 * words, never the tool's own name. No imports, so node can test it.
 */

const DOING: Record<string, string> = {
  calendar_check: "Checking your calendar",
  calendar_add: "Adding to your calendar",
  mail_check: "Checking your mail",
  mail_search: "Searching your mail",
  mail_send: "Sending that email",
  mail_manage: "Tidying your mail",
  car_state: "Checking the car",
  car_command: "Sending that to the car",
  directions: "Checking the route",
  place_info: "Looking up the place",
  show_place: "Finding it on the map",
  hide_display: "Clearing the screen",
  look_at_camera: "Looking at the camera",
  show_camera: "Bringing up the camera",
  music_state: "Checking the music",
  music_play: "Playing that",
  music_control: "Changing the music",
  remember: "Remembering that",
  recall: "Checking your notes",
  forget: "Forgetting that",
  look_back: "Looking back through our chat",
  control_home: "Asking home",
  ask_hermes: "Handing it to Hermes",
  start_job: "Starting a job",
  job_results: "Checking your jobs",
  routine_add: "Setting up the routine",
  routine_list: "Checking your routines",
  routine_remove: "Removing the routine",
  send_note: "Sending a note",
  family_messages: "Checking family messages",
  answer_message: "Answering that",
  pass_on: "Passing that on",
  use_pass: "Checking the pass",
  chore_points: "Checking the chores",
  panel_set: "Updating your Home",
  panel_remove: "Updating your Home",
  panel_list: "Checking your Home",
  contacts_lookup: "Looking up contacts",
  make_image: "Making the picture",
  web_search: "Searched the web",
};

/** A tool call, as words. Another server's tool (an MCP one, "label__name") waits for its own note. */
export function doing(name: string): string {
  if (DOING[name]) return DOING[name];
  if (name.includes("__")) return "Checking";
  return "Working";
}

/**
 * A progress note as the pill says it: "checking Home" → "Checking Home".
 * The waiting ladder's notes carry advice for the voice after a ";" ("home is
 * still thinking; say the user can ask you to drop it"), which is not for
 * reading.
 */
export function said(text: string): string {
  const t = text.split(";")[0]!.trim().replace(/[.…]+$/, "");
  return t ? t[0]!.toUpperCase() + t.slice(1) : "";
}
