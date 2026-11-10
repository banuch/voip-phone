import { create } from 'zustand';
import type { Permission } from '@wintek/shared';
import { dataService } from '@/services/api';
import type { SessionUser } from '@/types/api';

type Status = 'unknown' | 'signedOut' | 'signedIn';

interface SessionState {
  status: Status;
  user: SessionUser | null;
  /** Try to resume from the httpOnly refresh cookie (page reload). */
  bootstrap: () => Promise<void>;
  login: (u: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (p: Permission | string) => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'unknown',
  user: null,
  bootstrap: async () => {
    try {
      const s = await dataService.refresh();
      set({ status: 'signedIn', user: s.user });
    } catch {
      set({ status: 'signedOut', user: null });
    }
  },
  login: async (u, p) => {
    const s = await dataService.login(u, p);
    set({ status: 'signedIn', user: s.user });
  },
  logout: async () => {
    await dataService.logout();
    set({ status: 'signedOut', user: null });
  },
  can: (p) => !!get().user?.permissions.includes(p),
}));

// Lost refresh token (expired/revoked elsewhere) -> back to sign-in.
if ('onSessionLost' in dataService) {
  (dataService as unknown as { onSessionLost: () => void }).onSessionLost = () => useSession.setState({ status: 'signedOut', user: null });
}
