# How Jarvis reaches you

Jarvis speaks first: "remind me at five to call the office", "time to leave
for the dentist", a daily routine, the result of a background job, a note you
asked it to send to your phone. This page is about how those reach you.

**The short version:** turn notifications on once, on your phone (**Settings →
Alerts → This device → Turn on**). That is all. The Jarvis app does not need
to be open, the car does not need to be on, and nothing else, such as Telegram,
needs setting up. After restarting the phone, there is nothing to do.

## Where an alert goes

Jarvis tries, in order, and stops at the first that reaches you:

1. **A Jarvis screen in front of someone** — the car's screen, a browser tab
   you are looking at. It shows the alert, and says it aloud unless that
   screen is set not to (**Settings → Alerts → This device**). It counts only
   if the screen confirms within four seconds; a tab in the background does
   not.
2. **Notifications**, on every device where you turned them on, all at once.
3. **The optional extras** set up in **Settings → Alerts**: Telegram, ntfy, a
   webhook, Home Assistant. Used only if nothing before them worked.

An urgent alert goes to all of them. The order can be changed in **Settings →
Alerts**.

"Send that to my phone" skips step 1: it goes straight to your notifications,
even when you ask from the car.

## Turning on notifications

On each device you want them on:

- **Android:** open Jarvis in Chrome (from the Home Screen icon, if you added
  one), then **Settings → Alerts → This device → Turn on**, and allow
  notifications when asked.
- **iPhone and iPad:** add Jarvis to the Home Screen first (Share → Add to Home
  Screen), open it from there, then **Settings → Alerts → This device → Turn
  on**. Safari only offers notifications to an app on the Home Screen.
- **A computer:** the same, in Chrome, Edge, Firefox or Safari.

**Settings → Alerts** lists every device that receives them, and **Remove**
takes one off.

## Do I need to keep Jarvis open?

No. A notification is carried by your phone's own push service (Google's on
Android, Apple's on iPhone) and shown by the browser in the background. With
Jarvis closed, the phone locked, or after a restart, it still arrives. The text
is encrypted for your browser; the push service carries it without being able
to read it. Tap a notification and Jarvis opens on that alert.

Each time you open Jarvis, it quietly checks in the device's notifications
with your Jarvis again, so one that slipped off the list (a push service can
replace them now and then) is back without you doing anything. A device you
removed yourself in **Settings → Alerts** stays removed until you turn
notifications on again on it.

You need to turn notifications on again only if, on that device, you clear the
browser's or the site's data, remove Jarvis from the Home Screen, or block its
notifications. Jarvis notices a device that has gone and takes it off the list.

## How quickly, and how long they wait

- **Within seconds, even on an idle phone.** Every alert is sent as high
  priority, so a phone lying on a table with the screen off is woken for it
  rather than told at its next battery-saving check.
- **Up to a day, if the phone is off or out of signal.** The push service
  holds the notification and delivers it when the phone is back.
- **Except "time to leave".** That one is held only until the appointment
  starts. After that it is of no use, so a phone that was off all along is not
  told late.

## Check that it works

1. On your phone, close Jarvis and lock the screen.
2. On another screen, the car or a laptop: **Settings → Alerts → Test**.
3. The notification should arrive within seconds.

**Settings → Alerts** also shows the last few alerts and how each one went:
"shown on the car", "1 of 1 device accepted", or what failed.

## When it doesn't arrive

| What you see | Why | What to do |
|---|---|---|
| Nothing, ever | Notifications are not on for this device, or the phone blocks them. | On the phone: **Settings → Alerts → This device → Turn on**. Then check the phone's own notification settings for Jarvis (or Chrome). |
| Nothing, since clearing data or reinstalling | That removed the device's notifications. | Turn them on again on that device. |
| Late, or only when you pick up the phone | Battery saving is holding the browser back, or Do Not Disturb is on. | Let Chrome (or Jarvis) run in the background, "Unrestricted" in the phone's battery settings. Check Do Not Disturb. |
| On iPhone, no "Turn on" | Jarvis was opened in Safari, not from the Home Screen. | Add it to the Home Screen and open it from there. |
| Heard in the car, nothing on the phone | The car's screen was in front of you, so the alert stopped there. | That is by design. Say "send that to my phone" for a copy. |
| A "time to leave" never came | The phone was unreachable until the appointment had started. | By design: it would have been too late. |

## For developers

Raising alerts from elsewhere (Home Assistant, Node-RED, a script), receiving
them on a socket, and the webhook's signature are in the
[device API reference](api.md#alerts).
