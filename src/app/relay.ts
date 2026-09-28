import { authHeaders } from "./key";

/**
 * Answering something passed on from someone in the family (src/worker/lib/relays.ts):
 * Done or Can't for a reminder, words for a question. Used by the alert card
 * and by the chat.
 */
async function answerRelay(key: string, id: string, status: "done" | "declined" | "answered", answer?: string): Promise<void> {
  const res = await fetch("/api/hub/relays/answer", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ id, status, ...(answer ? { answer } : {}) }),
  });
  if (res.ok) return;
  const b = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(b.error ?? `the server said ${res.status}`);
}

/**
 * The buttons for one: Done and Can't for a reminder; a reply for a
 * question. `after` is told what was said, to show in their place.
 */
export function relayActions(key: string, relay: { id: string; kind: string }, after: (said: string) => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "relayacts";
  const err = document.createElement("span");
  err.className = "relayerr";
  const go = async (status: "done" | "declined" | "answered", answer?: string) => {
    err.textContent = "";
    try {
      await answerRelay(key, relay.id, status, answer);
      after(status === "done" ? "✓ Done — they have been told." : status === "declined" ? "✗ They know you can't." : "↩ Answer sent.");
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  const button = (label: string, fn: () => void, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    return b;
  };
  if (relay.kind === "ask") {
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 500;
    input.placeholder = "Your answer";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) void go("answered", input.value.trim());
    });
    box.appendChild(input);
    box.appendChild(button("Reply", () => input.value.trim() && void go("answered", input.value.trim()), "primary"));
    box.appendChild(button("Can't", () => void go("declined")));
  } else if (relay.kind === "remind") {
    box.appendChild(button("Done", () => void go("done"), "primary"));
    box.appendChild(button("Can't", () => void go("declined")));
  }
  box.appendChild(err);
  return box;
}
