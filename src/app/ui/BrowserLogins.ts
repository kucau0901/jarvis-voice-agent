import { api } from "../key";
import { arm, button, el } from "./util";

/**
 * Saved sign-ins, in the Browser panel (src/worker/lib/vault.ts): for a site
 * that signs you out by the clock, so Jarvis can sign back in when asked to
 * work there. A password goes up once, to be sealed and kept; it never comes
 * back to this page.
 */

interface Login {
  id: string;
  origin: string;
  user: string;
  at: number;
}

export function browserLogins(key: string): { el: HTMLElement; load(): Promise<void>; site(origin: string): void } {
  const box = el("section", "blogins");
  box.appendChild(el("h3", "", "Saved sign-ins"));
  box.appendChild(el("p", "note",
    "For a site that signs you out after a while. Jarvis uses a saved sign-in only on the site it was saved for, and only for you; " +
    "the assistant itself never sees the password. A one-time code or an \"are you human\" check is still yours to do."));
  const list = el("div", "rlist");
  const form = el("div", "rform");
  const site = el("input");
  site.type = "text";
  site.placeholder = "The site, e.g. https://hr.example.com";
  site.autocomplete = "off";
  site.setAttribute("aria-label", "The site the sign-in is for");
  const user = el("input");
  user.type = "text";
  user.placeholder = "Login name";
  user.autocomplete = "off";
  user.setAttribute("aria-label", "Login name");
  const password = el("input");
  password.type = "password";
  password.placeholder = "Password";
  password.autocomplete = "new-password";
  password.setAttribute("aria-label", "Password");
  const res = el("div", "res");
  const say = (text: string, bad = false) => {
    res.textContent = text;
    res.classList.toggle("bad", bad);
  };

  const load = async (): Promise<void> => {
    try {
      const { logins } = (await api(key, "GET", "/api/browser/logins")) as { logins: Login[] };
      list.replaceChildren(
        ...logins.map((l) => {
          const row = el("div", "routine");
          row.appendChild(el("div", "", `${l.user} · ${l.origin.replace(/^https?:\/\//, "")}`));
          const remove = button("Remove", () => {});
          arm(remove, "Remove it?", async () => {
            await api(key, "DELETE", `/api/browser/logins?id=${encodeURIComponent(l.id)}`);
            await load();
          });
          const btns = el("div", "rowbtns");
          btns.appendChild(remove);
          row.appendChild(btns);
          return row;
        }),
      );
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  };

  const save = button("Save sign-in", async () => {
    save.disabled = true;
    try {
      await api(key, "POST", "/api/browser/logins", { site: site.value, user: user.value, password: password.value });
      user.value = password.value = "";
      say("Saved. Jarvis can now sign in there when you ask it to work on that site.");
      await load();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    } finally {
      save.disabled = false;
    }
  }, "primary");
  const row = el("div", "rowbtns");
  row.appendChild(save);
  form.append(site, user, password, row, res);
  box.append(list, form);
  return {
    el: box,
    load,
    // The site the browser is on, offered as the one to save for until something else is typed.
    site: (origin) => {
      if (!site.value || site.dataset.auto === site.value) site.value = site.dataset.auto = origin;
    },
  };
}
