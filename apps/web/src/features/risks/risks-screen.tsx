'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import { RiskList } from './risk-list';
import { fetchProcess, processKeys } from '../processes/processes.api';

/**
 * SCR-011 — Riscos (`/processos/[id]/riscos`, US-033): cabeçalho com o processo e a seção "Lista de
 * riscos". A aba "Matriz" e o Mapa de Riscos chegam com a US-035.
 */
export function RisksScreen({ processId }: { readonly processId: string }) {
  const t = useTranslations('risks');
  const session = useShellSession();
  const sectionId = useId();
  const detail = useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {detail.data === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('processLine', {
              code: detail.data.code ?? t('draftCode'),
              title: detail.data.title,
            })}
          </p>
        )}
      </div>
      <section aria-labelledby={sectionId} className="flex min-w-0 flex-col gap-3">
        <h2 id={sectionId} className="text-lg font-semibold">
          {t('listSection')}
        </h2>
        <RiskList processId={processId} />
      </section>
    </div>
  );
}
