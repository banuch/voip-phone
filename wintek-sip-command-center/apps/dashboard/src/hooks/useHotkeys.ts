import { useEffect } from 'react';

/** Global shortcuts, ignored while typing in a field. Keys like "/", "Escape", "alt+h". */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const key = `${e.altKey ? 'alt+' : ''}${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.shiftKey && e.key.length > 1 ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const fn = map[key];
      if (!fn || (typing && !key.startsWith('alt+') && key !== 'escape')) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [map, enabled]);
}
