// Minimal SIP UA (RFC 3261 subset) for one incoming call at a time, over UDP.
// Supports: REGISTER with MD5 digest auth, INVITE/ACK/CANCEL/BYE, re-INVITE,
// OPTIONS, NOTIFY. Audio is G.711 PCMU/PCMA negotiated through SDP.
#include "sip.h"
#include "app_config.h"
#include "audio.h"
#include "settings.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include <MD5Builder.h>
#include <vector>

namespace {

using settings::cfg;
const char *USER_AGENT = "ESP32S3-SipPhone/1.1";
const char *ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY";

// ---------------------------------------------------------------- parsing
struct Header {
  String name;  // lower-case, compact forms expanded
  String value;
};

struct Message {
  bool isRequest = false;
  String method, uri, reason;
  int status = 0;
  std::vector<Header> headers;
  String body;

  String get(const char *name) const {
    for (auto &h : headers) if (h.name == name) return h.value;
    return String();
  }
  std::vector<String> getAll(const char *name) const {
    std::vector<String> out;
    for (auto &h : headers) if (h.name == name) out.push_back(h.value);
    return out;
  }
  String cseqMethod() const {
    String c = get("cseq");
    int sp = c.indexOf(' ');
    String m = sp < 0 ? String() : c.substring(sp + 1);
    m.trim();
    return m;
  }
};

String canonicalName(String n) {
  n.trim();
  n.toLowerCase();
  if (n.length() == 1) {
    switch (n[0]) {
      case 'v': return "via";
      case 'f': return "from";
      case 't': return "to";
      case 'i': return "call-id";
      case 'm': return "contact";
      case 'l': return "content-length";
      case 'c': return "content-type";
      case 'k': return "supported";
    }
  }
  return n;
}

bool parseMessage(const char *buf, Message &m) {
  String text(buf);
  int hdrEnd = text.indexOf("\r\n\r\n");
  if (hdrEnd < 0) hdrEnd = text.length();
  else m.body = text.substring(hdrEnd + 4);
  int pos = 0;
  bool first = true;
  while (pos < hdrEnd) {
    int eol = text.indexOf("\r\n", pos);
    if (eol < 0 || eol > hdrEnd) eol = hdrEnd;
    String line = text.substring(pos, eol);
    pos = eol + 2;
    if (first) {
      first = false;
      if (line.startsWith("SIP/2.0 ")) {
        m.status = line.substring(8, 11).toInt();
        m.reason = line.substring(12);
      } else {
        int a = line.indexOf(' '), b = line.lastIndexOf(' ');
        if (a <= 0 || b <= a || !line.endsWith("SIP/2.0")) return false;
        m.isRequest = true;
        m.method = line.substring(0, a);
        m.uri = line.substring(a + 1, b);
      }
      continue;
    }
    if (!line.length()) continue;
    if ((line[0] == ' ' || line[0] == '\t') && !m.headers.empty()) {  // folded line
      line.trim();
      m.headers.back().value += " " + line;
      continue;
    }
    int colon = line.indexOf(':');
    if (colon <= 0) continue;
    Header h;
    h.name = canonicalName(line.substring(0, colon));
    h.value = line.substring(colon + 1);
    h.value.trim();
    m.headers.push_back(h);
  }
  String cl = m.get("content-length");
  if (cl.length() && cl.toInt() < (long)m.body.length()) m.body = m.body.substring(0, cl.toInt());
  return m.isRequest || m.status > 0;
}

// ;name=value parameter of a header (outside any <...> URI).
String headerParam(const String &v, const char *name) {
  int start = v.indexOf('>');
  start = start < 0 ? 0 : start;
  String lower = v;
  lower.toLowerCase();
  String key = String(";") + name + "=";
  int p = lower.indexOf(key, start);
  if (p < 0) return String();
  p += key.length();
  int e = p;
  while (e < (int)v.length() && v[e] != ';' && v[e] != ',' && v[e] != ' ' && v[e] != '>') e++;
  return v.substring(p, e);
}

// URI from a name-addr ("Bob" <sip:x@y>;tag=..) or addr-spec (sip:x@y;tag=..).
String uriOf(const String &v) {
  int a = v.indexOf('<');
  if (a >= 0) {
    int b = v.indexOf('>', a);
    return v.substring(a + 1, b < 0 ? v.length() : b);
  }
  int semi = v.indexOf(';');
  String u = semi < 0 ? v : v.substring(0, semi);
  u.trim();
  return u;
}

// key=value or key="value" from a Digest challenge.
String authParam(const String &h, const char *key) {
  String lower = h;
  lower.toLowerCase();
  String k = String(key) + "=";
  int p = 0;
  while ((p = lower.indexOf(k, p)) >= 0) {
    bool boundary = p == 0 || lower[p - 1] == ' ' || lower[p - 1] == ',' || lower[p - 1] == '\t';
    if (boundary) break;
    p += k.length();
  }
  if (p < 0) return String();
  p += k.length();
  if (p < (int)h.length() && h[p] == '"') {
    int e = h.indexOf('"', p + 1);
    return h.substring(p + 1, e < 0 ? h.length() : e);
  }
  int e = p;
  while (e < (int)h.length() && h[e] != ',' && h[e] != ' ') e++;
  return h.substring(p, e);
}

// ---------------------------------------------------------------- helpers
String randomHex(int bytes) {
  String s;
  char b[3];
  for (int i = 0; i < bytes; i++) {
    snprintf(b, sizeof(b), "%02x", (unsigned)(esp_random() & 0xFF));
    s += b;
  }
  return s;
}

String md5(const String &s) {
  MD5Builder b;
  b.begin();
  b.add(s);
  b.calculate();
  return b.toString();
}

bool due(uint32_t at) { return int32_t(millis() - at) >= 0; }

WiFiUDP udp;
bool started = false;
IPAddress serverIp;
String localIp;

String domain() { return cfg.domain(); }
String authUser() { return cfg.authUser(); }
String contactUri() { return "<sip:" + cfg.sipUser + "@" + localIp + ":" + String(cfg.sipLocalPort) + ">"; }
String viaHeader() {
  return "Via: SIP/2.0/UDP " + localIp + ":" + String(cfg.sipLocalPort) + ";branch=z9hG4bK" + randomHex(8) + ";rport\r\n";
}

void sendTo(IPAddress ip, uint16_t port, const String &msg) {
  udp.beginPacket(ip, port);
  udp.write((const uint8_t *)msg.c_str(), msg.length());
  udp.endPacket();
}

// ---------------------------------------------------------------- registration
enum RegState { REG_IDLE, REG_SENDING, REG_WAITING };
RegState regState = REG_IDLE;
bool isRegistered = false;
String regCallId, regFromTag, regAuth, regPacket, regLastError = "not started";
uint32_t regCseq = 0, regSentAt = 0, regNextAt = 0, regInterval = 500, regFirstSent = 0;
int regAuthTries = 0, regExpires = 300;

// Answers a Digest challenge; prefers an MD5 challenge when several are offered.
bool buildAuth(const Message &resp, const String &method, const String &uri, String &out) {
  bool proxy = resp.status == 407;
  std::vector<String> challenges = resp.getAll(proxy ? "proxy-authenticate" : "www-authenticate");
  String ch;
  for (auto &c : challenges) {
    String alg = authParam(c, "algorithm");
    alg.toUpperCase();
    if (alg.isEmpty() || alg == "MD5") { ch = c; break; }
  }
  if (ch.isEmpty()) return false;
  String realm = authParam(ch, "realm"), nonce = authParam(ch, "nonce");
  String opaque = authParam(ch, "opaque"), qop = authParam(ch, "qop");
  String ha1 = md5(authUser() + ":" + realm + ":" + cfg.sipPassword);
  String ha2 = md5(method + ":" + uri);
  bool useQop = qop.indexOf("auth") >= 0;
  String cnonce = randomHex(8), nc = "00000001";
  String response = useQop ? md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2)
                           : md5(ha1 + ":" + nonce + ":" + ha2);
  out = String(proxy ? "Proxy-Authorization" : "Authorization") + ": Digest username=\"" + authUser() +
        "\", realm=\"" + realm + "\", nonce=\"" + nonce + "\", uri=\"" + uri + "\", response=\"" +
        response + "\", algorithm=MD5";
  if (opaque.length()) out += ", opaque=\"" + opaque + "\"";
  if (useQop) out += ", qop=auth, nc=" + nc + ", cnonce=\"" + cnonce + "\"";
  out += "\r\n";
  return true;
}

void sendRegister() {
  String uri = "sip:" + domain();
  String aor = "<sip:" + cfg.sipUser + "@" + domain() + ">";
  regCseq++;
  regPacket = "REGISTER " + uri + " SIP/2.0\r\n" + viaHeader() +
              "Max-Forwards: 70\r\n"
              "From: " + aor + ";tag=" + regFromTag + "\r\n"
              "To: " + aor + "\r\n"
              "Call-ID: " + regCallId + "\r\n"
              "CSeq: " + String(regCseq) + " REGISTER\r\n"
              "Contact: " + contactUri() + "\r\n"
              "Expires: " + String(regExpires) + "\r\n" + regAuth +
              "Allow: " + ALLOW + "\r\n"
              "User-Agent: " + USER_AGENT + "\r\n"
              "Content-Length: 0\r\n\r\n";
  sendTo(serverIp, cfg.sipServerPort, regPacket);
  regState = REG_SENDING;
  regSentAt = regFirstSent = millis();
  regInterval = 500;
}

void startRegistration() {
  regAuth = "";
  regAuthTries = 0;
  sendRegister();
}

void registrationFailed(const String &why, uint32_t retryMs) {
  isRegistered = false;
  regLastError = why;
  regState = REG_WAITING;
  regNextAt = millis() + retryMs;
  Serial.printf("[SIP] registration failed: %s (retry in %lus)\n", why.c_str(), (unsigned long)(retryMs / 1000));
}

void handleRegisterResponse(const Message &m) {
  if (regState != REG_SENDING || m.status < 200) return;
  if (m.status == 200) {
    int exp = regExpires;
    for (auto &c : m.getAll("contact")) {  // our binding's expiry wins
      if (c.indexOf(localIp) >= 0) {
        String e = headerParam(c, "expires");
        if (e.length()) exp = e.toInt();
      }
    }
    if (exp == regExpires && m.get("expires").length()) exp = m.get("expires").toInt();
    if (exp <= 0) exp = regExpires;
    if (!isRegistered) Serial.printf("[SIP] registered as %s@%s (expires %ds)\n", cfg.sipUser.c_str(), domain().c_str(), exp);
    isRegistered = true;
    regLastError = "";
    regState = REG_WAITING;
    regNextAt = millis() + uint32_t(exp > 60 ? exp - 30 : exp / 2) * 1000;
  } else if ((m.status == 401 || m.status == 407) && regAuthTries < 2) {
    regAuthTries++;
    if (!buildAuth(m, "REGISTER", "sip:" + domain(), regAuth)) {
      registrationFailed("unsupported auth challenge", 30000);
      return;
    }
    sendRegister();
  } else if (m.status == 423 && m.get("min-expires").length()) {
    regExpires = m.get("min-expires").toInt();
    sendRegister();
  } else {
    registrationFailed(String(m.status) + " " + m.reason, 30000);
  }
}

void registrationTimers() {
  if (regState == REG_SENDING && due(regSentAt + regInterval)) {
    if (millis() - regFirstSent > 16000) {
      registrationFailed("no response from " + cfg.sipServer, 15000);
      return;
    }
    sendTo(serverIp, cfg.sipServerPort, regPacket);
    regSentAt = millis();
    regInterval = min<uint32_t>(regInterval * 2, 4000);
  } else if (regState != REG_SENDING && due(regNextAt)) {
    startRegistration();
  }
}

// ---------------------------------------------------------------- calls
enum CallState { CALL_IDLE, CALL_RINGING, CALL_ANSWERING, CALL_ACTIVE };
const char *STATE_NAMES[] = {"idle", "ringing", "answering", "in call"};
CallState callState = CALL_IDLE;

struct Dialog {
  Message invite;          // INVITE that created (or last updated) the dialog
  String callId, remote, local, localTag, target;  // remote=their From, local=our To+tag
  std::vector<String> routes;
  IPAddress srcIp;
  uint16_t srcPort = 0;
  IPAddress rtpIp;
  uint16_t rtpPort = 0;
  uint8_t pt = 0;
  uint32_t localCseq = 1, sdpSession = 0, sdpVersion = 0;
} dlg;

String lastInviteResponse;  // for INVITE retransmissions
uint32_t ringStart = 0, okFirstSent = 0, okSentAt = 0, okInterval = 500, callStart = 0;
// Remember the final response of the last ended call for retransmitted INVITEs.
String endedCallId, endedResponse;
uint32_t endedAt = 0;
// BYE retransmission
String byePacket, byeCallId;
int byeTries = 0;
uint32_t byeSentAt = 0;

bool parseSdp(const String &body, IPAddress &ip, uint16_t &port, uint8_t &pt) {
  String sessionAddr, mediaAddr;
  bool inAudio = false, seenAudio = false;
  int chosen = -1;
  port = 0;
  int pos = 0;
  while (pos < (int)body.length()) {
    int eol = body.indexOf('\n', pos);
    if (eol < 0) eol = body.length();
    String line = body.substring(pos, eol);
    pos = eol + 1;
    line.trim();
    if (line.startsWith("m=")) {
      inAudio = !seenAudio && line.startsWith("m=audio ");
      if (!inAudio) continue;
      seenAudio = true;
      // m=audio <port> RTP/AVP <pt> <pt> ...
      int a = 8, b = line.indexOf(' ', a);
      port = line.substring(a, b).toInt();
      int c = line.indexOf(' ', b + 1);
      while (c > 0 && chosen < 0) {
        int d = line.indexOf(' ', c + 1);
        int v = line.substring(c + 1, d < 0 ? line.length() : d).toInt();
        if (v == 0 || v == 8) chosen = v;
        c = d;
      }
    } else if (line.startsWith("c=")) {
      int sp = line.lastIndexOf(' ');
      String addr = line.substring(sp + 1);
      if (inAudio) mediaAddr = addr;
      else if (!seenAudio) sessionAddr = addr;
    }
  }
  if (!seenAudio || port == 0 || chosen < 0) return false;
  pt = chosen;
  return ip.fromString(mediaAddr.length() ? mediaAddr : sessionAddr);
}

String buildSdp() {
  dlg.sdpVersion++;
  String codec = dlg.pt == 8 ? "8 PCMA/8000" : "0 PCMU/8000";
  return "v=0\r\n"
         "o=esp32 " + String(dlg.sdpSession) + " " + String(dlg.sdpVersion) + " IN IP4 " + localIp + "\r\n"
         "s=ESP32 call\r\n"
         "c=IN IP4 " + localIp + "\r\n"
         "t=0 0\r\n"
         "m=audio " + String(cfg.rtpLocalPort) + " RTP/AVP " + String(dlg.pt) + "\r\n"
         "a=rtpmap:" + codec + "\r\n"
         "a=ptime:20\r\n"
         "a=sendrecv\r\n";
}

String buildResponse(const Message &req, int code, const char *reason, const String &toTag,
                     bool withContact = false, const String &sdp = String()) {
  String r = "SIP/2.0 " + String(code) + " " + reason + "\r\n";
  for (auto &h : req.headers) if (h.name == "via") r += "Via: " + h.value + "\r\n";
  if (req.method == "INVITE" && code > 100 && code < 300)
    for (auto &rr : req.getAll("record-route")) r += "Record-Route: " + rr + "\r\n";
  String to = req.get("to");
  if (code > 100 && toTag.length() && headerParam(to, "tag").isEmpty()) to += ";tag=" + toTag;
  r += "From: " + req.get("from") + "\r\n"
       "To: " + to + "\r\n"
       "Call-ID: " + req.get("call-id") + "\r\n"
       "CSeq: " + req.get("cseq") + "\r\n";
  if (withContact) r += "Contact: " + contactUri() + "\r\n";
  r += "Allow: " + String(ALLOW) + "\r\nUser-Agent: " + USER_AGENT + "\r\n";
  if (sdp.length()) r += "Content-Type: application/sdp\r\n";
  r += "Content-Length: " + String(sdp.length()) + "\r\n\r\n" + sdp;
  return r;
}

void reply(const Message &req, IPAddress ip, uint16_t port, int code, const char *reason) {
  sendTo(ip, port, buildResponse(req, code, reason, randomHex(4)));
}

void endCall(const char *why) {
  audio::stopCall();
  audio::setRinging(false);
  if (callState == CALL_ACTIVE || callState == CALL_ANSWERING)
    Serial.printf("[CALL] ended: %s (%lus)\n", why, (unsigned long)((millis() - callStart) / 1000));
  else
    Serial.printf("[CALL] ended: %s\n", why);
  endedCallId = dlg.callId;
  endedResponse = lastInviteResponse;
  endedAt = millis();
  callState = CALL_IDLE;
}

void sendBye() {
  byeCallId = dlg.callId;
  byePacket = "BYE " + dlg.target + " SIP/2.0\r\n" + viaHeader() + "Max-Forwards: 70\r\n";
  for (auto &r : dlg.routes) byePacket += "Route: " + r + "\r\n";
  byePacket += "From: " + dlg.local + "\r\n"
               "To: " + dlg.remote + "\r\n"
               "Call-ID: " + dlg.callId + "\r\n"
               "CSeq: " + String(++dlg.localCseq) + " BYE\r\n"
               "User-Agent: " + String(USER_AGENT) + "\r\n"
               "Content-Length: 0\r\n\r\n";
  sendTo(dlg.srcIp, dlg.srcPort, byePacket);
  byeTries = 1;
  byeSentAt = millis();
}

void handleInvite(const Message &m, IPAddress ip, uint16_t port) {
  String callId = m.get("call-id");
  if (callState != CALL_IDLE && callId == dlg.callId) {
    if (m.get("cseq") == dlg.invite.get("cseq")) {  // retransmission
      if (lastInviteResponse.length()) sendTo(ip, port, lastInviteResponse);
      return;
    }
    if (callState != CALL_ACTIVE) { reply(m, ip, port, 491, "Request Pending"); return; }
    // re-INVITE: hold/resume or media path change.
    IPAddress rip; uint16_t rport; uint8_t pt;
    if (!parseSdp(m.body, rip, rport, pt)) {
      reply(m, ip, port, 488, "Not Acceptable Here");
      return;
    }
    dlg.invite = m;
    dlg.rtpIp = rip; dlg.rtpPort = rport; dlg.pt = pt;
    String contact = m.get("contact");
    if (contact.length()) dlg.target = uriOf(contact);
    lastInviteResponse = buildResponse(m, 200, "OK", dlg.localTag, true, buildSdp());
    sendTo(ip, port, lastInviteResponse);
    audio::startCall(rip, rport, pt);
    Serial.println("[CALL] re-INVITE accepted");
    return;
  }
  if (callState == CALL_IDLE && callId == endedCallId && millis() - endedAt < 32000) {
    if (endedResponse.length()) sendTo(ip, port, endedResponse);
    return;
  }
  if (callState != CALL_IDLE) { reply(m, ip, port, 486, "Busy Here"); return; }

  IPAddress rip; uint16_t rport; uint8_t pt;
  if (!parseSdp(m.body, rip, rport, pt)) {
    Serial.println("[CALL] rejected: offer has no PCMU/PCMA audio");
    reply(m, ip, port, 488, "Not Acceptable Here");
    return;
  }
  dlg = Dialog();
  dlg.invite = m;
  dlg.callId = callId;
  dlg.localTag = randomHex(4);
  dlg.remote = m.get("from");
  dlg.local = m.get("to") + ";tag=" + dlg.localTag;
  String contact = m.get("contact");
  dlg.target = contact.length() ? uriOf(contact) : uriOf(dlg.remote);
  dlg.routes = m.getAll("record-route");
  dlg.srcIp = ip; dlg.srcPort = port;
  dlg.rtpIp = rip; dlg.rtpPort = rport; dlg.pt = pt;
  dlg.sdpSession = esp_random() & 0x7FFFFFFF;

  sendTo(ip, port, buildResponse(m, 100, "Trying", ""));
  lastInviteResponse = buildResponse(m, 180, "Ringing", dlg.localTag, true);
  sendTo(ip, port, lastInviteResponse);
  callState = CALL_RINGING;
  ringStart = millis();
  audio::setRinging(true);
  Serial.printf("[CALL] incoming from %s (%s)\n", uriOf(dlg.remote).c_str(), pt == 8 ? "PCMA" : "PCMU");
  if (cfg.autoAnswerMs >= 0) Serial.printf("[CALL] auto-answer in %d ms\n", (int)cfg.autoAnswerMs);
  else Serial.println("[CALL] press BOOT or send 'a' to answer");
}

void handleRequest(const Message &m, IPAddress ip, uint16_t port) {
  String callId = m.get("call-id");
  bool inDialog = callState != CALL_IDLE && callId == dlg.callId;
  if (m.method == "INVITE") {
    handleInvite(m, ip, port);
  } else if (m.method == "ACK") {
    if (inDialog && callState == CALL_ANSWERING) {
      callState = CALL_ACTIVE;
      Serial.println("[CALL] connected");
    }
  } else if (m.method == "CANCEL") {
    if (inDialog && callState == CALL_RINGING) {
      sendTo(ip, port, buildResponse(m, 200, "OK", dlg.localTag));
      lastInviteResponse = buildResponse(dlg.invite, 487, "Request Terminated", dlg.localTag);
      sendTo(ip, port, lastInviteResponse);
      endCall("caller cancelled");
    } else {
      reply(m, ip, port, 481, "Call/Transaction Does Not Exist");
    }
  } else if (m.method == "BYE") {
    if (inDialog) {
      sendTo(ip, port, buildResponse(m, 200, "OK", dlg.localTag));
      lastInviteResponse = "";
      endCall("remote hung up");
    } else {
      reply(m, ip, port, 481, "Call/Transaction Does Not Exist");
    }
  } else if (m.method == "OPTIONS") {
    String r = buildResponse(m, 200, "OK", randomHex(4), true);
    r.replace("Content-Length: 0", "Accept: application/sdp\r\nContent-Length: 0");
    sendTo(ip, port, r);
  } else if (m.method == "NOTIFY") {
    reply(m, ip, port, 200, "OK");
  } else {
    reply(m, ip, port, 501, "Not Implemented");
  }
}

void handleResponse(const Message &m) {
  String method = m.cseqMethod(), callId = m.get("call-id");
  if (method == "REGISTER" && callId == regCallId) handleRegisterResponse(m);
  else if (method == "BYE" && callId == byeCallId && m.status >= 200) byeTries = 0;
}

void callTimers() {
  if (callState == CALL_RINGING && cfg.autoAnswerMs >= 0 && millis() - ringStart >= (uint32_t)cfg.autoAnswerMs) {
    sip::answer();
  } else if (callState == CALL_ANSWERING && due(okSentAt + okInterval)) {
    if (millis() - okFirstSent > 32000) {  // RFC 3261 timer H: no ACK
      sendBye();
      endCall("no ACK received");
      return;
    }
    sendTo(dlg.srcIp, dlg.srcPort, lastInviteResponse);
    okSentAt = millis();
    okInterval = min<uint32_t>(okInterval * 2, 4000);
  }
  if (byeTries > 0 && due(byeSentAt + 500u * byeTries)) {
    if (byeTries >= 6) { byeTries = 0; return; }
    sendTo(dlg.srcIp, dlg.srcPort, byePacket);
    byeTries++;
    byeSentAt = millis();
  }
}

void onNetworkDown() {
  if (callState != CALL_IDLE) endCall("Wi-Fi lost");
  udp.stop();
  started = false;
  isRegistered = false;
  regState = REG_IDLE;
  regLastError = "Wi-Fi down";
}

bool onNetworkUp() {
  localIp = WiFi.localIP().toString();
  if (!WiFi.hostByName(cfg.sipServer.c_str(), serverIp)) {
    regLastError = "cannot resolve " + cfg.sipServer;
    return false;
  }
  if (!udp.begin(cfg.sipLocalPort)) {
    regLastError = "cannot open UDP " + String(cfg.sipLocalPort);
    return false;
  }
  regCallId = randomHex(10) + "@" + localIp;
  regFromTag = randomHex(4);
  regCseq = 0;
  regExpires = cfg.sipExpires;
  started = true;
  Serial.printf("[SIP] local %s:%u, server %s:%u\n", localIp.c_str(), (unsigned)cfg.sipLocalPort,
                serverIp.toString().c_str(), (unsigned)cfg.sipServerPort);
  startRegistration();
  return true;
}

char rxBuf[4096];

}  // namespace

namespace sip {

void loop() {
  static uint32_t retryAt = 0;
  if (!settings::configured()) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (started) onNetworkDown();
    return;
  }
  if (!started) {
    if (!due(retryAt)) return;
    if (!onNetworkUp()) {
      Serial.printf("[SIP] %s\n", regLastError.c_str());
      retryAt = millis() + 5000;
      return;
    }
  }
  int size;
  while ((size = udp.parsePacket()) > 0) {
    int n = udp.read((uint8_t *)rxBuf, sizeof(rxBuf) - 1);
    if (n <= 0) continue;
    rxBuf[n] = 0;
    Message m;
    if (!parseMessage(rxBuf, m)) continue;
    if (m.isRequest) handleRequest(m, udp.remoteIP(), udp.remotePort());
    else handleResponse(m);
  }
  registrationTimers();
  callTimers();
}

void answer() {
  if (callState != CALL_RINGING) return;
  lastInviteResponse = buildResponse(dlg.invite, 200, "OK", dlg.localTag, true, buildSdp());
  sendTo(dlg.srcIp, dlg.srcPort, lastInviteResponse);
  okFirstSent = okSentAt = callStart = millis();
  okInterval = 500;
  audio::setRinging(false);
  audio::startCall(dlg.rtpIp, dlg.rtpPort, dlg.pt);
  callState = CALL_ANSWERING;
  Serial.println("[CALL] answered");
}

void hangup() {
  if (callState == CALL_RINGING) {
    lastInviteResponse = buildResponse(dlg.invite, 603, "Decline", dlg.localTag);
    sendTo(dlg.srcIp, dlg.srcPort, lastInviteResponse);
    endCall("declined");
  } else if (callState == CALL_ANSWERING || callState == CALL_ACTIVE) {
    sendBye();
    lastInviteResponse = "";
    endCall("local hang-up");
  }
}

void button() {
  if (callState == CALL_RINGING) answer();
  else hangup();
}

void reRegister() {
  if (started && regState != REG_SENDING) startRegistration();
}

bool registered() { return isRegistered; }
String lastError() { return regLastError; }
const char *callStateName() { return STATE_NAMES[callState]; }

void printStatus() {
  audio::Stats a = audio::stats();
  Serial.printf("[STATUS] Wi-Fi %s %s | SIP %s%s%s | call %s\n",
                WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.localIP().toString().c_str(),
                isRegistered ? "registered" : "not registered", regLastError.length() ? ": " : "",
                regLastError.c_str(), STATE_NAMES[callState]);
  Serial.printf("[STATUS] RTP %s tx=%lu rx=%lu lost=%lu late=%lu underruns=%lu jitter=%lums | mic peak=%d gain=%d | vol=%d%%\n",
                a.active ? "on" : "off", (unsigned long)a.txPackets, (unsigned long)a.rxPackets,
                (unsigned long)a.rxLost, (unsigned long)a.rxLate, (unsigned long)a.underruns,
                (unsigned long)a.bufferedMs, a.micPeak, audio::micGain(), audio::volume());
}

}  // namespace sip
