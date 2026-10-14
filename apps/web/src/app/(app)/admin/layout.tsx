import type { ReactNode } from 'react';

import { AdminNav } from '@/components/shell/main-nav';

/** `(app)/admin`: shell + navegação de administração (architecture.md §8.2). */
export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <AdminNav />
      {children}
    </div>
  );
}
