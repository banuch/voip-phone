#include "settings.h"
#include "app_config.h"
#include <Preferences.h>

namespace {

const char *NS = "sipphone";

Settings defaults() {
  Settings s;
  s.wifiSsid = WIFI_SSID;
  s.wifiPassword = WIFI_PASSWORD;
  s.sipServer = SIP_SERVER;
  s.sipDomain = SIP_DOMAIN;
  s.sipUser = SIP_USER;
  s.sipAuthUser = SIP_AUTH_USER;
  s.sipPassword = SIP_PASSWORD;
  s.otaPassword = OTA_PASSWORD;
  s.sipServerPort = SIP_SERVER_PORT;
  s.sipLocalPort = SIP_LOCAL_PORT;
  s.rtpLocalPort = RTP_LOCAL_PORT;
  s.sipExpires = SIP_EXPIRES;
  s.autoAnswerMs = AUTO_ANSWER_MS;
  s.micGain = MIC_GAIN;
  s.speakerVolume = SPEAKER_VOLUME;
  return s;
}

// ---- minimal JSON: flat object of strings, numbers, booleans, null ----
void skipWs(const String &s, int &i) {
  while (i < (int)s.length() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
}

void appendUtf8(String &out, uint32_t cp) {
  if (cp < 0x80) out += char(cp);
  else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
  else { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
}

bool parseString(const String &s, int &i, String &out) {
  if (i >= (int)s.length() || s[i] != '"') return false;
  i++;
  while (i < (int)s.length()) {
    char c = s[i++];
    if (c == '"') return true;
    if (c != '\\') { out += c; continue; }
    if (i >= (int)s.length()) return false;
    char e = s[i++];
    switch (e) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        if (i + 4 > (int)s.length()) return false;
        appendUtf8(out, strtoul(s.substring(i, i + 4).c_str(), nullptr, 16));
        i += 4;
        break;
      }
      default: return false;
    }
  }
  return false;
}

// Scalar token (number / true / false / null) as raw text.
bool parseScalar(const String &s, int &i, String &out) {
  int start = i;
  while (i < (int)s.length() && s[i] != ',' && s[i] != '}' && s[i] != ' ' && s[i] != '\r' && s[i] != '\n' && s[i] != '\t') i++;
  out = s.substring(start, i);
  return out.length() > 0;
}

String escape(const String &v) {
  String o = "\"";
  for (unsigned i = 0; i < v.length(); i++) {
    char c = v[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if ((uint8_t)c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
    else o += c;
  }
  return o + "\"";
}

bool toLong(const String &raw, long lo, long hi, long &out) {
  char *end = nullptr;
  out = strtol(raw.c_str(), &end, 10);
  return end && *end == 0 && raw.length() && out >= lo && out <= hi;
}

}  // namespace

namespace settings {

Settings cfg;

void begin() {
  Settings d = defaults();
  Preferences p;
  if (!p.begin(NS, true)) {  // namespace absent on first boot
    cfg = d;
    return;
  }
  cfg.wifiSsid = p.getString("wifi_ssid", d.wifiSsid);
  cfg.wifiPassword = p.getString("wifi_pass", d.wifiPassword);
  cfg.sipServer = p.getString("sip_server", d.sipServer);
  cfg.sipDomain = p.getString("sip_domain", d.sipDomain);
  cfg.sipUser = p.getString("sip_user", d.sipUser);
  cfg.sipAuthUser = p.getString("sip_auth", d.sipAuthUser);
  cfg.sipPassword = p.getString("sip_pass", d.sipPassword);
  cfg.otaPassword = p.getString("ota_pass", d.otaPassword);
  cfg.sipServerPort = p.getUShort("srv_port", d.sipServerPort);
  cfg.sipLocalPort = p.getUShort("sip_lport", d.sipLocalPort);
  cfg.rtpLocalPort = p.getUShort("rtp_port", d.rtpLocalPort);
  cfg.sipExpires = p.getUInt("expires", d.sipExpires);
  cfg.autoAnswerMs = p.getInt("auto_ans", d.autoAnswerMs);
  cfg.micGain = p.getInt("mic_gain", d.micGain);
  cfg.speakerVolume = p.getInt("volume", d.speakerVolume);
  p.end();
}

bool configured() {
  return cfg.wifiSsid.length() && cfg.sipServer.length() && cfg.sipUser.length();
}

bool validate(const Settings &s, String &err) {
  if (s.wifiSsid.isEmpty() || s.wifiSsid.length() > 32) err = "Wi-Fi SSID must be 1-32 characters";
  else if (s.wifiPassword.length() && (s.wifiPassword.length() < 8 || s.wifiPassword.length() > 63)) err = "Wi-Fi password must be empty (open network) or 8-63 characters";
  else if (s.sipServer.isEmpty() || s.sipServer.length() > 64) err = "SIP server must be 1-64 characters";
  else if (s.sipDomain.length() > 64) err = "SIP domain too long";
  else if (s.sipUser.isEmpty() || s.sipUser.length() > 32) err = "SIP user must be 1-32 characters";
  else if (s.sipAuthUser.length() > 32) err = "SIP auth user too long";
  else if (s.sipPassword.length() > 64) err = "SIP password too long";
  else if (s.otaPassword.length() && (s.otaPassword.length() < 8 || s.otaPassword.length() > 64)) err = "Update password must be empty (updates off) or 8-64 characters";
  else if (!s.sipServerPort || !s.sipLocalPort || !s.rtpLocalPort) err = "Ports must be 1-65535";
  else if (s.sipLocalPort == s.rtpLocalPort) err = "SIP and RTP local ports must differ";
  else if (s.sipExpires < 60 || s.sipExpires > 86400) err = "SIP expires must be 60-86400 s";
  else if (s.autoAnswerMs < -1 || s.autoAnswerMs > 60000) err = "Auto-answer must be -1 to 60000 ms";
  else if (s.micGain < 1 || s.micGain > 32) err = "Mic gain must be 1-32";
  else if (s.speakerVolume < 0 || s.speakerVolume > 100) err = "Speaker volume must be 0-100";
  else return true;
  return false;
}

bool save(const Settings &s, String &err) {
  if (!validate(s, err)) return false;
  Preferences p;
  if (!p.begin(NS, false)) { err = "NVS unavailable"; return false; }
  bool ok = true;
  ok &= p.putString("wifi_ssid", s.wifiSsid) == s.wifiSsid.length();
  p.putString("wifi_pass", s.wifiPassword);  // may be empty: putString returns 0
  ok &= p.putString("sip_server", s.sipServer) == s.sipServer.length();
  p.putString("sip_domain", s.sipDomain);
  ok &= p.putString("sip_user", s.sipUser) == s.sipUser.length();
  p.putString("sip_auth", s.sipAuthUser);
  p.putString("sip_pass", s.sipPassword);
  p.putString("ota_pass", s.otaPassword);
  ok &= p.putUShort("srv_port", s.sipServerPort) > 0;
  ok &= p.putUShort("sip_lport", s.sipLocalPort) > 0;
  ok &= p.putUShort("rtp_port", s.rtpLocalPort) > 0;
  ok &= p.putUInt("expires", s.sipExpires) > 0;
  ok &= p.putInt("auto_ans", s.autoAnswerMs) > 0;
  ok &= p.putInt("mic_gain", s.micGain) > 0;
  ok &= p.putInt("volume", s.speakerVolume) > 0;
  p.end();
  if (!ok) { err = "NVS write failed"; return false; }
  cfg = s;
  return true;
}

void saveAudio(int volume, int micGain) {
  cfg.speakerVolume = volume;
  cfg.micGain = micGain;
  Preferences p;
  if (!p.begin(NS, false)) return;
  p.putInt("volume", volume);
  p.putInt("mic_gain", micGain);
  p.end();
}

void factoryReset() {
  Preferences p;
  if (p.begin(NS, false)) { p.clear(); p.end(); }
  cfg = defaults();
}

String toJson(const Settings &s) {
  String j = "{";
  j += "\"wifi_ssid\":" + escape(s.wifiSsid);
  j += ",\"wifi_password_set\":" + String(s.wifiPassword.length() ? "true" : "false");
  j += ",\"sip_server\":" + escape(s.sipServer);
  j += ",\"sip_server_port\":" + String(s.sipServerPort);
  j += ",\"sip_domain\":" + escape(s.sipDomain);
  j += ",\"sip_user\":" + escape(s.sipUser);
  j += ",\"sip_auth_user\":" + escape(s.sipAuthUser);
  j += ",\"sip_password_set\":" + String(s.sipPassword.length() ? "true" : "false");
  j += ",\"ota_password_set\":" + String(s.otaPassword.length() ? "true" : "false");
  j += ",\"sip_expires\":" + String(s.sipExpires);
  j += ",\"sip_local_port\":" + String(s.sipLocalPort);
  j += ",\"rtp_local_port\":" + String(s.rtpLocalPort);
  j += ",\"auto_answer_ms\":" + String(s.autoAnswerMs);
  j += ",\"mic_gain\":" + String(s.micGain);
  j += ",\"speaker_volume\":" + String(s.speakerVolume);
  return j + "}";
}

bool mergeJson(const String &json, Settings &s, String &err) {
  int i = 0;
  skipWs(json, i);
  if (i >= (int)json.length() || json[i] != '{') { err = "JSON object expected"; return false; }
  i++;
  skipWs(json, i);
  if (i < (int)json.length() && json[i] == '}') return true;
  while (i < (int)json.length()) {
    String key, val;
    skipWs(json, i);
    if (!parseString(json, i, key)) { err = "bad JSON key"; return false; }
    skipWs(json, i);
    if (i >= (int)json.length() || json[i] != ':') { err = "':' expected after " + key; return false; }
    i++;
    skipWs(json, i);
    bool isString = i < (int)json.length() && json[i] == '"';
    if (isString ? !parseString(json, i, val) : !parseScalar(json, i, val)) { err = "bad value for " + key; return false; }
    if (!isString && (val == "{" || val[0] == '[' || val[0] == '{')) { err = "nested values not supported"; return false; }

    long n = 0;
    auto num = [&](long lo, long hi) {
      if (isString || !toLong(val, lo, hi, n)) { err = key + " must be a number " + String(lo) + ".." + String(hi); return false; }
      return true;
    };
    auto str = [&](String &field) {
      if (!isString) { err = key + " must be a string"; return false; }
      field = val;
      return true;
    };
    bool ok = true;
    if (key == "wifi_ssid") ok = str(s.wifiSsid);
    else if (key == "wifi_password") ok = str(s.wifiPassword);
    else if (key == "sip_server") ok = str(s.sipServer);
    else if (key == "sip_domain") ok = str(s.sipDomain);
    else if (key == "sip_user") ok = str(s.sipUser);
    else if (key == "sip_auth_user") ok = str(s.sipAuthUser);
    else if (key == "sip_password") ok = str(s.sipPassword);
    else if (key == "ota_password") ok = str(s.otaPassword);
    else if (key == "sip_server_port") { if ((ok = num(1, 65535))) s.sipServerPort = n; }
    else if (key == "sip_local_port") { if ((ok = num(1, 65535))) s.sipLocalPort = n; }
    else if (key == "rtp_local_port") { if ((ok = num(1, 65535))) s.rtpLocalPort = n; }
    else if (key == "sip_expires") { if ((ok = num(60, 86400))) s.sipExpires = n; }
    else if (key == "auto_answer_ms") { if ((ok = num(-1, 60000))) s.autoAnswerMs = n; }
    else if (key == "mic_gain") { if ((ok = num(1, 32))) s.micGain = n; }
    else if (key == "speaker_volume") { if ((ok = num(0, 100))) s.speakerVolume = n; }
    // Unknown keys (e.g. *_password_set echoed back) are ignored.
    if (!ok) return false;

    skipWs(json, i);
    if (i < (int)json.length() && json[i] == ',') { i++; continue; }
    if (i < (int)json.length() && json[i] == '}') return true;
    err = "',' or '}' expected";
    return false;
  }
  err = "unterminated JSON";
  return false;
}

}  // namespace settings
