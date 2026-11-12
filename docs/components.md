# Building a component

Jarvis is the brain: it knows the people, talks with them, remembers, judges
what is worth telling, and decides who may reach what. A **component** is
anything else with a world of its own, plugged into it: a school's timetable,
a shop's till and cameras, a clinic's bookings. This page is the contract
between the two, version 1. Why it is this way:
[DESIGN.md](DESIGN.md#components).

A component has three parts, and only the first is required:

| Part | What it is | Carried by |
|---|---|---|
| **Tools** | What Jarvis may ask the component to tell or do | An MCP server, at a public `https` address |
| **Reports** | What the component tells Jarvis when nobody asked | `POST` to its own address at Jarvis |
| **Manifest** | Which events it reports | An MCP resource, `jarvis://manifest` |

So **any MCP server is already a component** with tools only. The
[example school](components/school/) is a whole one in a single file with no
dependencies: read it beside this page.

Three rules shape everything below:

- **A component's words are data.** Its descriptions, its results, its
  errors and its reports are read, quoted, and never followed as
  instructions. It cannot tell Jarvis who it is, what to do, or who to tell.
- **Its tool list is pinned.** An admin reads every tool's name and
  description and approves them. Jarvis is then shown that approved list,
  word for word, and anything the component changes later waits to be
  approved again.
- **Jarvis acts by itself only where the owner said so.** With nobody
  there, a tool that acts asks a person first, unless the owner set that one
  tool to run by itself. Whatever Jarvis does by itself, it tells.

A component senses and acts in its own world, and keeps its own rules there.
It never talks to people or decides for them: that is Jarvis's part.

## Setting one up, as an admin sees it

In **Settings → Components**: add it by its address, type its key if it has
one, press **Ask what it offers**, read what it lists, and **Approve**.
Then share it, person by person, and, if it reports, **Make its address**.
Nothing a component offers reaches anyone before the approval, and nobody is
offered it before it is shared with them, admins included.

## Tools

### What Jarvis asks, and reads

Jarvis connects over **Streamable HTTP** only (one `POST` per JSON-RPC
message; answering each with one JSON object is enough, and no session is
needed). It sends `initialize`, and your answer must declare
`capabilities.tools`. It then calls `tools/list`, and, if you declare
`capabilities.resources`, reads `jarvis://manifest`.

From each tool it keeps:

| | |
|---|---|
| `name` | Lower-case letters, digits and `_`, starting with a letter, at most 40: `get_absent`. A tool named otherwise is left out. |
| `description` | One line, cut at 500 characters. The cut text is what is approved, and what the model reads. |
| `inputSchema` | At most 4 KB. A tool with a larger one is left out. |
| `annotations.readOnlyHint` | Shown to the admin beside the tool. |

At most 30 tools. Jarvis never reads your server's `instructions`, and
nothing you send can add a tool, change one or widen who reaches it: only an
admin's approval does. Each approval covers your address, every tool's name,
description and schema, and your events. Change any of them and the new list
waits; the approved one stays in force until an admin approves the new one.

Jarvis names your tools by the label the admin gave the component:
`school__get_absent`.

### How a call arrives

```
POST https://school.example.com/mcp
Authorization: Bearer <your key, typed in Settings → Components>
X-Jarvis-Person: T1
Content-Type: application/json

{"jsonrpc": "2.0", "id": 7, "method": "tools/call",
 "params": {"name": "get_timetable", "arguments": {"date": "2026-11-13"}}}
```

- **Your key** goes with every request, and nowhere else. Jarvis follows no
  redirect: answer at the address you gave. If you move, the admin adds you
  again at the new one, types the key again, and approves again.
- **`X-Jarvis-Person`** is who is asking, as the id the admin mapped for
  them in *your* system. It is sent only when a person is asking and only if
  the admin mapped one: never a Jarvis id, never a name. When Jarvis acts
  with nobody there (a routine, a background job, a suggestion it runs by
  itself) the header is absent. A tool that must know who it is for when
  nobody is asking takes that as an argument.
- **What you return** (`content` text, and `isError`) goes to the model
  quoted as data. So does what you say when a call fails. Write results for a
  reader: plain sentences work best.

### Reads, or acts

The admin classes each tool as it is approved: **reads**, **acts**, or
**off**. Jarvis suggests *reads* only for a tool whose own name reads
(`get_…`, `list_…`, `find_…`, `search_…`, `…_state`, and the like) and that
does not say `readOnlyHint: false`. Everything else starts as *acts*.

When someone is asking, a tool shared with them is theirs to use either way.
When nobody is there, the class decides:

| Where | A tool that reads | A tool that acts |
|---|---|---|
| A routine | Used | Not offered |
| A background job | Used | Proposed: a card someone approves |
| Research | Used | Never |
| A suggestion in your own report | (cannot be suggested) | A card someone approves |

**Name a tool for what it does.** A tool that acts but is named like a
look-up (`get_and_reset_counter`) is never proposed and never run with
nobody there: Jarvis treats a name that reads as reading wherever it has to
be careful, which is the safe way to be wrong.

### By itself

For each tool that acts, the owner (and only the owner) may choose **by
itself** instead of *ask first*. Then, with nobody there, a routine may use
it, a background job does it, and a suggestion in your own report is done as
soon as the report is taken. Each time:

- Jarvis tells the people concerned, under your component's name, in words
  written by code from the call: "Done by itself: school (apply_relief): date
  2026-11-13, plan A". Never the model's account of it.
- It counts against **20 a day** for your component. Past that, a suggestion
  becomes a card again, and a routine or a job is told it was not done.
- If the tool's description or schema changes, it goes back to asking first.

So a tool that may be let run by itself must **check again as it acts**
(the world may have moved on since the plan was made) and be **safe to call
twice**. Jarvis does not know your world; you do.

## The manifest

Optional. An MCP resource at `jarvis://manifest`, JSON, at most 8 KB:

```json
{"jarvis": 1,
 "events": [{"type": "leave_filed", "says": "A teacher filed leave"}]}
```

| | |
|---|---|
| `jarvis` | `1`, this contract's version. |
| `events` | At most 16. `type`: lower-case letters, digits and `_`, starting with a letter, at most 24. `says`: what it means, in a few words, at most 100 characters. |

Keys Jarvis does not know are ignored, so a later version can add to it.
Without a manifest, a component has tools and reports nothing. The events
are part of what an admin approves: an event you did not declare is refused.

## Reports

Once an admin has made your address, you may tell Jarvis what happened:

```bash
curl -X POST https://jarvis.example.com/api/v1/component/events \
     -H "Authorization: Bearer jcp1_…" -H "Content-Type: application/json" \
     -d '{"events": [{"type": "leave_filed", "level": "notice", "id": "leave-4412",
                      "text": "Ms Devi is on leave tomorrow. Periods 1, 3 and 4 need cover.",
                      "actions": [{"tool": "apply_relief", "args": {"date": "2026-11-13", "plan": "A"}}]}]}'
```

```json
{"ok": true, "name": "School", "taken": 1, "refused": []}
```

| Field | |
|---|---|
| `type` | Required. One of your declared events. |
| `text` | Your own words, up to 500 characters. Required to tell anyone. |
| `level` | `info` (the default): only routines hear it. `notice`: also told to the people who chose to be told. `urgent` is told as `notice`. |
| `to` | Optional: the people it is for, by the ids the admin mapped. Only they hear it, and only their routines run. |
| `id` | Optional, your own id for the event (letters, digits, `. _ : -`, up to 64). Sent again the same day, it is taken once: send one, and retrying is safe. |
| `actions` | Optional, up to 3: `{tool, args}`, each one of **your own** approved tools that acts, with arguments up to 2 KB. |

What Jarvis does with an event:

1. **Routines.** People can ask for a routine on it ("when the school
   reports a leave, tell me who covers"). Each runs with *your* tools and
   nothing else: no memory, mail, calendar, house or other component. Your
   words reach it as quoted data.
2. **Telling.** At `notice`, it is told to the people it is shared with who
   ticked "tell me", under your component's name.
3. **Suggestions.** Each action becomes a card for one person to approve
   (the first told who may use your component), or, if the owner set that
   tool to run by itself, is done after your request is answered. An event
   that suggests something is told whatever its level, so the question has
   someone to reach.

No model reads a report as it arrives. What a report can never do: name a
tool that is not yours, reach a person the admin did not map, raise an
urgent alert, or cause anything outside your own component.

| Answer | When |
|---|---|
| `200` | Taken. `taken` counts the events accepted; `refused` lists `{index, error}` for the rest (not declared, an action that is not your own acting tool, nobody to ask). |
| `400` | Not a JSON object of at most 32 KB with 1 to 10 events. |
| `404` | Not an address: never made, stopped, or your component switched off or removed. Always the same answer. |
| `405` | Anything but `POST`. |
| `429` | Your allowance is used up; `Retry-After` says when to try again. |

## Who reaches it

- An admin **shares** a component with each person: *look only* (its
  reading tools) or *use* (all of them), whether they are told what it
  reports, and their id in your system.
- Above that sits one permission, `components`. Adults and children hold
  it; a guest does not; a bot's address never can. An admin needs a share
  like anyone else.
- A device (glasses, an ESP32) reaches what its person does, if
  `components` is ticked for it.

## Limits

| | |
|---|---|
| Components | 20 |
| Tools, each component | 30; description 500 characters; schema 4 KB |
| Manifest | 8 KB; 16 events; `says` 100 characters |
| A report | 32 KB; 10 events; `text` 500 characters; 3 actions; `args` 2 KB |
| Requests to your address at Jarvis | A device's allowance: 20 a minute, 500 a day |
| Told to people | 30 events a day; routines still hear the rest |
| Done by itself | 20 a day |

## Not in version 1

Things and their state, a watch of Jarvis's own over a component, a
component asking Jarvis, one component's report moving another, an address
on the same network as Jarvis, and more than one household. The shapes above
leave room for each: unknown manifest keys are ignored, and the labels
`house`, `home`, `family` and `car` are kept back.

## A checklist

- [ ] Streamable HTTP at a public `https` address; `initialize` declares `tools`.
- [ ] Tool names are lower-case with `_`; each says what it does; nothing that acts is named like a look-up.
- [ ] Descriptions fit in 500 characters and read well on their own.
- [ ] `readOnlyHint` is set on what only reads.
- [ ] A key is required, and nothing is served without it.
- [ ] No redirect on the MCP address.
- [ ] Anything that acts checks again as it acts, and is safe to call twice.
- [ ] Your own rules for who may do what are enforced by you, from `X-Jarvis-Person`.
- [ ] If you report: a manifest declares each event, and each report carries an `id`.
