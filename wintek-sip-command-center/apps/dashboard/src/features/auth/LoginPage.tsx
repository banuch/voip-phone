import { Loader2, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { isMock } from '@/services/api';
import { useSession } from '@/stores/session';

export function LoginPage() {
  const login = useSession((s) => s.login);
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(u.trim(), p);
    } catch (e: any) {
      setErr(e.message ?? 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid-bg grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <svg viewBox="0 0 32 32" className="size-10" aria-hidden><rect width="32" height="32" rx="7" fill="hsl(var(--elevated))" /><path d="M6 9l4.2 14h1.6L16 12.5 20.2 23h1.6L26 9h-2.6l-2.7 9.6L17 9h-2l-3.7 9.6L8.6 9z" fill="hsl(var(--primary))" /></svg>
          <div>
            <div className="text-lg font-semibold tracking-wide">Wintek SIP Command Center</div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted">ATM intercom operations</div>
          </div>
        </div>
        <form onSubmit={submit} className="panel space-y-4 p-6 shadow-2xl">
          <div className="space-y-1.5"><Label htmlFor="u">Username</Label><Input id="u" autoComplete="username" autoFocus value={u} onChange={(e) => setU(e.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor="p">Password</Label><Input id="p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></div>
          {err && <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Lock />} Sign in</Button>
          {isMock && <p className="text-xs text-muted">Demo mode: sign in as <code>operator1</code>, <code>supervisor</code>, <code>orgadmin</code>, <code>superadmin</code> or <code>auditor</code> with any password.</p>}
        </form>
        <p className="mt-6 text-center text-xs text-subtle">Authorized personnel only. All actions are recorded in the audit log.</p>
      </div>
    </div>
  );
}
