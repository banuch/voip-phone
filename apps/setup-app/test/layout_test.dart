import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sipphone_setup/src/phone_session.dart';
import 'package:sipphone_setup/src/protocol.dart';
import 'package:sipphone_setup/src/screens/setup_screen.dart';
import 'package:sipphone_setup/src/theme.dart';

/// Renders the setup screen at phone, tablet and desktop widths and fails on
/// any layout overflow.
void main() {
  for (final size in const [Size(320, 640), Size(390, 844), Size(800, 1100), Size(1440, 900)]) {
    for (final b in Brightness.values) {
      testWidgets('setup screen lays out at ${size.width.toInt()}x${size.height.toInt()} ${b.name}', (t) async {
        t.view.physicalSize = size;
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);

        final session = PhoneSession(BluetoothDevice.fromId('AA:BB:CC:DD:EE:FF'))
          ..state = SessionState.ready
          ..config = PhoneConfig(wifiSsid: 'Home', sipServer: '192.168.1.50', sipUser: '1001', wifiPasswordSet: true)
          ..configVersion = 1
          ..status = const PhoneStatus(
              configured: true, wifi: 'connected', ip: '192.168.1.80', rssi: -58, sip: 'registered', call: 'idle')
          ..message = const SessionMessage('Connected. Settings loaded.', Tone.success);

        await t.pumpWidget(MaterialApp(theme: buildTheme(b), home: SetupScreen(session: session)));
        await t.pumpAndSettle();
        expect(find.text('Wi-Fi'), findsWidgets);
        expect(find.text('Save and restart'), findsOneWidget);

        if (size.width < 1000) {
          // Phone/tablet: the save bar is a short strip at the bottom and the
          // form is visible above it.
          final bar = t.getRect(find.ancestor(of: find.text('Save and restart'), matching: find.byType(FilledButton)));
          expect(bar.bottom, greaterThan(size.height - 40));
          expect(bar.top, greaterThan(size.height - 120));
          expect(t.getTopLeft(find.text('Phone status')).dy, lessThan(size.height / 2));
        }
      });
    }
  }
}
