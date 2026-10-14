import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { getTranslations } from 'next-intl/server';

import { apiServerClient, currentShellSession } from '@/bff/server-session';
import { ExampleView } from '@/features/_example/example-view';
import { examplePaths, exampleKeys, itemsQuery } from '@/features/_example/example.api';
import type { InternalItem, InternalPing } from '@/features/_example/example.api';
import { makeServerQueryClient } from '@/lib/query/query-client';

export const dynamic = 'force-dynamic';

/**
 * Página de exemplo do shell (US-086): o Server Component faz o prefetch via `apiServerClient`
 * e entrega o cache hidratado (RN-FND-88). Falhas no prefetch não derrubam o servidor: a consulta
 * é refeita no cliente e, se falhar de novo, cai no `error.tsx` com o `ApiError` completo.
 */
export default async function ExamplePage() {
  const t = await getTranslations('example');
  const session = await currentShellSession();
  const queryClient = makeServerQueryClient();
  const tenantId = session?.activeTenant?.id;
  if (tenantId) {
    // Falha no prefetch é engolida: só consultas bem-sucedidas são desidratadas.
    await Promise.all([
      queryClient
        .query({
          queryKey: exampleKeys.ping(tenantId),
          queryFn: () => apiServerClient.get<InternalPing>(examplePaths.ping),
        })
        .catch(() => undefined),
      queryClient
        .query({
          queryKey: exampleKeys.items(tenantId, 1),
          queryFn: () =>
            apiServerClient.get<InternalItem[]>(examplePaths.items, { query: itemsQuery(1) }),
        })
        .catch(() => undefined),
    ]);
  }
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <ExampleView />
      </HydrationBoundary>
    </div>
  );
}
