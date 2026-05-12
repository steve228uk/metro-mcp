import { useEffect, useRef } from 'preact/hooks';

export function useKeyboard(handlers: Record<string, () => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const handler = ref.current[e.key];
      if (handler) { e.preventDefault(); handler(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
