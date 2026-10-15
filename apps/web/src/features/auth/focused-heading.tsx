'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

/**
 * `h1` que recebe o foco ao montar (padrão de SCR-001): em páginas de transição sem formulário,
 * quem usa leitor de tela ouve o contexto antes da ação.
 */
export function FocusedHeading({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}
