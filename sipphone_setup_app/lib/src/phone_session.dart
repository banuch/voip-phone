import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'protocol.dart';

enum SessionState { disconnected, connecting, ready, restarting }

enum Tone { info, success, warning, error }

class SessionMessage {
  const SessionMessage(this.text, [this.tone = Tone.info]);
  final String text;
  final Tone tone;
}

/// One GATT connection to a phone in setup mode.
class PhoneSession extends ChangeNotifier {
  PhoneSession(this.device);

  final BluetoothDevice device;

  SessionState state = SessionState.disconnected;
  PhoneStatus? status;
  PhoneConfig? config;
  SessionMessage? message;
  bool busy = false;

  /// Bumped whenever a fresh config arrives so the form can refill itself.
  int configVersion = 0;

  BluetoothCharacteristic? _config, _command, _status;
  StreamSubscription<BluetoothConnectionState>? _connSub;
  StreamSubscription<List<int>>? _statusSub;
  bool _savedPending = false;
  bool _userDisconnect = false;
  bool _disposed = false;

  String get name => device.platformName.isNotEmpty
      ? device.platformName
      : device.advName.isNotEmpty
          ? device.advName
          : 'SIP phone';

  bool get isReady => state == SessionState.ready;

  void _say(String text, [Tone tone = Tone.info]) {
    message = SessionMessage(text, tone);
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> connect() async {
    _userDisconnect = false;
    state = SessionState.connecting;
    _say('Connecting to $name...');
    try {
      await _attach();
      _say('Connected. Settings loaded.', Tone.success);
    } catch (e) {
      state = SessionState.disconnected;
      _say('Connection failed: ${_describe(e)}', Tone.error);
      rethrow;
    }
  }

  /// Connect, discover, subscribe to status and read the config.
  /// The first connection to a new phone fails often, so retry.
  Future<void> _attach({int tries = 3}) async {
    for (var i = 1;; i++) {
      try {
        await device.connect(license: License.nonprofit, timeout: const Duration(seconds: 15));
        break;
      } catch (e) {
        if (i >= tries) rethrow;
        _say('Connection attempt $i failed, retrying...', Tone.warning);
        await Future<void>.delayed(Duration(seconds: i));
      }
    }

    _connSub ??= device.connectionState.listen(_onConnectionState);

    final services = await device.discoverServices();
    final svc = services.firstWhere(
      (s) => s.uuid == serviceUuid,
      orElse: () => throw StateError('This device is not a SIP phone in setup mode'),
    );
    BluetoothCharacteristic find(Guid id) => svc.characteristics.firstWhere((c) => c.uuid == id);
    _config = find(configUuid);
    _command = find(commandUuid);
    _status = find(statusUuid);

    await _statusSub?.cancel();
    _statusSub = _status!.onValueReceived.listen(_onStatusBytes);
    device.cancelWhenDisconnected(_statusSub!);
    await _status!.setNotifyValue(true);
    _onStatusBytes(await _status!.read());

    // Encrypted characteristic: the first read triggers pairing.
    await _readConfig();
    state = SessionState.ready;
    _notify();
  }

  Future<void> _readConfig() async {
    List<int> bytes;
    try {
      bytes = await _config!.read();
    } catch (_) {
      // Android sometimes fails the read that triggered bonding; retry once paired.
      await Future<void>.delayed(const Duration(seconds: 2));
      bytes = await _config!.read();
    }
    config = PhoneConfig.fromJson(jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>);
    configVersion++;
  }

  Future<void> reload() => _guard('Reload', () async {
        await _readConfig();
        _say('Reloaded settings from the phone.', Tone.success);
      });

  void _onStatusBytes(List<int> bytes) {
    if (bytes.isEmpty) return;
    try {
      final s = PhoneStatus.fromJson(jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>);
      status = s;
      switch (s.result) {
        case 'error':
          _say('The phone rejected the settings: ${s.detail}', Tone.error);
        case 'saved':
          _savedPending = true;
          _say('Saved. The phone is restarting to apply them...', Tone.success);
        case 'reset':
          _savedPending = true;
          _say('Settings erased. The phone is restarting...', Tone.warning);
        case 'rebooting':
          _savedPending = true;
          _say('The phone is restarting...', Tone.info);
        case 'exiting':
          _say('Bluetooth turned off on the phone.', Tone.info);
        default:
          _notify();
      }
    } catch (_) {
      // Ignore a malformed notification; the next one will replace it.
    }
  }

  void _onConnectionState(BluetoothConnectionState s) {
    if (s != BluetoothConnectionState.disconnected) return;
    if (state == SessionState.restarting || state == SessionState.connecting) return;
    state = SessionState.disconnected;
    if (_userDisconnect) {
      _notify();
    } else if (_savedPending) {
      _reconnectAfterRestart();
    } else {
      _say('The phone disconnected.', Tone.warning);
    }
  }

  /// After save / reboot / reset the phone restarts back into setup mode once.
  Future<void> _reconnectAfterRestart() async {
    state = SessionState.restarting;
    _notify();
    for (var attempt = 1; attempt <= 15 && !_disposed && !_userDisconnect; attempt++) {
      await Future<void>.delayed(const Duration(seconds: 2));
      _say('Waiting for the phone to restart (attempt $attempt of 15)...', Tone.info);
      try {
        await _attach(tries: 1);
        _savedPending = false;
        _say('Reconnected after restart. Check the Wi-Fi and SIP status.', Tone.success);
        return;
      } catch (_) {
        // keep trying
      }
    }
    _savedPending = false;
    state = SessionState.disconnected;
    if (!_userDisconnect) _say('The phone did not come back. Put it in setup mode and connect again.', Tone.warning);
  }

  Future<void> _write(BluetoothCharacteristic c, List<int> bytes) => c.write(bytes, withoutResponse: false);

  Future<void> _send(String cmd) => _write(_command!, utf8.encode(cmd));

  /// Sends only the keys in [values]; missing password keys keep the stored one.
  Future<void> save(Map<String, Object> values) => _guard('Save', () async {
        _say('Sending settings...');
        final bytes = utf8.encode(jsonEncode(values));
        // ATT payload is MTU - 3; stay well under the phone's 247-byte MTU.
        final chunk = max(20, min(device.mtuNow - 3, 180));
        await _send('begin');
        for (var i = 0; i < bytes.length; i += chunk) {
          await _write(_config!, bytes.sublist(i, min(i + chunk, bytes.length)));
        }
        await _send('save');
        _say('Settings sent, waiting for the phone to confirm...');
      });

  Future<void> reboot() => _guard('Restart', () => _send('reboot'));
  Future<void> factoryReset() => _guard('Factory reset', () => _send('factory_reset'));
  Future<void> turnOffBluetooth() => _guard('Turn off', () async {
        _userDisconnect = true;
        await _send('exit');
      });

  Future<void> _guard(String what, Future<void> Function() action) async {
    if (!isReady || busy) return;
    busy = true;
    _notify();
    try {
      await action();
    } catch (e) {
      _say('$what failed: ${_describe(e)}', Tone.error);
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<void> disconnect() async {
    _userDisconnect = true;
    _savedPending = false;
    await device.disconnect();
    state = SessionState.disconnected;
    _notify();
  }

  static String _describe(Object e) {
    if (e is FlutterBluePlusException) return e.description ?? e.function;
    final s = e.toString();
    return s.replaceFirst(RegExp(r'^(Exception|Bad state): '), '');
  }

  @override
  void dispose() {
    _disposed = true;
    _userDisconnect = true;
    _connSub?.cancel();
    _statusSub?.cancel();
    device.disconnect();
    super.dispose();
  }
}
