# SIP Phone Setup (Flutter)

Android / iOS app that configures the `firmware/ESP32S3_SipPhone` over Bluetooth LE. It speaks the same GATT protocol as `firmware/ESP32S3_SipPhone/provision.html`, so the phone firmware needs no changes.

## Features

- Scans only for SIP phones (`SipPhone-XXXX`, service `6b3f0001-…`) and shows signal strength
- Live Wi-Fi / IP / SIP / call status from the Status notifications
- Wi-Fi, SIP account, auto-answer, volume and mic gain sliders, advanced ports, with the same validation as the firmware
- Passwords are write-only: leave a field empty to keep the stored one
- Save, restart, factory reset; reconnects automatically after the phone restarts
- Responsive: single column on phones, wider column on tablets, side status panel + form on large screens; light and dark themes

## Run

```bash
flutter pub get
flutter run
```

The phone advertises over Bluetooth whenever it is powered. Android asks for the Nearby devices permission on first scan; accept the pairing prompt when connecting.

## Layout

| File | Purpose |
| --- | --- |
| `lib/src/protocol.dart` | UUIDs and the config / status JSON models |
| `lib/src/phone_session.dart` | Connection, chunked save, commands, reconnect after restart |
| `lib/src/screens/scan_screen.dart` | Find nearby phones |
| `lib/src/screens/setup_screen.dart` | Status and settings form |
| `lib/src/widgets/common.dart`, `lib/src/theme.dart` | Shared widgets, theme, breakpoints |

`test/layout_test.dart` renders the setup screen at 320 px to 1440 px in both themes and fails on any overflow.

BLE uses [flutter_blue_plus](https://pub.dev/packages/flutter_blue_plus) with `License.nonprofit` (personal use). Commercial use needs a flutter_blue_plus commercial license; change the `license:` argument in `phone_session.dart`.
