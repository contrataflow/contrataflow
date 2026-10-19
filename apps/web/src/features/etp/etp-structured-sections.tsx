'use client';

import { Button, Skeleton } from '@contrataflow/ui';
import type { EtpStructuredKind } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useDocumentItems } from '../dfd/dfd.api';
import { LevelBadge } from '../risks/level-badge';
import { useRisks } from '../risks/risks.api';

/*
 * Quadros estruturados somente leitura das seções do ETP (US-020 · RN-ETP-12): itens/quantidades
 * (`ItemsTableReadonly` — DOC-06), alternativas (`AlternativesTableReadonly` — o cadastro e o
 * ETP-05 são da US-021) e riscos do processo (`RiskListReadonly` — RSK-01). Só leitura: a edição
 * desse conteúdo acontece nas telas donas, com link quando ela existe.
 */

const formatQuantity = (value: string) =>
  Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

function LoadError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('etp.editor');
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      <span>{message}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

export function ItemsTableReadonly({
  processId,
  documentId,
}: {
  readonly processId: string;
  readonly documentId: string;
}) {
  const t = useTranslations('etp.editor.structured.ITEMS');
  const items = useDocumentItems(documentId);
  if (items.isPending) return <Skeleton className="h-24 w-full" />;
  if (items.isError) {
    return (
      <LoadError
        message={t('loadError')}
        onRetry={() => {
          void items.refetch();
        }}
      />
    );
  }
  const rows = items.data.items;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 text-left text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('sequence')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('description')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('unit')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('quantity')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.processItemId} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3">{row.sequence}</td>
                  <td className="py-2 pr-3 break-words">{row.description}</td>
                  <td className="py-2 pr-3">{row.unit.label}</td>
                  <td className="py-2 text-right tabular-nums">{formatQuantity(row.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
        {t('manage')}
      </Link>
    </div>
  );
}

/** Sem o cadastro de alternativas (US-021), o quadro mostra o estado vazio da SCR-008. */
export function AlternativesTableReadonly() {
  const t = useTranslations('etp.editor.structured.ALTERNATIVES');
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">{t('empty')}</p>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
    </div>
  );
}

export function RiskListReadonly({ processId }: { readonly processId: string }) {
  const t = useTranslations('etp.editor.structured.RISKS');
  const risks = useRisks(processId);
  if (risks.isPending) return <Skeleton className="h-24 w-full" />;
  if (risks.isError) {
    return (
      <LoadError
        message={t('loadError')}
        onRetry={() => {
          void risks.refetch();
        }}
      />
    );
  }
  const rows = risks.data.risks;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul aria-label={t('caption')} className="flex flex-col gap-2">
          {rows.map((risk) => (
            <li
              key={risk.id}
              className="flex flex-wrap items-center gap-2 rounded-control border border-border p-2 text-sm"
            >
              <span className="font-medium">{risk.code}</span>
              <span className="min-w-0 flex-1 break-words">{risk.title}</span>
              <LevelBadge level={risk.level} score={risk.score} />
            </li>
          ))}
        </ul>
      )}
      <Link href={`/processos/${processId}/riscos`} className="text-sm text-primary underline">
        {t('manage')}
      </Link>
    </div>
  );
}

export function StructuredSectionContent({
  kind,
  processId,
  documentId,
}: {
  readonly kind: EtpStructuredKind;
  readonly processId: string;
  readonly documentId: string;
}) {
  const t = useTranslations('etp.editor.structured');
  return (
    <section
      aria-label={t(`${kind}.title`)}
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-muted/40 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(`${kind}.title`)}</h3>
        <span className="text-xs text-muted-foreground">{t('readOnly')}</span>
      </div>
      {kind === 'ITEMS' ? (
        <ItemsTableReadonly processId={processId} documentId={documentId} />
      ) : null}
      {kind === 'ALTERNATIVES' ? <AlternativesTableReadonly /> : null}
      {kind === 'RISKS' ? <RiskListReadonly processId={processId} /> : null}
    </section>
  );
}
