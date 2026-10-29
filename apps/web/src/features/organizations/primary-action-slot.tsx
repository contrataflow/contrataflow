'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lugar da ação primária da aba (prd-5 · regra 1). Na página `/admin/estrutura` o cabeçalho é do
 * `StructureView`, que entrega o elemento do cabeçalho em `slot`: a ação da aba ativa aparece lá,
 * sem repetir na aba. `undefined` = a aba foi renderizada sozinha (testes, outras telas) e a ação
 * fica acima do conteúdo; `null` = o cabeçalho ainda não montou.
 */
export type PrimaryActionSlot = HTMLElement | null | undefined;

export function PrimaryAction({
  slot,
  children,
}: {
  readonly slot: PrimaryActionSlot;
  readonly children: ReactNode;
}) {
  if (slot === undefined) return <div className="flex justify-end empty:hidden">{children}</div>;
  if (slot === null) return null;
  return createPortal(children, slot);
}
