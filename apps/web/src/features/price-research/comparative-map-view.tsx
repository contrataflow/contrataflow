'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { COMPARATIVE_MAP_MESSAGES } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { isApiError } from '@/lib/api/api-error';
import { formatCivilDate, formatDateTime } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { ComparativeMapExportMenu } from './comparative-map-export-menu';
import { ComparativeMapGrid, formatPrice } from './comparative-map-grid';
import { useComparativeMap } from './comparative-map.api';
import { priceResearchHref, usePriceResearch } from './price-research.api';

/**
 * SCR-010 — Mapa comparativo (`/processos/[id]/pesquisa-precos/[researchId]/mapa`, US-031): a matriz
 * itens × fontes do PRS-21 em modo leitura, com "calculado em" (RN-PRICE-57 — o mapa reflete o
 * último recálculo, nunca um retrato próprio), o total estimado e o menu de exportação (XLSX/PDF).
 * Sob POL-09 os valores chegam `null` da API e a tela mostra "Sigiloso" (a UI nunca decide a regra).
 * Estados: skeleton da matriz, vazio sem fontes (FA-04), erro com `correlationId` e 404 com o caminho
 * de volta à lista de processos.
 */
export function ComparativeMapView({
  processId,
  researchId,
}: {
  readonly processId: string;
  readonly researchId: string;
}) {
  const t = useTranslations('priceResearch.map');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const map = useComparativeMap(researchId);
  // Limiares de destaque para o tooltip dos selos (opcional: sem eles o selo só explica o motivo).
  const research = usePriceResearch(researchId);
  const back = (
    <Link
      href={priceResearchHref(processId, researchId)}
      className="text-sm text-primary underline"
    >
      {t('back')}
    </Link>
  );

  if (map.data === undefined) {
    if (map.isPending) {
      return (
        <div role="status" className="mx-auto flex w-full max-w-7xl flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-72 w-full" />
        </div>
      );
    }
    const error = map.error;
    const notFound = isApiError(error) && error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
        {notFound ? (
          <Link href="/processos" className="text-sm text-primary underline">
            {t('backToProcesses')}
          </Link>
        ) : (
          back
        )}
        <Alert tone="error" title={notFound ? COMPARATIVE_MAP_MESSAGES.notFound : t('loadError')}>
          {notFound ? null : (
            <>
              {isApiError(error) && error.correlationId !== null ? (
                <p className="text-xs break-all text-muted-foreground">
                  {t('export.correlationId', { id: error.correlationId })}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  void map.refetch();
                }}
              >
                {t('retry')}
              </Button>
            </>
          )}
        </Alert>
      </div>
    );
  }

  const data = map.data;
  const parameters = research.data?.research.parameters ?? null;
  return (
    <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        {back}
        <h1 className="text-2xl font-semibold">{t('title', { code: data.code ?? data.title })}</h1>
        <p className="text-sm text-muted-foreground">
          {t('referenceDate', { date: formatCivilDate(data.referenceDate) })}
          {' · '}
          {data.lastCalculatedAt === null
            ? t('notCalculatedYet')
            : t('calculatedAt', { when: formatDateTime(data.lastCalculatedAt, timeZone) })}
        </p>
        <p className="text-sm">
          {t('total')}{' '}
          <strong>
            {data.masked
              ? t('masked')
              : data.totalEstimatedValue === null
                ? t('notCalculated')
                : formatPrice(data.totalEstimatedValue, 2)}
          </strong>
        </p>
        {data.masked ? <p className="text-sm text-muted-foreground">{t('maskedHint')}</p> : null}
      </div>
      <ComparativeMapExportMenu researchId={researchId} code={data.code} />
      {data.sources.length === 0 ? (
        <Alert tone="info" title={COMPARATIVE_MAP_MESSAGES.noSources} />
      ) : null}
      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noItems')}</p>
      ) : (
        <ComparativeMapGrid map={data} parameters={parameters} />
      )}
    </div>
  );
}
