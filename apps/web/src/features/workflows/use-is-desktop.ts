'use client';

import { useEffect, useState } from 'react';

/**
 * Abaixo de 768 px o painel lateral vira modal e o diagrama abre ajustado, sem minimapa (SCR-034 ·
 * acessibilidade e responsividade).
 */
export function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [desktop, setDesktop] = useState(() => !supported || window.matchMedia(query).matches);
  useEffect(() => {
    if (!supported) return undefined;
    const media = window.matchMedia(query);
    const onChange = () => {
      setDesktop(media.matches);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [supported]);
  return desktop;
}
