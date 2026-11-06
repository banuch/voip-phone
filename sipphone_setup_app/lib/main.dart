import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'src/screens/scan_screen.dart';
import 'src/theme.dart';

void main() {
  FlutterBluePlus.setLogLevel(LogLevel.warning);
  runApp(const SipPhoneSetupApp());
}

class SipPhoneSetupApp extends StatelessWidget {
  const SipPhoneSetupApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'SIP Phone Setup',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        home: const ScanScreen(),
      );
}
