# The example school

A made-up school, plugged into Jarvis as a [component](../../components.md):
who is absent, the timetable, and relief when a teacher is on leave. One
file, [school.mjs](school.mjs), with no dependencies. Read it top to bottom:
it is the contract, used.

| | |
|---|---|
| Tools | `get_absent`, `get_timetable`, `find_relief` (they read), `apply_relief` (it acts) |
| Event | `leave_filed`, with plan A as a suggested action |
| Its own rule | With someone asking, only the timetable office may apply relief |

## Run it

Node 20 or newer.

```bash
SCHOOL_KEY=choose-a-long-key node school.mjs
```

It listens on port 8787: the MCP endpoint at `/mcp`, and the school's own
front desk at `/leave`. Jarvis only connects to a public `https` address, so
put it behind one: a tunnel to your machine, or any host that runs Node.
Below, that address is `https://school.example.com`.

## Plug it into Jarvis

In **Settings → Components**, as an admin:

1. **Add** it: name `School`, address `https://school.example.com/mcp`.
2. Type its key (the `SCHOOL_KEY` above) and **Save key**.
3. **Ask what it offers.** Jarvis lists its four tools and its one event.
   Read them. The three that look things up are *Reads only*; `apply_relief`
   is *Acts*. **Approve what is shown.**
4. **Share** it with yourself: *Use*, tick *Tell them what it reports*, and
   give your id there, `T1` (the school's timetable office).
5. **Make its address.** Jarvis shows a URL and a token once. Stop the
   school, and start it again with them:

```bash
SCHOOL_KEY=choose-a-long-key \
JARVIS_EVENTS=https://jarvis.example.com/api/v1/component/events \
JARVIS_TOKEN=jcp1_… \
node school.mjs
```

## Try it

Ask Jarvis, in Chat or by voice:

- "Who is absent at school tomorrow?" It calls `get_absent`.
- "What am I teaching on Friday?" It calls `get_timetable` with no teacher:
  the school reads who is asking from the id you gave in step 4.

File a leave, as the school's front desk would:

```bash
curl -X POST https://school.example.com/leave \
     -H "Authorization: Bearer choose-a-long-key" -H "Content-Type: application/json" \
     -d '{"teacher": "T2", "date": "2026-11-13"}'
```

The school reports `leave_filed` to Jarvis, with plan A as a suggestion.
You are told, under the school's name, with a card: **Approve** applies
plan A, by one call to `apply_relief`, and nothing else does.

Then, as the owner, set `apply_relief` to **With nobody there: by itself**
and file another leave. This time Jarvis applies plan A as soon as the
report is in, and tells you what it did: "Done by itself: school
(apply_relief): date 2026-11-14, plan A".

Ask for a routine: "When the school reports a leave, tell me who is absent
that day." It runs each time the event arrives, with the school's tools and
nothing else.

## What to copy from it

- **Name tools for what they do.** A tool that only looks something up
  starts with `get_` or `find_` and sets `readOnlyHint`. One that changes
  something is named for the change, never like a look-up.
- **Check again as you act.** `apply_relief` may be called the next
  morning, when someone taps a card, or by Jarvis itself. It reads the
  absences again and refuses a plan that no longer fits.
- **Be safe to call twice.** Applying the plan already in force changes
  nothing and says so. Each event carries an `id`, so a report sent again is
  taken once.
- **Keep your own rules.** Who may apply relief is the school's decision,
  made in `apply_relief` from `X-Jarvis-Person`. Jarvis decides who reaches
  the school at all; the school decides what each may do in it.
- **Say what happened, in your own words, and stop.** The school never
  tells Jarvis what to do with a report, and Jarvis would not listen: its
  words are read as data.
