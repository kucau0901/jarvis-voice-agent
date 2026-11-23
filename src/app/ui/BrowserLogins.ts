import { api } from "../key";
import { arm, button, el } from "./util";

/**
 * Saved sign-ins, in the Browser panel (src/worker/lib/vault.ts): for a site
 * that signs you out by the clock, so Jarvis can sign back in when asked to
 * work there. A password goes up once, to be sealed and kept; it never comes
 * back to this page.
 *
 * Below them, the sites a person's routines may use the browser on by
 * themselves (src/worker/lib/vault.ts aloneSites): only there, checked by code
 * on every call, and none means a routine has no browser.
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

  const aloneList = el("div", "rlist");
  const aloneSite = el("input");
  aloneSite.type = "text";
  aloneSite.placeholder = "The site, e.g. https://shop.example.com";
  aloneSite.autocomplete = "off";
  aloneSite.setAttribute("aria-label", "A site routines may use on their own");
  const aloneRes = el("div", "res");
  const showSites = (sites: string[]) =>
    aloneList.replaceChildren(
      ...sites.map((origin) => {
        const row = el("div", "routine");
        row.appendChild(el("div", "", origin.replace(/^https?:\/\//, "")));
        const remove = button("Remove", () => {});
        arm(remove, "Remove it?", async () => {
          const { sites: left } = (await api(key, "DELETE", `/api/browser/alone?site=${encodeURIComponent(origin)}`)) as { sites: string[] };
          showSites(left);
        });
        const btns = el("div", "rowbtns");
        btns.appendChild(remove);
        row.appendChild(btns);
        return row;
      }),
    );

  const load = async (): Promise<void> => {
    try {
      const { sites } = (await api(key, "GET", "/api/browser/alone")) as { sites: string[] };
      showSites(sites);
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

  const add = button("Add site", async () => {
    add.disabled = true;
    try {
      const { sites } = (await api(key, "POST", "/api/browser/alone", { site: aloneSite.value })) as { sites: string[] };
      aloneSite.value = "";
      aloneRes.textContent = "Added. Your routines may now work on that site by themselves.";
      aloneRes.classList.remove("bad");
      showSites(sites);
    } catch (e) {
      aloneRes.textContent = e instanceof Error ? e.message : String(e);
      aloneRes.classList.add("bad");
    } finally {
      add.disabled = false;
    }
  }, "primary");
  const aloneForm = el("div", "rform");
  const aloneBtns = el("div", "rowbtns");
  aloneBtns.appendChild(add);
  aloneForm.append(aloneSite, aloneBtns, aloneRes);
  box.append(
    el("h3", "", "Sites your routines may use on their own"),
    el("p", "note",
      "A routine of yours may open, press, type and sign in on these sites with nobody there, doing what the routine says: " +
      "reply to comments, check an order, buy. Nowhere else. What a page or a comment says can try to steer it, so add only " +
      "sites you want it to act on. A one-time code or an \"are you human\" check still waits for you."),
    aloneList,
    aloneForm,
  );
  return {
    el: box,
    load,
    // The site the browser is on, offered as the one to save for until something else is typed.
    site: (origin) => {
      if (!site.value || site.dataset.auto === site.value) site.value = site.dataset.auto = origin;
    },
  };
}
