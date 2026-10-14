'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Foco gerenciado após navegação client-side (RN-FND-96): leva o foco ao conteúdo principal para
 * o leitor de tela anunciar a nova página. A primeira renderização mantém o foco do browser.
 */
export function RouteFocus({ targetId }: { readonly targetId: string }) {
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    document.getElementById(targetId)?.focus();
  }, [pathname, targetId]);
  return null;
}
