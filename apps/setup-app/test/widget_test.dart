import 'package:flutter_test/flutter_test.dart';
import 'package:sipphone_setup/src/protocol.dart';

void main() {
  test('parses the config JSON the phone sends', () {
    final c = PhoneConfig.fromJson({
      'wifi_ssid': 'Home',
      'wifi_password_set': true,
      'sip_server': '192.168.1.50',
      'sip_server_port': 5060,
      'sip_user': '1001',
      'sip_password_set': false,
      'auto_answer_ms': -1,
      'mic_gain': 8,
      'speaker_volume': 70,
    });
    expect(c.wifiSsid, 'Home');
    expect(c.wifiPasswordSet, isTrue);
    expect(c.sipPasswordSet, isFalse);
    expect(c.autoAnswerMs, -1);
    expect(c.rtpLocalPort, 4000); // default when missing
  });

  test('parses the status JSON the phone sends', () {
    final s = PhoneStatus.fromJson({
      'configured': true,
      'wifi': 'connected',
      'ip': '192.168.1.80',
      'rssi': -55,
      'sip': 'registered',
      'sip_detail': '',
      'call': 'idle',
      'result': 'ready',
      'detail': '',
    });
    expect(s.wifiUp, isTrue);
    expect(s.sipUp, isTrue);
    expect(s.rssi, -55);
  });
}
