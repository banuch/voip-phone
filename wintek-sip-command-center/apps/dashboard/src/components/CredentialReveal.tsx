import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { SipCredential } from '@/types/api';

/**
 * Shows a freshly issued SIP password exactly once. Nothing is cached:
 * closing the dialog discards it, and the API can never return it again.
 */
export function CredentialReveal({ cred, onClose, notice }: { cred: SipCredential | null; onClose: () => void; notice?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (k: string, v: string) => {
    await navigator.clipboard?.writeText(v).catch(() => undefined);
    setCopied(k);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <Dialog open={!!cred} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="SIP credentials — shown once" description={notice ?? 'Enter these in the intercom with the Wintek setup app (Bluetooth). They cannot be displayed again; rotate to issue new ones.'}>
        {cred && (
          <div className="space-y-2">
            {[
              ['Server / domain', cred.domain],
              ['Extension / user', cred.sipUsername],
              ['Password', cred.sipPassword],
              ['Realm', cred.realm],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 rounded-md border bg-surface px-3 py-2">
                <div className="w-32 text-xs text-muted">{k}</div>
                <div className="flex-1 select-all font-mono text-sm">{v}</div>
                <Button variant="ghost" size="icon-sm" onClick={() => copy(k!, v!)} aria-label={`Copy ${k}`}>
                  {copied === k ? <Check className="text-success" /> : <Copy />}
                </Button>
              </div>
            ))}
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" /> Only a hash is stored on the server. Treat this password like a key to the intercom.
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={onClose}><KeyRound /> I have provisioned the device</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
