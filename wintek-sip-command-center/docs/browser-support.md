# Browser support (operator console)

| Browser | Calling | Speaker selection (`setSinkId`) | Notes |
|---------|---------|-------------------------------|-------|
| Chrome / Edge (current, desktop) | ✅ | ✅ | recommended for operator workstations |
| Firefox (current, desktop) | ✅ | ✅ (116+) | |
| Safari 17+ (macOS) | ✅ | ❌ — system default output | |
| iPadOS / Android Chrome (tablet) | supervisory screens; calling works but is not the target | varies | |

The console detects `setSinkId` support and disables the speaker selector
with an explanation when it's missing.

## Requirements
* **HTTPS** — WebRTC and microphone access need a secure context.
* **Microphone permission** — requested when the console starts, so the first
  CALL is instant. Denied permission shows a FAULT presence and blocks calls.
* **Media reachability** — UDP to the media node, or TURN (coturn with
  short-lived REST credentials issued by the API) when workstations are
  behind restrictive firewalls.

## Behaviour to know
* Reloading the page during a call drops the browser's audio leg; the server
  ends that call (recorded) and the console shows it on reload. A
  `beforeunload` prompt warns operators first.
* Closing the tab stops heartbeats; the operator becomes OFFLINE after 30 s
  and receives no routed work.
* Keyboard: `/` focuses search, `M` mutes, `Alt+H` hangs up, all controls are
  reachable by Tab, rows open with Enter.
