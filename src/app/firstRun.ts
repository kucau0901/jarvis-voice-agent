import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * The first time someone opens a chat with nothing in it, as Hark's first run
 * does: connect your mail and calendar first ("it's how I learn what's on your
 * plate"), then one thing to take off them, with examples of what Jarvis can
 * reach for them. An example goes into the message box, never sent: asking
 * costs money, and they may want to change it. Shown once on this screen.
 */

const SEEN = "jarvis.firstRun";

interface Me {
  role?: string;
  scopes: string[];
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return true; // Private mode: no first run to remember, so none shown.
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {
    // Private mode: it comes back next time, which is harmless.
  }
}

/** Jarvis's card at the top of an empty chat, its buttons under its words. */
function card(transcript: HTMLElement, words: string, buttons: HTMLButtonElement[]): HTMLElement {
  transcript.querySelector(".row.firstrun")?.remove();
  const row = el("div", "row jarvis firstrun");
  row.append(el("span", "who", "Jarvis"), el("span", "txt", words));
  const btns = el("div", "frbtns");
  btns.append(...buttons);
  row.appendChild(btns);
  transcript.appendChild(row);
  return row;
}

/** The first run, if this screen has not seen it: `ask` puts a question in the message box. */
export async function firstRun(key: string, transcript: HTMLElement, ask: (text: string) => void): Promise<void> {
  if (seen()) return;
  let me: Me;
  try {
    me = (await api(key, "GET", "/api/hub/me")) as Me;
  } catch {
    return; // A device, or a locked screen: no first run.
  }
  const may = (need: string) => me.role === "admin" || me.scopes.includes("*") || me.scopes.includes(need);

  const firstTask = () => {
    markSeen();
    const examples = [
      may("car.read") ? ["The car", "How's the car's battery, and is it locked?"] : null,
      may("home") ? ["The house", "Is the gate closed and the front door locked?"] : null,
      may("mail") ? ["My mail", "Anything important in my mail today?"] : null,
    ].filter((x): x is string[] => !!x);
    if (!examples.length) return; // Nothing here they may ask about: no card of "Not now" alone.
    const row = card(transcript, "What's one thing this week I could take off you? Here are a few I can do now.", [
      ...examples.map(([label, question]) => button(label!, () => {
        row.remove();
        ask(question!);
      }, "frpill")),
      button("Not now", () => row.remove(), "frpill quiet"),
    ]);
  };

  // Mail and the diary first: they say most about what is on someone's plate. Not set up, or linked already: on to the task.
  if (may("mail") || may("calendar")) {
    const linked = await api(key, "GET", "/api/google/status").then((s) => (s as { linked?: boolean }).linked !== false, () => true);
    if (!linked) {
      const row = card(transcript, "Connect your mail and calendar first: it's how I learn what's on your plate.", [
        button("Connect Google", async () => {
          try {
            const { url } = (await api(key, "GET", "/api/google/auth")) as { url?: string };
            if (url) window.open(url, "_blank", "noopener");
          } catch {
            // Said in Settings → Google, where linking can be tried again.
          }
          row.remove();
          firstTask();
        }, "frpill"),
        button("Later", () => {
          row.remove();
          firstTask();
        }, "frpill quiet"),
      ]);
      return;
    }
  }
  firstTask();
}
