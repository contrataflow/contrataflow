import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { RootDocument } from '@/components/root-document';

import './globals.css';

export const metadata: Metadata = {
  title: 'ContrataFlow',
  description: 'Planejamento das contratações públicas (Lei 14.133/2021).',
};

/** Cor da barra do navegador: navy da marca (DEC-185). Ícones em `icon.svg` e `apple-icon.png`. */
export const viewport: Viewport = {
  themeColor: '#141E2B',
};

/** Layout raiz: sem cache e com nonce da CSP por requisição (RN-FND-88/94). */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Renderização dinâmica obrigatória: o nonce da CSP é gerado a cada requisição no `proxy.ts`.
  await connection();
  return <RootDocument>{children}</RootDocument>;
}
