#include "ota.h"
#include "settings.h"
#include "sip.h"
#include "version.h"
#include <WiFi.h>
#include <WebServer.h>
#include <Update.h>
#include <esp_ota_ops.h>

// Keep a freshly updated image in "pending verify" past boot, so loop() can
// decide once Wi-Fi is up. Overrides the weak default in the Arduino core.
extern "C" bool verifyRollbackLater() { return true; }

namespace {

const char *USER = "admin";
constexpr uint32_t VERIFY_STABLE_MS = 30000;   // Wi-Fi up this long = image is good
constexpr uint32_t VERIFY_TIMEOUT_MS = 180000; // no Wi-Fi by then = roll back

WebServer server(80);
bool serverUp = false;
bool pendingVerify = false;
uint32_t wifiSince = 0, rebootAt = 0;

// State of the current POST /update, filled by the upload callback.
int upCode = 0;          // 0 = no file seen yet, 200 = ok, else HTTP error
String upMsg;
size_t upExpected = 0, upDone = 0;
int upLastPct = -1;

const char UPDATE_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIP phone update</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
progress{width:100%;height:1.2rem}button{font-size:1rem;padding:.5rem 1rem}#msg{margin-top:1rem}</style>
</head><body>
<h1>Firmware update</h1>
<p>Running <b>%FW%</b>. Choose <code>release/ESP32S3_SipPhone.ino.bin</code>.</p>
<form id="f"><input type="file" id="file" accept=".bin" required> <button>Upload</button></form>
<p><progress id="bar" max="100" value="0"></progress></p>
<div id="msg"></div>
<p><a href="/">Status</a></p>
<script>
const msg = t => document.getElementById('msg').textContent = t;
document.getElementById('f').onsubmit = e => {
  e.preventDefault();
  const file = document.getElementById('file').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('firmware', file, file.name);
  const x = new XMLHttpRequest();
  x.open('POST', '/update');
  x.upload.onprogress = p => { if (p.lengthComputable) document.getElementById('bar').value = 100 * p.loaded / p.total; };
  x.onload = () => {
    msg(x.responseText);
    if (x.status === 200) setTimeout(function wait() {
      fetch('/', {cache: 'no-store'}).then(() => location.href = '/').catch(() => setTimeout(wait, 2000));
    }, 8000);
  };
  x.onerror = () => msg('Upload failed: connection lost');
  msg('Uploading... keep this page open.');
  x.send(fd);
};
</script></body></html>)HTML";

String runningSlot() {
  const esp_partition_t *p = esp_ota_get_running_partition();
  return p ? String(p->label) : String("?");
}

bool callIdle() { return strcmp(sip::callStateName(), "idle") == 0; }

void handleStatus() {
  String s = "<!doctype html><html><head><meta charset=\"utf-8\">"
             "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>SIP phone</title>"
             "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}"
             "td{padding:.2rem 1rem .2rem 0}</style></head><body><h1>SIP phone</h1><table>";
  auto row = [&](const char *k, const String &v) { s += "<tr><td>" + String(k) + "</td><td>" + v + "</td></tr>"; };
  row("Firmware", FW_VERSION);
  row("Slot", runningSlot() + (pendingVerify ? " (new, checking)" : ""));
  row("Uptime", String(millis() / 1000) + " s");
  row("Wi-Fi RSSI", String(WiFi.RSSI()) + " dBm");
  row("SIP", sip::registered() ? "registered" : "not registered");
  row("Call", sip::callStateName());
  s += "</table><p>";
  s += ota::enabled() ? "<a href=\"/update\">Update firmware</a>"
                      : "Firmware updates are off: set an update password in the setup app.";
  s += "</p></body></html>";
  server.send(200, "text/html", s);
}

// Shared checks for GET and the start of POST. Returns 0 when allowed.
int checkAccess(String &why) {
  if (!ota::enabled()) { why = "Updates are off: set an update password over Bluetooth first."; return 403; }
  if (!server.authenticate(USER, settings::cfg.otaPassword.c_str())) { why = "Wrong user or password."; return 401; }
  return 0;
}

void sendError(int code, const String &why) {
  if (code == 401) server.requestAuthentication(BASIC_AUTH, "SIP phone", why);
  else server.send(code, "text/plain", why);
}

void handleUpdatePage() {
  String why;
  int code = checkAccess(why);
  if (code) { sendError(code, why); return; }
  String page = FPSTR(UPDATE_PAGE);
  page.replace("%FW%", FW_VERSION);
  server.send(200, "text/html", page);
}

void fail(int code, const String &why) {
  if (Update.isRunning()) Update.abort();
  upCode = code;
  upMsg = why;
  Serial.printf("[OTA] failed: %s\n", why.c_str());
}

void handleUpload() {
  HTTPUpload &u = server.upload();
  switch (u.status) {
    case UPLOAD_FILE_START: {
      upCode = 200;
      upMsg = "";
      upDone = 0;
      upLastPct = -1;
      upExpected = server.clientContentLength();  // whole multipart body, close enough
      String why;
      int code = checkAccess(why);
      if (code) { upCode = code; upMsg = why; return; }
      if (!callIdle()) { fail(409, "A call is in progress: hang up and try again."); return; }
      Serial.printf("[OTA] receiving %s (%u bytes) into the other slot\n", u.filename.c_str(), (unsigned)upExpected);
      if (!Update.begin(UPDATE_SIZE_UNKNOWN)) fail(500, String("Cannot start update: ") + Update.errorString());
      break;
    }
    case UPLOAD_FILE_WRITE:
      if (upCode != 200) return;
      // Update checks the ESP image magic byte on the first chunk.
      if (Update.write(u.buf, u.currentSize) != u.currentSize) {
        fail(400, String("Write failed: ") + Update.errorString());
        return;
      }
      upDone += u.currentSize;
      if (upExpected) {
        int pct = min(100, int(upDone * 100 / upExpected)) / 10 * 10;
        if (pct != upLastPct) { upLastPct = pct; Serial.printf("[OTA] %d%%\n", pct); }
      }
      break;
    case UPLOAD_FILE_END:
      if (upCode != 200) return;
      if (!Update.end(true)) fail(400, String("Image rejected: ") + Update.errorString());
      else {
        upMsg = "Update OK (" + String(u.totalSize) + " bytes). Restarting; this page reloads when the phone is back.";
        Serial.printf("[OTA] done, %u bytes, restarting\n", (unsigned)u.totalSize);
      }
      break;
    case UPLOAD_FILE_ABORTED:
      fail(400, "Upload aborted");
      break;
  }
}

void handleUpdatePost() {
  if (upCode == 0) {  // no file part (or no body)
    String why;
    int code = checkAccess(why);
    sendError(code ? code : 400, code ? why : String("No firmware file in the request."));
    return;
  }
  int code = upCode;
  upCode = 0;
  if (code != 200) { sendError(code, upMsg); return; }
  server.sendHeader("Connection", "close");
  server.send(200, "text/plain", upMsg);
  rebootAt = millis() + 1000;
}

void startServer() {
  server.on("/", HTTP_GET, handleStatus);
  server.on("/update", HTTP_GET, handleUpdatePage);
  server.on("/update", HTTP_POST, handleUpdatePost, handleUpload);
  server.onNotFound([] { server.send(404, "text/plain", "Not found"); });
  server.begin();
  serverUp = true;
  Serial.printf("[OTA] web server on http://%s/%s\n", WiFi.localIP().toString().c_str(),
                ota::enabled() ? "update" : " (updates off: no update password)");
}

void markValid(const char *why) {
  esp_ota_mark_app_valid_cancel_rollback();
  pendingVerify = false;
  Serial.printf("[OTA] new firmware %s marked good (%s)\n", FW_VERSION, why);
}

// Decide whether a freshly updated image is good, see ota.h.
void checkRollback(bool wifiUp) {
  if (!pendingVerify) return;
  uint32_t now = millis();
  if (settings::cfg.wifiSsid.isEmpty()) {
    if (now >= VERIFY_STABLE_MS) markValid("no Wi-Fi configured");
    return;
  }
  if (wifiUp) {
    if (!wifiSince) wifiSince = now ? now : 1;
    if (now - wifiSince >= VERIFY_STABLE_MS) markValid("Wi-Fi up 30 s");
    return;
  }
  wifiSince = 0;
  if (now >= VERIFY_TIMEOUT_MS) {
    Serial.println("[OTA] new firmware never got Wi-Fi: rolling back to the previous version");
    Serial.flush();
    esp_ota_mark_app_invalid_rollback_and_reboot();  // returns only if there is no other image
    markValid("rollback impossible");
  }
}

}  // namespace

namespace ota {

bool enabled() { return settings::cfg.otaPassword.length() > 0; }

String url() {
  if (!serverUp || !enabled() || WiFi.status() != WL_CONNECTED) return String();
  return "http://" + WiFi.localIP().toString() + "/update";
}

void begin() {
  Serial.printf("Firmware %s, slot %s\n", FW_VERSION, runningSlot().c_str());
  esp_ota_img_states_t st;
  const esp_partition_t *running = esp_ota_get_running_partition();
  pendingVerify = running && esp_ota_get_state_partition(running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
  if (pendingVerify) Serial.println("[OTA] first boot after an update: checking Wi-Fi before keeping it");
}

void loop() {
  if (rebootAt && int32_t(millis() - rebootAt) >= 0) {
    Serial.flush();
    ESP.restart();
  }
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  checkRollback(wifiUp);
  if (!serverUp && wifiUp) startServer();
  if (serverUp) server.handleClient();
}

void printStatus() {
  Serial.printf("[OTA] firmware %s, slot %s%s, updates %s%s%s\n", FW_VERSION, runningSlot().c_str(),
                pendingVerify ? " (pending check)" : "", enabled() ? "on " : "off (no update password)",
                enabled() ? "at " : "", url().c_str());
}

}  // namespace ota
