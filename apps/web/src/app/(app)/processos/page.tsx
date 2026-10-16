import { Suspense } from 'react';

import { ProcessListPage } from '@/features/process-list/process-list-page';

/**
 * SCR-004 — Processos (US-002): lista com busca, filtros, atalhos e ordenação; o estado da
 * consulta fica na URL (`useSearchParams` — por isso o `Suspense`).
 */
export default function ProcessesRoutePage() {
  return (
    <Suspense>
      <ProcessListPage />
    </Suspense>
  );
}
