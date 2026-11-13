// GATT protocol of the ESP32-S3 SIP phone (see firmware/ESP32S3_SipPhone/ble_prov.h).
//
// Service  6b3f0001-...  Config (read/write, encrypted), Command (write, encrypted),
// Status (read/notify). To save: write "begin" to Command, the settings JSON to
// Config in chunks (appended), then "save".
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

final serviceUuid = Guid('6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01');
final configUuid = Guid('6b3f0002-7c1a-4d2e-9b8f-2a1c5e7d9f01');
final commandUuid = Guid('6b3f0003-7c1a-4d2e-9b8f-2a1c5e7d9f01');
final statusUuid = Guid('6b3f0004-7c1a-4d2e-9b8f-2a1c5e7d9f01');

/// Settings as the phone reports them. Passwords are never read back,
/// only whether one is stored.
class PhoneConfig {
  PhoneConfig({
    this.wifiSsid = '',
    this.wifiPasswordSet = false,
    this.sipServer = '',
    this.sipServerPort = 5060,
    this.sipDomain = '',
    this.sipUser = '',
    this.sipAuthUser = '',
    this.sipPasswordSet = false,
    this.otaPasswordSet = false,
    this.sipExpires = 300,
    this.sipLocalPort = 5060,
    this.rtpLocalPort = 4000,
    this.autoAnswerMs = 1000,
    this.micGain = 4,
    this.speakerVolume = 60,
  });

  final String wifiSsid;
  final bool wifiPasswordSet;
  final String sipServer;
  final int sipServerPort;
  final String sipDomain;
  final String sipUser;
  final String sipAuthUser;
  final bool sipPasswordSet;
  final bool otaPasswordSet;
  final int sipExpires;
  final int sipLocalPort;
  final int rtpLocalPort;
  final int autoAnswerMs;
  final int micGain;
  final int speakerVolume;

  factory PhoneConfig.fromJson(Map<String, dynamic> j) {
    int n(String k, int d) => (j[k] as num?)?.toInt() ?? d;
    String s(String k) => (j[k] as String?) ?? '';
    return PhoneConfig(
      wifiSsid: s('wifi_ssid'),
      wifiPasswordSet: j['wifi_password_set'] == true,
      sipServer: s('sip_server'),
      sipServerPort: n('sip_server_port', 5060),
      sipDomain: s('sip_domain'),
      sipUser: s('sip_user'),
      sipAuthUser: s('sip_auth_user'),
      sipPasswordSet: j['sip_password_set'] == true,
      otaPasswordSet: j['ota_password_set'] == true,
      sipExpires: n('sip_expires', 300),
      sipLocalPort: n('sip_local_port', 5060),
      rtpLocalPort: n('rtp_local_port', 4000),
      autoAnswerMs: n('auto_answer_ms', 1000),
      micGain: n('mic_gain', 4),
      speakerVolume: n('speaker_volume', 60),
    );
  }
}

/// Live state from the Status characteristic.
class PhoneStatus {
  const PhoneStatus({
    this.configured = false,
    this.wifi = '',
    this.ip = '',
    this.rssi = 0,
    this.sip = '',
    this.sipDetail = '',
    this.call = '',
    this.fw = '',
    this.otaUrl = '',
    this.result = '',
    this.detail = '',
  });

  final bool configured;
  final String wifi; // "not set" | "connecting" | "connected"
  final String ip;
  final int rssi;
  final String sip; // "registered" | "not registered"
  final String sipDetail;
  final String call;
  final String fw; // firmware version
  final String otaUrl; // http://<ip>/update when Wi-Fi updates are on
  final String result; // ready | saved | error | rebooting | reset
  final String detail;

  bool get wifiUp => wifi == 'connected';
  bool get sipUp => sip == 'registered';

  factory PhoneStatus.fromJson(Map<String, dynamic> j) => PhoneStatus(
        configured: j['configured'] == true,
        wifi: (j['wifi'] as String?) ?? '',
        ip: (j['ip'] as String?) ?? '',
        rssi: (j['rssi'] as num?)?.toInt() ?? 0,
        sip: (j['sip'] as String?) ?? '',
        sipDetail: (j['sip_detail'] as String?) ?? '',
        call: (j['call'] as String?) ?? '',
        fw: (j['fw'] as String?) ?? '',
        otaUrl: (j['ota_url'] as String?) ?? '',
        result: (j['result'] as String?) ?? '',
        detail: (j['detail'] as String?) ?? '',
      );
}
