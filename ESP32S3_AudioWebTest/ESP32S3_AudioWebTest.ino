// Arduino-ESP32 3.3.12, ESP32-S3 with PSRAM enabled. No external libraries.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <ESP_I2S.h>
#include <esp_heap_caps.h>

const char *WIFI_SSID = "sarath office";
const char *WIFI_PASSWORD = "sarath143";
constexpr int BCLK_PIN = 4, WS_PIN = 5, MIC_PIN = 6, SPEAKER_PIN = 7;
constexpr uint32_t RATE = 16000, MAX_DATA = RATE * 2 * 10;
constexpr size_t MAX_UPLOAD = MAX_DATA + 4096;
constexpr int MIC_GAIN = 4; // Reduce if clipping; increase if quiet.
WebServer server(80);
I2SClass audio;
File sound, uploadFile;
enum Mode { IDLE, RECORDING, PLAYING, MONITORING };
Mode mode = IDLE;
String message = "Ready", uploadError;
bool audioReady = false, fsReady = false, uploading = false;
// Recording and playback are exclusive, so one PSRAM buffer serves both.
uint8_t *audioBuffer = nullptr;
uint32_t playbackPosition = 0;
uint32_t recorded = 0, remaining = 0, recordLimit = MAX_DATA;
uint32_t uploadBytes = 0, discardFrames = 0;
int volumePercent = 25, peak = 0;

const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 audio bench</title><style>
body{font:16px system-ui;background:#101827;color:#e5edf8;max-width:720px;margin:40px auto;padding:0 20px}h1{font-size:28px}section{background:#1d293d;padding:22px;border-radius:16px;margin:18px 0}button,a{display:inline-block;margin:8px 5px 0 0;padding:12px;border-radius:9px;border:0;background:#67dfc4;color:#102522;cursor:pointer}button:disabled{opacity:.4;cursor:default}input{max-width:100%}small{color:#b5c4db}#error{color:#ffb5b5;white-space:pre-wrap}progress{width:100%}
</style><h1>ESP32 audio bench</h1><p>INMP441 microphone · MAX98357A speaker</p>
<section><b id="state">Connecting…</b><p id="status"></p><p id="memory"></p><small>Microphone peak</small><progress id="peak" max="32768" value="0"></progress><p id="error" role="alert"></p></section>
<section><h2>1. Speaker test</h2><p><small>WAV only: 16 kHz, mono, 16-bit PCM, up to 10 seconds.</small></p><input id="file" type="file" accept=".wav,audio/wav"><br><button id="upload" onclick="upload()">Upload WAV</button><button id="playUpload" onclick="act('/play?source=upload')">Play uploaded file</button></section>
<section><h2>2. Microphone test</h2><label>Seconds <input id="seconds" type="number" min="1" max="10" value="10"></label><br><button id="record" onclick="act('/record?seconds='+document.getElementById('seconds').value)">Record microphone</button><button id="playRecord" onclick="act('/play?source=record')">Play recording</button><a id="download" href="/recording.wav" download>Download recording</a><p><small>Records the ESP32 microphone. Speaker playback is separate.</small></p></section>
<section><label>Speaker volume <input id="volume" type="range" min="0" max="100" value="25"> <span id="vol">25%</span></label><br><button id="stop" onclick="act('/stop')">Stop</button></section>
<script>
let working=false;
async function request(url,options){const r=await fetch(url,options);if(!r.ok)throw Error(await r.text());return r;}
async function act(url){try{document.getElementById('error').textContent='';await request(url,{method:'POST'});await refresh();}catch(e){document.getElementById('error').textContent=e.message;}}
async function upload(){const f=document.getElementById('file').files[0];if(!f)return;working=true;document.getElementById('upload').disabled=true;try{const data=new FormData();data.append('audio',f);await request('/upload',{method:'POST',body:data});document.getElementById('error').textContent='';}catch(e){document.getElementById('error').textContent=e.message;}finally{working=false;await refresh();}}
async function refresh(){try{const s=await(await request('/status')).json();document.getElementById('state').textContent=s.mode;document.getElementById('status').textContent=s.message+' · '+s.seconds.toFixed(1)+' s recorded';document.getElementById('peak').value=s.peak;document.getElementById('memory').textContent='PSRAM: '+(s.psramBytes/1048576).toFixed(1)+' MB � Audio buffer: '+Math.round(s.bufferBytes/1024)+' KiB';const busy=s.mode!=='Idle'||working||!s.ready;for(const id of ['upload','record'])document.getElementById(id).disabled=busy;document.getElementById('playUpload').disabled=busy||!s.upload;document.getElementById('playRecord').disabled=busy||!s.record;document.getElementById('download').hidden=busy||!s.record;document.getElementById('stop').disabled=s.mode==='Idle';}catch(e){document.getElementById('state').textContent='Connection lost';}}
document.getElementById('volume').oninput=e=>document.getElementById('vol').textContent=e.target.value+'%';
document.getElementById('volume').onchange=e=>act('/volume?value='+e.target.value);
setInterval(refresh,700);refresh();
</script></html>)HTML";

void put16(uint8_t *p, uint16_t x) { p[0]=x; p[1]=x>>8; }
void put32(uint8_t *p, uint32_t x) { for(int i=0;i<4;i++) p[i]=x>>(8*i); }
uint16_t get16(const uint8_t *p) { return uint16_t(p[0]) | uint16_t(p[1])<<8; }
uint32_t get32(const uint8_t *p) { return uint32_t(p[0]) | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24; }
bool writeHeader(File &f, uint32_t bytes) {
  uint8_t h[44]={0};
  memcpy(h,"RIFF",4); put32(h+4,36+bytes); memcpy(h+8,"WAVEfmt ",8);
  put32(h+16,16); put16(h+20,1); put16(h+22,1); put32(h+24,RATE);
  put32(h+28,RATE*2); put16(h+32,2); put16(h+34,16);
  memcpy(h+36,"data",4); put32(h+40,bytes);
  return f.seek(0) && f.write(h,44)==44;
}

// Walk RIFF chunks rather than assuming every WAV has a 44-byte header.
bool inspectWav(File &f, uint32_t &offset, uint32_t &length) {
  uint8_t h[24]; bool fmt=false, data=false; uint32_t end=0;
  if(!f || f.size()<44 || !f.seek(0) || f.read(h,12)!=12 || memcmp(h,"RIFF",4) || memcmp(h+8,"WAVE",4)) return false;
  uint32_t riff=get32(h+4);
  if(riff<36 || uint64_t(riff)+8>f.size()) return false;
  end=riff+8;
  while(f.position()+8<=end) {
    if(f.read(h,8)!=8) return false;
    uint32_t n=get32(h+4), start=f.position();
    if(uint64_t(start)+n>end) return false;
    if(!memcmp(h,"fmt ",4)) {
      if(n<16 || f.read(h+8,16)!=16) return false;
      if(get16(h+8)!=1 || get16(h+10)!=1 || get32(h+12)!=RATE || get32(h+16)!=RATE*2 || get16(h+20)!=2 || get16(h+22)!=16) return false;
      fmt=true;
    } else if(!memcmp(h,"data",4)) {
      if(data || !n || n>MAX_DATA || (n&1)) return false;
      offset=start; length=n; data=true;
    }
    uint64_t next=uint64_t(start)+n+(n&1);
    if(next>end || !f.seek(uint32_t(next))) return false;
  }
  return fmt && data && f.seek(offset);
}

// ---------- Microphone debug (Serial Monitor, 115200 baud) ----------
// Collects raw 32-bit slot statistics for BOTH channels so you can tell:
//  - all zeros on both   -> no data on SD (GPIO6), no clocks, or mic unpowered
//  - all 0xFFFFFFFF      -> SD line floating/stuck high
//  - data only on Right  -> INMP441 L/R pin is high/floating (should be GND)
//  - timeouts > 0        -> I2S read returned nothing (driver/clock problem)
struct MicDebug {
  uint32_t reads, timeouts, oddReads, bytes, frames;
  uint32_t zeroL, zeroR, onesL, onesR;
  int32_t minL, maxL, minR, maxR, lastL, lastR;
  uint32_t lastPrint, started;
} dbg;
void dbgResetWindow() {
  dbg.frames=dbg.zeroL=dbg.zeroR=dbg.onesL=dbg.onesR=0;
  dbg.minL=dbg.minR=INT32_MAX; dbg.maxL=dbg.maxR=INT32_MIN;
  dbg.lastL=dbg.lastR=0;
}
void dbgReset() {
  memset(&dbg,0,sizeof(dbg));
  dbgResetWindow();
  dbg.lastPrint=dbg.started=millis();
}
void dbgAccumulate(const int32_t *raw,size_t frames) {
  for(size_t i=0;i<frames;i++) {
    int32_t l=raw[i*2], r=raw[i*2+1];
    if(l==0) dbg.zeroL++;
    if(r==0) dbg.zeroR++;
    if(l==-1) dbg.onesL++;
    if(r==-1) dbg.onesR++;
    dbg.minL=min(dbg.minL,l); dbg.maxL=max(dbg.maxL,l);
    dbg.minR=min(dbg.minR,r); dbg.maxR=max(dbg.maxR,r);
    dbg.lastL=l; dbg.lastR=r;
  }
  dbg.frames+=frames;
}
// Prints at most every 500 ms (or immediately when force=true).
void dbgPrint(const char *tag,bool force=false) {
  if(!force && millis()-dbg.lastPrint<500) return;
  dbg.lastPrint=millis();
  Serial.printf("[%s] t=%lums reads=%lu timeouts=%lu odd=%lu totalBytes=%lu windowFrames=%lu\n",
    tag,(unsigned long)(millis()-dbg.started),(unsigned long)dbg.reads,(unsigned long)dbg.timeouts,
    (unsigned long)dbg.oddReads,(unsigned long)dbg.bytes,(unsigned long)dbg.frames);
  if(dbg.frames) {
    Serial.printf("   L: min=%ld max=%ld last=0x%08lX (>>16=%d) zeros=%lu ones=%lu\n",
      (long)dbg.minL,(long)dbg.maxL,(unsigned long)dbg.lastL,(int)(dbg.lastL>>16),(unsigned long)dbg.zeroL,(unsigned long)dbg.onesL);
    Serial.printf("   R: min=%ld max=%ld last=0x%08lX (>>16=%d) zeros=%lu ones=%lu\n",
      (long)dbg.minR,(long)dbg.maxR,(unsigned long)dbg.lastR,(int)(dbg.lastR>>16),(unsigned long)dbg.zeroR,(unsigned long)dbg.onesR);
    Serial.printf("   peak16=%d recorded=%lu bytes\n",peak,(unsigned long)recorded);
    if(dbg.zeroL==dbg.frames && dbg.zeroR==dbg.frames) Serial.println("   !! Both channels all zero: check SD->GPIO6, SCK->GPIO4, WS->GPIO5, mic 3V3/GND");
    else if(dbg.onesL==dbg.frames && dbg.onesR==dbg.frames) Serial.println("   !! All 0xFFFFFFFF: SD line floating or stuck high");
    else if(dbg.zeroL==dbg.frames) Serial.println("   !! Signal on RIGHT only: tie INMP441 L/R to GND (code reads LEFT)");
  }
  dbgResetWindow();
}
// Read one block from the mic and update debug stats. Returns bytes read.
size_t micRead(int32_t *raw,size_t size) {
  size_t n=audio.readBytes((char*)raw,size);
  dbg.reads++; dbg.bytes+=n;
  if(!n) dbg.timeouts++;
  else if(n%8) dbg.oddReads++;
  if(n>=8) dbgAccumulate(raw,n/8);
  return n;
}

bool beginAudio(bool rx) {
  audio.setPins(BCLK_PIN,WS_PIN,rx ? -1 : SPEAKER_PIN,rx ? MIC_PIN : -1);
  // 32-bit stereo wire slots keep the INMP441's 24-bit signal intact.
  audioReady=audio.begin(I2S_MODE_STD,RATE,I2S_DATA_BIT_WIDTH_32BIT,I2S_SLOT_MODE_STEREO);
  Serial.printf("[I2S] begin %s: BCLK=%d WS=%d %s=%d rate=%lu 32bit stereo -> %s\n",
    rx ? "RX(mic)" : "TX(spk)",BCLK_PIN,WS_PIN,rx ? "DIN" : "DOUT",rx ? MIC_PIN : SPEAKER_PIN,
    (unsigned long)RATE,audioReady ? "OK" : "FAILED");
  return audioReady;
}
void finish(const String &why) {
  bool wasRecording=mode==RECORDING;
  bool headerOk=true;
  audio.end(); audioReady=false;
  if(sound) sound.close();
  // Save only after I2S stops: flash writes cannot stall active capture.
  // Use a temporary file so a failed save preserves the previous recording.
  if(wasRecording && recorded) {
    File saved=LittleFS.open("/capture.wav","w");
    headerOk=saved && writeHeader(saved,recorded);
    for(uint32_t pos=0; headerOk && pos<recorded;) {
      size_t count=min(uint32_t(4096),recorded-pos);
      headerOk=saved.write(audioBuffer+pos,count)==count;
      pos+=count; yield();
    }
    saved.close();
    if(headerOk) headerOk=LittleFS.rename("/capture.wav","/record.wav");
    if(!headerOk) LittleFS.remove("/capture.wav");
  }
  if(wasRecording || mode==MONITORING) dbgPrint(wasRecording ? "REC" : "MON",true);
  Serial.printf("[AUDIO] finish: %s (recorded=%lu bytes, save %s)\n",why.c_str(),(unsigned long)recorded,headerOk ? "ok" : "FAILED");
  mode=IDLE; message=headerOk ? why : "Failed to finalize recording"; peak=0;
}
void replyError(int code,const String &s) { server.send(code,"text/plain",s); }
bool busy() {
  if(!audioBuffer) { replyError(503,"PSRAM unavailable. Enable the correct PSRAM type in Tools and reboot."); return true; }
  if(!fsReady) { replyError(503,"LittleFS not mounted. See Serial Monitor."); return true; }
  if(mode!=IDLE || uploading) { replyError(409,"Stop the current operation first."); return true; }
  return false;
}
void recordStart() {
  if(busy()) return;
  int seconds=server.arg("seconds").toInt();
  if(seconds<1 || seconds>10) { replyError(400,"Recording duration must be 1 to 10 seconds."); return; }
  if(LittleFS.totalBytes()-LittleFS.usedBytes()<MAX_DATA+8192) { replyError(507,"Insufficient flash space for recording save"); return; }
  if(!beginAudio(true)) { replyError(500,"I2S microphone initialization failed"); return; }
  recorded=0;
  recordLimit=seconds*RATE*2; discardFrames=RATE/10; // Flush startup transient.
  mode=RECORDING; peak=0; message="Recording microphone";
  dbgReset();
  Serial.printf("[REC] start %d s, limit=%lu bytes, gain=%d\n",seconds,(unsigned long)recordLimit,MIC_GAIN);
  server.send(200,"text/plain","Recording started");
}
void playStart() {
  if(busy()) return;
  String source=server.arg("source");
  if(source!="record" && source!="upload") { replyError(400,"Unknown source"); return; }
  sound=LittleFS.open(source=="record" ? "/record.wav" : "/upload.wav","r");
  uint32_t offset=0;
  if(!inspectWav(sound,offset,remaining)) { if(sound) sound.close(); replyError(400,"Missing or invalid WAV file"); return; }
  // Prefetch the validated PCM payload into PSRAM before enabling I2S.
  uint32_t loaded=0;
  while(loaded<remaining) {
    size_t count=min(uint32_t(4096),remaining-loaded);
    if(sound.read(audioBuffer+loaded,count)!=count) { sound.close(); replyError(500,"Cannot load WAV into PSRAM"); return; }
    loaded+=count; yield();
  }
  sound.close(); playbackPosition=0;
  if(!beginAudio(false)) { replyError(500,"I2S speaker initialization failed"); return; }
  mode=PLAYING; message="Playing on ESP32 speaker";
  server.send(200,"text/plain","Playback started");
}
void audioStep() {
  if(mode==RECORDING) {
    int32_t raw[256]; int16_t pcm[128];
    size_t n=micRead(raw,sizeof(raw));
    if(!n || n%8) { Serial.printf("[REC] bad read: n=%u\n",(unsigned)n); finish("Microphone read failed"); return; }
    size_t count=0; peak=0;
    for(size_t i=0;i<n/8;i++) {
      if(discardFrames) { --discardFrames; continue; }
      if(recorded+count*2>=recordLimit) break;
      // Left channel; the INMP441 has its valid bits at the top of the slot.
      int64_t value=int64_t(raw[i*2]>>16)*MIC_GAIN;
      int16_t sample=(int16_t)constrain(value,int64_t(-32768),int64_t(32767));
      pcm[count++]=sample; peak=max(peak,abs(int(sample)));
    }
    size_t bytes=count*2;
    if(bytes) memcpy(audioBuffer+recorded,pcm,bytes);
    recorded+=bytes;
    dbgPrint("REC");
    if(recorded>=recordLimit) finish("Recording ready");
  } else if(mode==MONITORING) {
    // Live mic monitor from Serial: read and print stats, store nothing.
    int32_t raw[256];
    size_t n=micRead(raw,sizeof(raw));
    peak=0;
    for(size_t i=0;i<n/8;i++) {
      int64_t v=int64_t(raw[i*2]>>16)*MIC_GAIN;
      peak=max(peak,abs(int(constrain(v,int64_t(-32768),int64_t(32767)))));
    }
    dbgPrint("MON");
  } else if(mode==PLAYING) {
    int16_t pcm[128]; int32_t stereo[256];
    size_t want=min(uint32_t(sizeof(pcm)),remaining);
    size_t n=want;
    memcpy(pcm,audioBuffer+playbackPosition,n);
    playbackPosition+=n;
    for(size_t i=0;i<n/2;i++) {
      int32_t value=(int32_t(pcm[i])*volumePercent/100)*65536;
      stereo[2*i]=value; stereo[2*i+1]=value;
    }
    size_t bytes=n*4;
    if(audio.write((uint8_t*)stereo,bytes)!=bytes) { finish("Speaker write failed"); return; }
    remaining-=n;
    if(!remaining) {
      // Clock silence through the DMA queue before disabling TX, preserving the tail.
      memset(stereo,0,sizeof(stereo));
      for(int i=0;i<24;i++) audio.write((uint8_t*)stereo,sizeof(stereo));
      finish("Playback finished");
    }
  }
}

void uploadChunk() {
  HTTPUpload &u=server.upload();
  if(u.status==UPLOAD_FILE_START) {
    uploadError=""; uploadBytes=0;
    if(uploading || mode!=IDLE || !fsReady) { uploadError="Device busy or filesystem unavailable"; return; }
    uploading=true;
    if(LittleFS.totalBytes()-LittleFS.usedBytes()<MAX_UPLOAD+8192) { uploadError="Insufficient free flash space"; return; }
    uploadFile=LittleFS.open("/incoming.wav","w");
    if(!uploadFile) uploadError="Cannot create upload file";
  } else if(u.status==UPLOAD_FILE_WRITE && uploadError.isEmpty()) {
    if(!uploading || !uploadFile || u.currentSize>MAX_UPLOAD-uploadBytes) { uploadError="Upload exceeds 10-second WAV size limit"; return; }
    if(uploadFile.write(u.buf,u.currentSize)!=u.currentSize) uploadError="Flash write failed";
    uploadBytes+=u.currentSize;
  } else if(u.status==UPLOAD_FILE_END || u.status==UPLOAD_FILE_ABORTED) {
    if(uploadFile) uploadFile.close();
    if(u.status==UPLOAD_FILE_ABORTED) uploadError="Upload interrupted";
    if(uploading && uploadError.isEmpty()) {
      File f=LittleFS.open("/incoming.wav","r"); uint32_t offset=0,length=0;
      bool valid=inspectWav(f,offset,length); f.close();
      if(!valid) uploadError="Use PCM WAV: 16 kHz, mono, 16-bit, maximum 10 seconds";
      else {
        LittleFS.remove("/upload.wav");
        if(!LittleFS.rename("/incoming.wav","/upload.wav")) uploadError="Cannot save uploaded WAV";
      }
    }
    if(uploading) LittleFS.remove("/incoming.wav");
    uploading=false;
  }
}

void setup() {
  Serial.begin(115200); delay(1000);
  // First use formats only the selected LittleFS partition if it cannot mount.
  fsReady=LittleFS.begin(true);
  if(fsReady) { LittleFS.remove("/incoming.wav"); LittleFS.remove("/capture.wav"); Serial.printf("LittleFS: %u bytes total\n",(unsigned)LittleFS.totalBytes()); }
  else message="LittleFS mount failed: choose a partition with filesystem space";
  if(psramFound()) audioBuffer=(uint8_t*)heap_caps_malloc(MAX_DATA,MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  Serial.printf("PSRAM total: %u bytes; audio buffer: %u bytes\n",(unsigned)ESP.getPsramSize(),audioBuffer ? (unsigned)MAX_DATA : 0);
  if(!audioBuffer) message="PSRAM unavailable: enable correct PSRAM type in Arduino Tools";
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  Serial.println("Joining Wi-Fi (2.4 GHz). Waiting for DHCP…");
  Serial.println("Serial debug: 'm' = toggle live mic monitor, 'p' = probe SD pin, 'h' = help");
  server.on("/",HTTP_GET,[]{server.send_P(200,"text/html",PAGE);});
  server.on("/status",HTTP_GET,[]{
    String state=uploading ? "Uploading" : mode==RECORDING ? "Recording" : mode==PLAYING ? "Playing" : mode==MONITORING ? "Monitoring" : "Idle";
    String json="{\"mode\":\""+state+"\",\"message\":\""+message+"\",\"seconds\":"+String(recorded/32000.0,2)+",\"peak\":"+String(peak)+",\"ready\":"+(fsReady && audioBuffer?"true":"false")+",\"upload\":"+(fsReady && LittleFS.exists("/upload.wav")?"true":"false")+",\"record\":"+(fsReady && LittleFS.exists("/record.wav")?"true":"false")+"}";
    json.remove(json.length()-1);
    json+=",\"psramBytes\":"+String(ESP.getPsramSize())+",\"bufferBytes\":"+String(audioBuffer ? MAX_DATA : 0)+"}";
    server.sendHeader("Cache-Control","no-store"); server.send(200,"application/json",json);
  });
  server.on("/record",HTTP_POST,recordStart);
  server.on("/play",HTTP_POST,playStart);
  server.on("/stop",HTTP_POST,[]{if(mode!=IDLE) finish("Stopped"); server.send(200,"text/plain","Stopped");});
  server.on("/volume",HTTP_POST,[]{volumePercent=constrain(server.arg("value").toInt(),0,100);server.send(200,"text/plain","Volume updated");});
  server.on("/upload",HTTP_POST,[]{
    if(uploading) { if(uploadFile) uploadFile.close(); LittleFS.remove("/incoming.wav"); uploading=false; uploadError="Incomplete upload"; }
    if(!uploadError.isEmpty()) replyError(400,uploadError);
    else if(!uploadBytes) replyError(400,"No audio file received");
    else {message="WAV uploaded";server.send(200,"text/plain","WAV uploaded");}
  },uploadChunk);
  server.on("/recording.wav",HTTP_GET,[]{
    if(busy()) return;
    File f=LittleFS.open("/record.wav","r");
    if(!f) {replyError(404,"Record audio first");return;}
    server.sendHeader("Content-Disposition","attachment; filename=recording.wav");
    server.streamFile(f,"audio/wav"); f.close();
  });
  server.onNotFound([]{replyError(404,"Not found");});
  server.begin();
}
void loop() {
  static uint32_t lastCheck=0; static bool connected=false;
  if(millis()-lastCheck>1000) {
    lastCheck=millis(); bool now=WiFi.status()==WL_CONNECTED;
    if(now && !connected) {Serial.print("Open http://"); Serial.println(WiFi.localIP());}
    connected=now;
  }
  // Serial commands: 'm' toggles live mic monitor, 'p' probes the SD pin, 'h' help.
  while(Serial.available()) {
    char c=Serial.read();
    if(c=='m') {
      if(mode==MONITORING) finish("Monitor stopped");
      else if(mode!=IDLE || uploading) Serial.println("[MON] busy; stop current operation first");
      else if(beginAudio(true)) { dbgReset(); recorded=0; peak=0; mode=MONITORING; message="Mic monitor (serial)"; Serial.println("[MON] started; send 'm' to stop"); }
    } else if(c=='p') {
      if(mode!=IDLE) { Serial.println("[PIN] stop audio first"); continue; }
      // With I2S stopped the mic has no clock, so its SD output should be tri-stated.
      pinMode(MIC_PIN,INPUT_PULLUP); delay(2); int up=digitalRead(MIC_PIN);
      pinMode(MIC_PIN,INPUT_PULLDOWN); delay(2); int down=digitalRead(MIC_PIN);
      pinMode(MIC_PIN,INPUT);
      Serial.printf("[PIN] GPIO%d pullup=%d pulldown=%d -> %s\n",MIC_PIN,up,down,
        up==1&&down==0 ? "tri-state (normal when idle)" : up==0&&down==0 ? "held LOW (short to GND?)" : up==1&&down==1 ? "held HIGH (short to 3V3?)" : "odd");
    } else if(c=='h' || c=='?') {
      Serial.println("Commands: m = toggle mic monitor, p = probe SD pin, h = help");
    }
  }
  server.handleClient(); audioStep(); delay(1);
}
