'use client';

import { Button, Skeleton } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { formatMoney } from '@/lib/i18n/format';
import { Can } from '@/lib/permissions/can';
import { useShellSession } from '@/lib/session/session-context';

import { ExampleForm } from './example-form';
import { exampleKeys, fetchItems, fetchPing } from './example.api';

/**
 * Corpo da página de exemplo: consome no cliente o que o servidor pré-carregou
 * (`HydrationBoundary`), pagina pela API e protege a criação com `<Can>`.
 */
export function ExampleView() {
  const t = useTranslations('example');
  const { activeTenant } = useShellSession();
  const [page, setPage] = useState(1);

  const ping = useQuery({
    queryKey: exampleKeys.ping(activeTenant.id),
    queryFn: ({ signal }) => fetchPing(signal),
  });
  const items = useQuery({
    queryKey: exampleKeys.items(activeTenant.id, page),
    queryFn: ({ signal }) => fetchItems(page, signal),
  });
  const meta = items.data?.meta as { totalItems?: number; totalPages?: number } | undefined;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section
        aria-labelledby="example-context"
        className="rounded-card border border-border bg-surface p-4 shadow-card"
      >
        <h2 id="example-context" className="text-lg font-semibold">
          {t('context.heading')}
        </h2>
        {ping.data ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('context.tenant')}</dt>
            <dd>{activeTenant.name}</dd>
            <dt className="text-muted-foreground">{t('context.correlation')}</dt>
            <dd className="font-mono break-all">{ping.data.data.correlationId}</dd>
          </dl>
        ) : (
          <div role="status" className="mt-3 flex flex-col gap-2">
            <span className="sr-only">{t('context.loading')}</span>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          {t('money', { value: formatMoney('1234567.89') })}
        </p>
      </section>

      <section
        aria-labelledby="example-items"
        className="rounded-card border border-border bg-surface p-4 shadow-card"
      >
        <h2 id="example-items" className="text-lg font-semibold">
          {t('items.heading')}
        </h2>
        {items.data ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
              {t('items.summary', {
                total: meta?.totalItems ?? items.data.data.length,
                page,
                pages: totalPages,
              })}
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              {items.data.data.map((item) => (
                <li key={item.id} className="rounded-control bg-muted px-2 py-1 font-mono">
                  {item.id}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Skeleton className="mt-3 h-24" />
        )}
        <div className="mt-4 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage((current) => current - 1);
            }}
          >
            ‹<span className="sr-only">Página anterior</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              setPage((current) => current + 1);
            }}
          >
            ›<span className="sr-only">Próxima página</span>
          </Button>
        </div>
      </section>

      <section
        aria-label={t('form.heading')}
        className="rounded-card border border-border bg-surface p-4 shadow-card lg:col-span-2"
      >
        <Can permission="PROCESS_CREATE">
          <ExampleForm />
        </Can>
      </section>
    </div>
  );
}
