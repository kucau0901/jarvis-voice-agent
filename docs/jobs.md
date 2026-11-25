# Background jobs

A background job is work that takes minutes: comparing things, going through a
month of mail, planning a trip, making a spreadsheet. It runs on its own, even
with every screen closed, and its result reaches you as an alert and waits in
**Jobs** (in the menu) and in your Chat.

A job reads, and never acts. What it would do, such as send an email or add an
event, it puts to you as a card, and only your tap does it.

This page is how to use them. Why they are built this way:
[DESIGN.md](DESIGN.md#background-jobs). For devices: [api.md](api.md).

## Starting one

Say or type what you want, and that you can wait:

- "Look into the best dashcams under RM800 and let me know."
- "Go through this month's mail and list what still needs an answer."
- "Compare these three schools, with helpers."
- "Make me a spreadsheet of these expenses by month."
- "Build a one-page site for our bake sale."

Or open **Jobs → New job**, write the brief and choose how. A brief is complete
on its own: the job never sees the conversation. Jarvis writes it when you ask by
voice or in Chat, and you can read it in Jobs ("What was asked").

| Kind | Ask for it | What it is for | Time | Cost on an API key |
| --- | --- | --- | --- | --- |
| Ordinary | nothing special | most things | a few minutes | stops at $2 |
| **Thorough** | "a thorough job" | many things to weigh: a stronger model, thinking hard; five a day | ten minutes or more | several times an ordinary one, stops at $2 |
| **Helpers** | "with helpers" | work that splits: up to three work at the same time and report back | ten minutes or so | several times, the same $2 for all |
| **Files** | "make me a spreadsheet of…" | a spreadsheet, document, PDF or chart to save (needs the [workshop](#files-sites-and-code)) | minutes | stops at $2 |
| **Build** | "build a page…" | a site, or a change to code, published with your tap (needs the workshop) | minutes | stops at $2 |
| **Research in depth** | "research…", "dig into…" | a report with its sources, checked against them | 10 to 40 minutes | roughly $1 to 2 |
| **As a team** | "research as a team" | three teams from different angles, one checked report | 20 to 55 minutes | roughly $4 to 7 |
| **As a table** | "a list of the 10 cheapest…" | the same team fills rows, to download as CSV | 20 to 55 minutes | roughly $4 to 7 |

On the ChatGPT plan a job costs nothing beyond the plan.

## Your own things, or the web

Every job reads one side, settled when it starts:

- **Your own things**: your mail, calendar, contacts, memory, the house, the car
  and the cameras, as far as you may. No web search.
- **The web**: searches, and nothing of yours. It is not told who you are, your
  family's names or where exactly you live.

Never both. What is looked up on the web leaves by the words of the search, and a
page or an email it reads could ask for exactly that. For work that needs both, such
as a trip around your diary, Jarvis reads the private part first and puts only the
facts it needs in the brief; you can read which. Research and building are always
the web's.

## While it works

In **Jobs**, and on its card in Chat, you see its **card** (what it set out to do,
its limits, what it takes for granted), its **checklist** ticking along, and what
it is doing now.

- **Change** its card, and it goes on from there at its next step.
- **Tell it** something: press it, or just say so ("only ones I can have this
  week", "tell the luggage job it is for an adult"). It takes your own words, as
  you said them, and Jobs shows whether they reached it in time.
- **It may ask you**, up to three times, only for what it cannot find out: its
  question comes as an alert with choices, and waits on Home and in Jobs too. Tap
  one, type your own answer, or say it. **Go on without me** has it finish without,
  and say what that leaves open. With nothing left to do it waits 24 hours for you,
  then does the same. Nothing is ever answered for you.
- **Stop** ends it at once. "Stop the dashcam job" does too.

An ordinary job has 25 steps, 60 while its checklist moves, and an hour. Out of
those, it writes up what it has and says what is missing: it is never called
done when it is not. A job that outgrows one conversation goes on in a new one
from its own record, with everything you told it word for word (up to three
times).

**At your ChatGPT plan's limit** a job waits and goes on by itself when the plan
resets. Your own questions come first. Where you have an API key that may stand in
for the plan, **Use the API key now** moves it there, with what it would have
cost so far.

## What comes back

- **What it could not do, and what it took for granted, comes first.** An address
  it only named itself, and never saw, is marked "(not checked)".
- **Cards for what it would do**: at most five a job, each for you to approve or
  decline within 24 hours. A kind that can be undone, such as archiving mail or
  locking the car, you may let jobs do without asking; **Jobs** lists those,
  with **Stop**. Anything irreversible, and anything in the house, always asks.
- **Its files**, to **Save**, and *What it ran*, the commands it used to make them.
- **Try again harder** copies its brief, with what you told it, to a thorough
  job for you to read over and start.
- **Keep for next time** turns how it was done into a
  [specialty](#specialties-your-way-of-doing-things).

Your last 30 finished jobs are kept. "What did the solar job find about the rebate?"
looks in what they came back with.

## Files, sites and code

Needs the optional workshop, a container with no network where a job runs
programs: [setting it up](../README.md#run-with-docker). Only an admin may use it
until they give someone else the **workshop** reach.

**Files.** A job on your own things also gets what you attached in Chat, and can
take attachments from your mail. It may give you 20 files of up to 20 MB each (200 MB in
all), kept for 14 days or until you remove the job. A file is saved, never opened by
Jarvis.

**A site.** A job that builds is on the web, with nothing of yours but what you
told it. When it is ready it puts a card to you: the files, what it would
replace, and any other addresses its pages name. **Publish** puts it in your
[sites folder](../README.md#run-with-docker), where anyone on your network with the
address can open it. Without a sites folder, save the zip.

- **Put back** on the card, for a week, undoes that publishing; after something
  else has been published there, or it was taken down, it changes nothing.
- **Jobs → Sites** lists them: **Put back** the version before, or **Take down**,
  any time.

**A change to code.** An admin lists repositories in **Settings → GitHub**, and
names one as they ask ("change the footer in owner/name") or chooses it in the
form. A repository may be private, so that job has no web search. Its card
lists every file it changes and removes; **Open it** opens a pull request on a
branch of its own. Nothing is merged. It cannot change what your repository runs by
itself: `.github`, hooks, nearly anything whose name begins with a dot, CODEOWNERS
and the like. Its code may still be run by the repository's own checks.

## Projects

For jobs that belong together: **Jobs → Projects → New project**, with a name, up
to ten rules in your own words, and up to 20 files. Choose it for a new job, or name
it ("for my Kitchen project"). The job has the rules, the files and what the project's
last jobs came back with, and nothing of any other project's. What it makes is kept
there with a tap.

On the web, a project goes with a job only when you choose it yourself, or name it
in your own words; then code first looks through it for who you are and where you
live. What its earlier jobs found never goes.

## Specialties: your way of doing things

A specialty is how you like something done, kept to be done the same way again. They
are in **Memory → Specialties**, and they come four ways:

- After an answer of several steps, say "save this as my Monday report".
- When you put a job right as it worked, or one like it had failed before, its
  result offers to keep that: **Save**, **Change it first** or **Not now**. Or press
  **Keep for next time** on a finished job, or say "learn this". What is kept is what
  you told it and how it was run, never what it read.
- **New** writes one in a form: when to use it, its steps, longer notes, and, for
  whoever may use the workshop, small files.
- **Import a file…** (an admin) takes a skill made for another agent, a `SKILL.md` or
  a zip with one. You read all of it before it is saved, and it gets no tools of
  its own. **Export** saves any of yours the same way.

Asked for by name, or much as you usually would, its steps are followed. A job on
your own things reads those that fit; name one ("do it with my Weekly report")
and it is given that one whole. A job on the web has only the one you name. Each change
keeps what it was, the last five times, under **Earlier**.

## A routine that starts one

"Every Friday at six, go through the week's mail and plan the next", or **Routines →
Start a background job**. It starts at a time (once, every day or some days, or a
schedule), not on an event or a watch, as you, with no more than you may reach by then.

In **Routines** it may also be thorough, stop at about an amount you set on the API
key, and have a last day. One still at work is not joined by another. **Run now**
starts one at once.

## Who may do what

| To | You need |
| --- | --- |
| start an ordinary job | `ask` (anyone who may ask Jarvis) |
| a thorough job, helpers, research, a routine that starts one | `routines`: the family, not a guest |
| projects and specialties | `memory.read`, and `memory.write` to keep or change one |
| files, building, sites | `workshop`: admins, until given |
| repositories, importing a skill | an admin |
| a question for Hermes | `hermes`: admins, until given ([hermes.md](hermes.md)) |

A job runs with what whoever started it may reach, looked at again at every
step, and can never do more.

## Limits

| | |
| --- | --- |
| At once | 3 of yours, 6 in the house; 5 more may wait for your answer |
| A day | 30 jobs, 5 of them thorough, for each person |
| Research | 10 a month for the house (Settings → OpenAI) |
| A job | 25 steps, 60 while its checklist moves; an hour; 60 web searches; $2 on an API key |
| On the ChatGPT plan | 5 million tokens a day for each person's jobs |
| Projects | 20; each 10 rules, 20 files of 1 MB, 5 MB in all |
| Specialties | 50; each up to 20 steps, 12,000 characters of notes, 10 files |
| A site | 300 files, 10 MB; 50 sites |
| A pull request | 100 files of 1 MB, 5 MB in all |
