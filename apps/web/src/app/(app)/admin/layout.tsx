import type { ReactNode } from 'react';

/**
 * `(app)/admin` (architecture.md §8.2): as áreas de administração são os subitens do grupo
 * "Administração" do menu lateral (prd-6 · §2.2); a página monta a própria trilha pelo
 * `AppPageHeader section="admin"`.
 */
export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}
