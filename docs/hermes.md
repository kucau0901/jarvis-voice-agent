# Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) is an agent you run on
a machine of your own. Jarvis can ask it things, have it change things at
home when Home Assistant can't, and hand it work: research to build from, and
what it builds to deploy. Hermes can run commands on its machine, so Jarvis
treats it with care, and so should its setup.

## Connecting it

In Jarvis, **Settings → Hermes**:

- **Base URL**: where Hermes's `api_server` answers, over https.
- **API key**: the key that `api_server` expects.
- **Model name**: what `api_server` calls its model (`hermes` unless you
  changed it).
- If Hermes sits behind Cloudflare Access: the service token's **Client ID**
  and **Client Secret**. The Access policy's action must be *Service Auth*.

Jarvis streams its questions, so a long answer is not cut off by a proxy's
first-byte timeout. Each person has their own memory in Hermes: Jarvis sends
`X-Hermes-Session-Key: jarvis:tesla` for the person who set up the family and
`jarvis:tesla:<their id>` for anyone else. Press **Test** in **Settings →
Hermes** to check that Hermes answers.

**Who may use it.** Only people and devices holding the `hermes` permission.
Every admin has it, since an admin has everything: make someone an admin only
if they may also run commands on Hermes's machine. Nobody else gets it by
default (not adults, children or guests, not a guest's pass), and background
jobs never get it. An admin grants it to others in **Family**, person by
person. A device needs `hermes` ticked as well.

## What Jarvis asks it

- **"Ask Hermes …"** (`ask_hermes`): a background job. Jarvis replies at once,
  and the answer arrives as a **Hermes answered** alert, usually in one to four
  minutes, on whatever screen or phone is yours.
- **A change at home that Home Assistant can't make** (`control_home`): a last
  resort, used only when the Home Assistant tools fail. In the car, the Live
  session is let go while it waits, so the wait costs nothing.
- **Research to build from**: see [Building from research](#building-from-research).

## Six minutes, and longer work

A Hermes job waits at most **six minutes** for its answer. Every question it
sends ends with a short note from Jarvis saying so: longer work (a build, a
deploy) should be answered at once with what has been started, and reported
when it is done with a Jarvis alert, giving the address of anything deployed.

If Hermes still takes longer, you are alerted **Still working: …** rather
than *Could not finish*: Hermes carries on, but its answer can no longer reach
Jarvis. Only an alert Hermes sends itself can, and the `jarvis-report-back`
skill below teaches it to send one. (In **Jobs** the job still shows as
*could not finish*, saying Hermes did not answer within six minutes and may
still be working.)

## Reporting back: an alerts-only token

Hermes tells you something through Jarvis with `POST /api/v1/notify`
([api.md](api.md#a-home-agent-reporting-back)), using a Jarvis device token
of its own:

1. In Jarvis, open **Devices**, name the device (`hermes reports`), **untick
   `ask`**, tick only **`alerts`**, and press **Create token**. The token is
   shown once; it starts with `jdv1_`.
2. On Hermes's machine, keep it in a file only that user can read, with your
   Jarvis address beside it:

   ```bash
   mkdir -p ~/.config/jarvis && chmod 700 ~/.config/jarvis
   ```
   ```bash
   (umask 077; printf '%s' 'PASTE-THE-TOKEN-HERE' > ~/.config/jarvis/alerts-token)
   ```
   ```bash
   printf 'JARVIS_URL=https://jarvis.example.com\n' > ~/.config/jarvis/env
   ```

An `alerts` token can raise alerts and also read the alerts meant for the
person it belongs to, so it stays on that machine. It cannot ask Jarvis
anything or reach the house. Alerts go to the token's person, and the skills
below keep one token: reports of long work go to that person, whoever asked.
If someone else may use Hermes for long work, tell them their reports come to
you. Revoke the token in **Devices** whenever that machine is in doubt.

This is not Hermes's own API key. That one lets Jarvis reach Hermes, it gives
full access to Hermes, and it stays in Jarvis's settings.

## Installing the skills

Two ready-made skills for Hermes are in [`docs/hermes/`](hermes/):

- **`jarvis-report-back`**: for any request from Jarvis that will take longer
  than six minutes, answer at once, then send a **Done**, **Live** or
  **Failed** alert when it is finished.
- **`build-from-research`**: build from a research report with Claude Code,
  and deploy it if asked.

Download them on Hermes's machine. Don't copy and paste them from a chat or a
web page: pasting can turn spaces into non-breaking spaces, which break the
scripts.

```bash
V=main   # or a release tag, such as v2.4.0
base="https://raw.githubusercontent.com/kucau0901/jarvis-voice-agent/$V/docs/hermes"
mkdir -p ~/.hermes/skills/build-from-research ~/.hermes/skills/jarvis-report-back
for f in SKILL.md start-build.sh deploy-site.sh report-back.sh; do
  curl -fsSL "$base/build-from-research/$f" -o ~/.hermes/skills/build-from-research/$f
done
curl -fsSL "$base/jarvis-report-back/SKILL.md" -o ~/.hermes/skills/jarvis-report-back/SKILL.md
chmod +x ~/.hermes/skills/build-from-research/*.sh
```

If your Hermes keeps skills somewhere else, put them there and change the
script paths in both `SKILL.md` files to match. Then check that Hermes's
machine reaches Jarvis; the test alert should arrive within seconds:

```bash
~/.hermes/skills/build-from-research/report-back.sh "Test" "Hermes can reach Jarvis."
```

## Building from research

Install [Claude Code](https://claude.com/claude-code) on Hermes's
machine and sign in once, interactively, as the user Hermes runs as
(`claude`).

Then, when a research job has finished, either press **Send to Hermes** on it
in **Jobs**, or say:

> "Send the research on home chargers to Hermes and have it build a calculator from it."

Hermes gets your instruction and the whole report, quoted as reference
material and not instructions ([api.md](api.md#handing-research-to-hermes)).
With `build-from-research` it:

1. picks a new folder, `~/projects/<name>`, and writes `INSTRUCTION.md` (your
   words) and `RESEARCH.md` (the report) there with its file tool, never
   through a shell command;
2. runs `start-build.sh <name>`, which starts Claude Code in that folder in the
   background and returns at once;
3. answers you straight away that the build has started.

When Claude Code finishes you get **Build done: <name>**, or **Build failed**
with the reason. The build's log is `~/projects/<name>/build.log`.

Claude Code runs with `--permission-mode acceptEdits`: it may read and edit
files in its folder, and anything else it would need permission for is
refused, since nothing is asked in `-p` mode. It never runs with
`--dangerously-skip-permissions`, and it loads none of that user's own Claude
Code settings, hooks or MCP servers (`--setting-sources project
--strict-mcp-config`), so an "always allow" given elsewhere doesn't carry
over. Sign-in still works; an API key set in your Claude Code settings does
not, so sign in instead.

So builds are plain HTML, CSS and JavaScript. `start-build.sh` can allow more
(`ALLOWED_TOOLS` in `~/.config/jarvis/env`), but leave it unset: any command
that runs the project's own code (`npm install`, `npm run`, `node`, `python`,
`make`) runs what the build wrote, perhaps steered by the research, as that
user, able to read the alerts token and Hermes's keys, write to the sites share
and reach your network.

## …and deploying it

Optionally, a build can go live as a static site at `<name>.<your domain>`.
Say "… build and deploy it as ev-cost", and when it is done you get
**Live: ev-cost** with `https://ev-cost.example.com`. To deploy, Hermes only
copies the finished files into a shared folder on your server. It never runs
docker or changes the server or Cloudflare, and the account it copies with
can reach that folder alone. A name something else already answers to (your
Home Assistant's, say) is refused.

Set it up once, here on a Synology (any server that runs Docker works the same
way):

1. **A shared folder** named `sites`.
2. **A user for Hermes**: read and write on `sites`, no access to anything
   else, SMB only, not an administrator.
3. **One web server for every site**: install Container Manager, upload
   [`nas/Caddyfile`](hermes/nas/Caddyfile) to `docker/caddy` with File Station,
   and create a project in `/volume1/docker/caddy` with:

   ```yaml
   services:
     sites:
       image: caddy:2-alpine
       restart: unless-stopped
       ports:
         - "8880:80"
       volumes:
         - /volume1/sites:/srv:ro
         - /volume1/docker/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
   ```

   Caddy shows the folder `sites/<name>` as the site `<name>.<your domain>`
   (whatever your domain, `example.com` or `example.com.my`), read-only:
   nothing in a site runs on the server, and dot-files are never shown.
4. **One wildcard subdomain**: in Cloudflare Zero Trust, **Networks →
   Tunnels**, your tunnel, **Public Hostname → Add**: subdomain `*`, your
   domain, service **HTTP** `<server's local IP>:8880`. A name with its own DNS
   record (Jarvis's, say) still goes where it did; a name with no folder shows
   a 404. Delete any older `*` DNS record first.
5. **On Hermes's machine**: mount the share (on a Mac, Finder → Go → Connect to
   Server → `smb://<server's local IP>/sites`, signed in as the Hermes user,
   and added to Login Items so it comes back after a restart), then add:

   ```bash
   printf 'SITES_DIR=/Volumes/sites\nSITE_DOMAIN=example.com\n' >> ~/.config/jarvis/env
   ```

To try it, make a page and deploy it, then open `https://hello.<your domain>`:

```bash
mkdir -p ~/projects/hello && printf '<h1>Hello</h1>\n' > ~/projects/hello/index.html
```
```bash
~/.hermes/skills/build-from-research/deploy-site.sh hello
```

Everything in the project folder is published except Markdown files (the
instruction, the report, any README or notes), `build.log` and dot-files. A
deployed site is public: a build started with deploy is told to use only HTML,
CSS and JavaScript and to put nothing secret in it, but look over a folder
built without it before you deploy it.

## Safety, in short

- Research is written from strangers' web pages. Jarvis hands it over quoted
  as reference material, the skill tells Hermes never to act on anything inside
  it, and it reaches Claude Code only as a file in the project folder.
- Nothing is handed to Hermes, built or deployed unless you ask. A finished
  research job never goes to Hermes by itself.
- Claude Code keeps its permission checks and leaves your own Claude Code
  settings behind; leave `ALLOWED_TOOLS` unset. Deploying is a file copy by an
  account that can reach one folder.
- The alerts token stays on Hermes's machine and is taken out of Claude Code's
  environment.

## When something goes wrong

| What you see | What it means |
| --- | --- |
| **Still working: …** | Hermes took longer than six minutes. It is probably still working: look in Hermes. With `jarvis-report-back` installed, it alerts you when done. In **Jobs** it shows as *could not finish … within 6 minutes*. |
| **Could not finish: … Hermes did not answer** | Jarvis couldn't reach Hermes, or Hermes refused. Open **Settings → Hermes** and press **Test**. |
| `report-back.sh`: *No alerts token* / *set JARVIS_URL* | `~/.config/jarvis/` isn't set up on Hermes's machine (above). |
| `start-build.sh` refuses | Claude Code isn't installed, or isn't on Hermes's PATH; the folder name isn't lowercase letters, digits and dashes; that folder was built in already; `INSTRUCTION.md` and `RESEARCH.md` weren't written first; or deploy was asked for without `SITES_DIR` and `SITE_DOMAIN`. |
| **Build failed: …** | Claude Code started and stopped with an error: often it isn't signed in as Hermes's user (run `claude` once as that user). The alert ends with the last of `build.log`. |
| `deploy-site.sh`: *already in use* | Something else answers at that address: choose another name. |
| **Built, not published** | The `sites` share isn't mounted on Hermes's machine. |
| **Published, not answering** | The files are there, but the Caddy container or the Cloudflare Tunnel didn't answer. |
| A script fails with *command not found* on indented lines | It was pasted, and the paste brought non-breaking spaces. Download it again, or fix it in place: `LC_ALL=C sed -i '' $'s/\xc2\xa0/ /g' <file>` on a Mac, `sed -i 's/\xc2\xa0/ /g' <file>` on Linux. |
