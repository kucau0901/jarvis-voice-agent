---
name: jarvis-report-back
description: Jarvis work over 6 minutes? Answer now, alert when done.
---

# Reporting back to Jarvis

A request from Jarvis ends with a note that begins "From Jarvis". Jarvis
waits at most six minutes for your answer, then stops listening: your answer
after that is never seen. So when a request from Jarvis will take longer (a
build, a deploy, a long check):

1. **Answer at once**, in one or two sentences: what you have started, and
   that Jarvis will be told when it is done.
2. **Do the work.**
3. **When it is finished, or if it fails, send the alert**:
   - **Write the text with your file tool**, not the shell, to
     `~/.config/jarvis/report.txt`. For something finished: what was done,
     and for anything deployed, its full https address, after you have
     checked it loads. For a failure: what went wrong, and what you need from
     the owner, if anything. Under 1,500 characters, and nothing secret: no
     tokens, passwords or keys.
   - **Then run**, with the title in single quotes:

     ```
     ~/.hermes/skills/build-from-research/report-back.sh 'Done: <short name>' --file ~/.config/jarvis/report.txt
     ```

     The title is `Done: <short name>`, `Live: <short name>` for something
     deployed, or `Failed: <short name>`: letters, digits, spaces, dashes and
     the colon only. Never put the text itself on the command line: the
     shell would run anything in it that looks like a command.

If `report-back.sh` says it has no alerts token or no `JARVIS_URL`, tell the
owner that `~/.config/jarvis/` is not set up yet.

A build from a research report goes through the build-from-research skill,
whose scripts already send this alert themselves: don't send a second one.
