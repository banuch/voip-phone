import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import '../phone_session.dart';
import '../protocol.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'setup_screen.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  BluetoothAdapterState _adapter = BluetoothAdapterState.unknown;
  List<ScanResult> _results = [];
  bool _scanning = false;
  String? _error;
  String? _connectingId;
  late final StreamSubscription<BluetoothAdapterState> _adapterSub;
  late final StreamSubscription<List<ScanResult>> _resultsSub;
  late final StreamSubscription<bool> _scanningSub;

  @override
  void initState() {
    super.initState();
    _adapterSub = FlutterBluePlus.adapterState.listen((s) {
      final wasOff = _adapter != BluetoothAdapterState.on;
      setState(() => _adapter = s);
      if (s == BluetoothAdapterState.on && wasOff) _scan();
    });
    _resultsSub = FlutterBluePlus.onScanResults.listen((r) {
      if (!mounted) return;
      setState(() => _results = [...r]..sort((a, b) => b.rssi.compareTo(a.rssi)));
    });
    _scanningSub = FlutterBluePlus.isScanning.listen((s) {
      if (mounted) setState(() => _scanning = s);
    });
  }

  @override
  void dispose() {
    _adapterSub.cancel();
    _resultsSub.cancel();
    _scanningSub.cancel();
    FlutterBluePlus.stopScan();
    super.dispose();
  }

  Future<void> _scan() async {
    setState(() {
      _error = null;
      _results = [];
    });
    try {
      await FlutterBluePlus.startScan(
        withServices: [serviceUuid],
        timeout: const Duration(seconds: 12),
      );
    } catch (e) {
      if (mounted) setState(() => _error = 'Scan failed: $e');
    }
  }

  Future<void> _open(ScanResult r) async {
    await FlutterBluePlus.stopScan();
    final session = PhoneSession(r.device);
    setState(() => _connectingId = r.device.remoteId.str);
    try {
      await session.connect();
    } catch (_) {
      if (!mounted) return;
      setState(() => _connectingId = null);
      final msg = session.message?.text ?? 'Connection failed';
      session.dispose();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      return;
    }
    if (!mounted) {
      session.dispose();
      return;
    }
    setState(() => _connectingId = null);
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SetupScreen(session: session),
    ));
    session.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final size = windowSizeOf(context);
    final pad = size == WindowSize.compact ? 16.0 : 32.0;
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _scan,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverToBoxAdapter(
                child: ContentWidth(
                  maxWidth: 960,
                  padding: EdgeInsets.fromLTRB(pad, pad, pad, 8),
                  child: _Header(scanning: _scanning, onScan: _adapterOn ? _scan : null),
                ),
              ),
              ..._body(context, size, pad),
            ],
          ),
        ),
      ),
    );
  }

  bool get _adapterOn => _adapter == BluetoothAdapterState.on;

  List<Widget> _body(BuildContext context, WindowSize size, double pad) {
    Widget boxed(Widget child) => SliverToBoxAdapter(
          child: ContentWidth(maxWidth: 960, padding: EdgeInsets.symmetric(horizontal: pad, vertical: 8), child: child),
        );

    if (_adapter == BluetoothAdapterState.unavailable) {
      return [boxed(const EmptyState(icon: Icons.bluetooth_disabled, title: 'Bluetooth LE is not available on this device'))];
    }
    if (_adapter == BluetoothAdapterState.unauthorized) {
      return [
        boxed(const EmptyState(
          icon: Icons.lock_outline,
          title: 'Bluetooth permission needed',
          body: 'Allow this app to use Bluetooth (Nearby devices) in your system settings, then come back.',
        )),
      ];
    }
    if (!_adapterOn && _adapter != BluetoothAdapterState.unknown) {
      return [
        boxed(EmptyState(
          icon: Icons.bluetooth_disabled,
          title: 'Bluetooth is off',
          body: 'Turn on Bluetooth to find your phone.',
          action: Platform.isAndroid
              ? FilledButton.icon(
                  onPressed: () => FlutterBluePlus.turnOn(),
                  icon: const Icon(Icons.bluetooth),
                  label: const Text('Turn on Bluetooth'),
                )
              : null,
        )),
      ];
    }

    final widgets = <Widget>[
      if (_error != null) boxed(MessageBanner(message: SessionMessage(_error!, Tone.error))),
    ];

    if (_results.isEmpty) {
      widgets.add(boxed(_scanning
          ? const EmptyState(
              icon: Icons.bluetooth_searching,
              title: 'Looking for phones...',
              body: 'Powered phones show up here as SipPhone-XXXX.',
              loading: true,
            )
          : EmptyState(
              icon: Icons.phonelink_ring_outlined,
              title: 'No phones found',
              body: 'Make sure the phone is powered and within a few metres, then scan again. '
                  'If it is still missing, check its serial log for "[BLE] advertising".',
              action: FilledButton.icon(
                onPressed: _adapterOn ? _scan : null,
                icon: const Icon(Icons.refresh),
                label: const Text('Scan again'),
              ),
            )));
      return widgets;
    }

    final columns = switch (size) {
      WindowSize.compact => 1,
      WindowSize.medium => 2,
      WindowSize.expanded => 3,
    };
    // Center the grid at the same 960 px max width as the header.
    final width = MediaQuery.sizeOf(context).width;
    final side = width > 960 + 2 * pad ? (width - 960) / 2 : pad;
    widgets.add(SliverPadding(
      padding: EdgeInsets.fromLTRB(side, 8, side, 24),
      sliver: SliverGrid(
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            mainAxisExtent: 92,
          ),
          delegate: SliverChildBuilderDelegate(
            (context, i) {
              final r = _results[i];
              return _DeviceCard(
                result: r,
                connecting: _connectingId == r.device.remoteId.str,
                enabled: _connectingId == null,
                onTap: () => _open(r),
              );
            },
            childCount: _results.length,
          ),
      ),
    ));
    return widgets;
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.scanning, required this.onScan});
  final bool scanning;
  final VoidCallback? onScan;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: t.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Icon(Icons.dialer_sip_outlined, color: t.colorScheme.onPrimaryContainer, size: 28),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('SIP Phone Setup', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  Text('Configure your ESP32 phone over Bluetooth',
                      style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        Row(
          children: [
            Text('Nearby phones', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const Spacer(),
            if (scanning)
              const Padding(
                padding: EdgeInsets.only(right: 12),
                child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              ),
            TextButton.icon(
              onPressed: scanning ? () => FlutterBluePlus.stopScan() : onScan,
              icon: Icon(scanning ? Icons.stop_circle_outlined : Icons.refresh),
              label: Text(scanning ? 'Stop' : 'Scan'),
            ),
          ],
        ),
      ],
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({required this.result, required this.connecting, required this.enabled, required this.onTap});
  final ScanResult result;
  final bool connecting;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final name = result.advertisementData.advName.isNotEmpty
        ? result.advertisementData.advName
        : result.device.platformName.isNotEmpty
            ? result.device.platformName
            : 'SIP phone';
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              CircleAvatar(
                radius: 24,
                backgroundColor: t.colorScheme.secondaryContainer,
                child: Icon(Icons.phone_in_talk_outlined, color: t.colorScheme.onSecondaryContainer),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(result.device.remoteId.str,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (connecting)
                const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5))
              else
                SignalBars(rssi: result.rssi),
            ],
          ),
        ),
      ),
    );
  }
}
