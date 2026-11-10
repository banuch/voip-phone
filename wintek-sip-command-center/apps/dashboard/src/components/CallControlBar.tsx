import { Mic, MicOff, PhoneOff, Settings2, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label, Select } from '@/components/ui/input';
import { Slider, Tooltip } from '@/components/ui/misc';
import { listAudioDevices, supportsOutputSelection } from '@/services/sip/phone';
import { useConsole } from '@/stores/console';
import { cn } from '@/lib/utils';

export function useAudioDevices() {
  const [d, setD] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({ inputs: [], outputs: [] });
  useEffect(() => {
    const load = () => void listAudioDevices().then(setD).catch(() => undefined);
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, []);
  return d;
}

export function DeviceSelectors({ compact }: { compact?: boolean }) {
  const { prefs, setMic, setSpeaker } = useConsole();
  const { inputs, outputs } = useAudioDevices();
  const outputOk = supportsOutputSelection();
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'sm:grid-cols-2')}>
      <div className="space-y-1">
        <Label htmlFor="mic">Microphone</Label>
        <Select id="mic" className="w-full" value={prefs.micId ?? ''} onChange={(e) => void setMic(e.target.value)}>
          <option value="">System default</option>
          {inputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="spk">Speaker {outputOk ? '' : '(not supported by this browser)'}</Label>
        <Select id="spk" className="w-full" disabled={!outputOk} value={prefs.speakerId ?? ''} onChange={(e) => void setSpeaker(e.target.value)}>
          <option value="">System default</option>
          {outputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** Mute / volume / devices / hang up. Keyboard: M toggles mute, Alt+H hangs up (see AppShell). */
export function CallControlBar({ onHangup, canHangup, inCall }: { onHangup: () => void; canHangup: boolean; inCall: boolean }) {
  const { muted, setMuted, prefs, setVolume } = useConsole();
  const [showDevices, setShowDevices] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Tooltip content={muted ? 'Unmute microphone (M)' : 'Mute microphone (M)'}>
          <Button variant={muted ? 'warning' : 'secondary'} size="icon" onClick={() => setMuted(!muted)} disabled={!inCall} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff /> : <Mic />}
          </Button>
        </Tooltip>
        <div className="flex flex-1 items-center gap-2 px-1">
          <Volume2 className="size-4 shrink-0 text-muted" aria-hidden />
          <Slider aria-label="Speaker volume" value={[Math.round(prefs.volume * 100)]} max={100} step={5} onValueChange={([v]) => setVolume((v ?? 90) / 100)} />
          <span className="num w-9 text-right text-xs text-muted">{Math.round(prefs.volume * 100)}%</span>
        </div>
        <Tooltip content="Audio devices">
          <Button variant="ghost" size="icon" onClick={() => setShowDevices((s) => !s)} aria-expanded={showDevices} aria-label="Audio devices">
            <Settings2 />
          </Button>
        </Tooltip>
        <Tooltip content="Hang up (Alt+H)">
          <Button variant="danger" onClick={onHangup} disabled={!canHangup} className="min-w-28">
            <PhoneOff /> Hang up
          </Button>
        </Tooltip>
      </div>
      {showDevices && <DeviceSelectors compact />}
    </div>
  );
}
