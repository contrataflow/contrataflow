'use client';

import { useRef } from 'react';

/**
 * Devolução de foco dos diálogos controlados: sem `DialogTrigger`, o Radix não devolve o foco a
 * quem abriu (`onCloseAutoFocus` só foca o gatilho). `remember` guarda o elemento focado quando o
 * diálogo abre (chame em `onOpenAutoFocus`, antes de mover o foco) e `restore` o refoca ao fechar.
 * Quem controla o foco por fora (ex.: o botão saiu da tela) passa o seu `onCloseAutoFocus`.
 */
export function useReturnFocus(onCloseAutoFocus?: (event: Event) => void) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    },
    restore: (event: Event) => {
      event.preventDefault();
      if (onCloseAutoFocus) {
        onCloseAutoFocus(event);
        return;
      }
      const target = opener.current;
      if (target?.isConnected) target.focus();
    },
  };
}
