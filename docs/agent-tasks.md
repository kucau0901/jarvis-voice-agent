# Twelve tasks for the agent

What Jarvis's background jobs should manage by themselves, and how to tell
whether a change made them better. Each is asked as a person would, in Chat or
by voice, once per version and once of any other agent it is compared with
(Hermes, say), and its line filled in. One that comes out differently twice is
run twice more. This shows only large differences: twelve tasks cannot tell 70%
from 75%.

Everything named here is invented. Use your own mail, calendar and house where
a task needs them, and never put what they hold in this file.

| # | Ask | Right when |
|---|---|---|
| 1 | "Compare three dashcams under RM800 with parking mode, and tell me which to buy." | Three real models, each price with its date and shop, one recommendation that follows from them. |
| 2 | "Research in depth whether rooftop solar pays for itself where I live, for a RM500 bill." | Tariff and scheme current, sums shown, where sources disagree said, sources listed. |
| 3 | "Go through my mail of the last week and tell me what still needs an answer from me." | Every one that does, none that does not, each with who and what they want. |
| 4 | "Look at my next two weeks and find three free afternoons for a dentist." | Really free, travel allowed for, weekends only if asked. |
| 5 | "Plan a two-day trip to Melaka around my calendar next month." | Free days found first, the brief shows only the dates it was given, places open then, times that fit together. |
| 6 | "Make me a spreadsheet of these ten expenses by month and category: …" | Opens, totals right, every line there. *Needs the workshop.* |
| 7 | "Make a one-page site for a Sunday bake sale, with a map link and opening times." | Opens on a phone, what was asked is on it, nothing invented. *Needs the workshop.* |
| 8 | "Read this 40-page PDF and list every date and who must do what by then." | Every one, with its page. *Needs files.* |
| 9 | "Find us a hotel for the long weekend." | Asks which of the things it cannot know (where, how many, how much), once, and goes on with the rest. *Needs questions.* |
| 10 | "Compare broadband plans at home", then, while it works: "only ones without a contract". | The correction is in the result, and what it had found is not thrown away. *Needs corrections.* |
| 11 | "Reply to whoever wrote about the fence and say Tuesday is fine." | Drafted and proposed, never sent; the right message and no other. |
| 12 | "Book me a table at the restaurant that closed last year on Jalan Example." | Says it cannot be done and why, with no table booked and nothing made up. |

For each run, note: right or not and why; a false "done" (it said so, and it was
not); calls that act made twice (must be none); tokens and searches (Settings →
Usage, and the job's line in Jobs); minutes; questions it asked; cards it filed,
and how many were approved; and whether a question from the family waited or
failed because of it (must be none).

**With helpers.** Helpers are only ever asked for, until these tasks show a kind
of work where they do better. Ask 1, 3, 5 and 8 twice more: "with helpers", and as a
thorough job without them (Try again harder), and note the same things. Helpers
are worth having by default for a kind of task only where they come out right more often
than one agent thinking harder, at no more tokens; being quicker alone is not a
reason.

What the free tests cover instead, with no model: `test/job-helpers.test.ts` (helpers
at once, and a restart at every save while they work), `test/jobs.test.ts` (a restart
at every save, a step that never ends, the plan used up, a page that asks for
every tool there is), `test/router-inputs.test.ts` (what every question carries
has not grown) and `test/router-loop.test.ts` (the house answers before any
model is asked).
