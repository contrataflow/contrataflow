'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type { AiUsageDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { aiKeys, fetchAiUsage } from './ai.api';

/** Meses oferecidos no seletor: o corrente e os 11 anteriores. */
const MONTHS_BACK = 12;

/** `YYYY-MM` de `month` deslocado `delta` meses. */
export function shiftMonth(month: string, delta: number): string {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly generations: number;
  readonly totalTokens: number;
  readonly costUsd?: string | null;
}

/**
 * `AiUsageCard` (US-116 · AI-06): consumo do mês do órgão — barra de uso com o percentual em texto
 * (sem depender só de cor), tokens usados/reservados, custo estimado e as divisões por tipo de
 * documento, tipo de geração e usuário (tabelas que viram listas abaixo de 768 px), com o seletor
 * de mês e o link para a auditoria das ações de IA.
 */
export function AiUsageCard() {
  const t = useTranslations('ai.admin.usage');
  const format = useFormatter();
  const tenantId = useTenantId();
  const selectId = useId();
  const [month, setMonth] = useState<string | null>(null);
  const usage = useQuery({
    queryKey: aiKeys.usage(tenantId, month),
    queryFn: ({ signal }) => fetchAiUsage(month, signal),
  });
  // O mês corrente vem do servidor (fuso do tenant): a primeira resposta sem `month`.
  const [currentMonth, setCurrentMonth] = useState<string | null>(null);
  if (currentMonth === null && month === null && usage.data) setCurrentMonth(usage.data.month);

  const number = (value: number) => format.number(value);

  return (
    <section
      aria-labelledby={`${selectId}-title`}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={`${selectId}-title`} className="text-lg font-semibold">
          {t('title')}
        </h2>
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium">
            {t('month')}
          </label>
          <select
            id={selectId}
            className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
            disabled={currentMonth === null}
            value={month ?? currentMonth ?? ''}
            onChange={(event) => {
              setMonth(event.target.value === currentMonth ? null : event.target.value);
            }}
          >
            {currentMonth === null ? <option value="">—</option> : null}
            {currentMonth === null
              ? null
              : Array.from({ length: MONTHS_BACK }, (_, index) =>
                  shiftMonth(currentMonth, -index),
                ).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
          </select>
        </div>
      </div>

      {usage.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {usage.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void usage.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {usage.data ? <UsageBody usage={usage.data} number={number} /> : null}

      <Link href="/auditoria?action=ai.*" className="text-sm font-medium text-primary underline">
        {t('audit')}
      </Link>
    </section>
  );
}

function UsageBody({
  usage,
  number,
}: {
  readonly usage: AiUsageDto;
  readonly number: (value: number) => string;
}) {
  const t = useTranslations('ai.admin.usage');
  const percent =
    usage.limitTokens > 0 ? Math.round((usage.usedTokens / usage.limitTokens) * 1000) / 10 : 100;
  const label = t('percent', { percent: String(percent).replace('.', ',') });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent, 100)}
          aria-valuetext={label}
          aria-label={label}
          className="h-3 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full ${percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${String(Math.min(percent, 100))}%` }}
          />
        </div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">
          {t('tokens', { used: number(usage.usedTokens), limit: number(usage.limitTokens) })}
        </p>
        {usage.reservedTokens > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('reserved', { reserved: number(usage.reservedTokens) })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {usage.costUsd === null ? t('costUnknown') : t('cost', { cost: usage.costUsd })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('generations', { count: usage.generations.total })}
        </p>
      </div>

      {usage.generations.total === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <Breakdown
            title={t('byDocumentType')}
            withCost
            rows={usage.byDocumentType.map((row) => ({
              key: row.targetModule,
              label: t(`targets.${row.targetModule}`),
              generations: row.generations,
              totalTokens: row.totalTokens,
              costUsd: row.costUsd,
            }))}
            number={number}
          />
          <Breakdown
            title={t('byKind')}
            rows={usage.byKind.map((row) => ({
              key: `${row.kind}-${row.action ?? ''}`,
              label: t(`kinds.${row.action ?? row.kind}`),
              generations: row.generations,
              totalTokens: row.totalTokens,
            }))}
            number={number}
          />
          <Breakdown
            title={t('byUser')}
            rows={usage.byUser.map((row) => ({
              key: row.userId,
              label: row.name,
              generations: row.generations,
              totalTokens: row.totalTokens,
            }))}
            number={number}
          />
        </>
      )}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  number,
  withCost = false,
}: {
  readonly title: string;
  readonly rows: readonly BreakdownRow[];
  readonly number: (value: number) => string;
  readonly withCost?: boolean;
}) {
  const t = useTranslations('ai.admin.usage');
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <table className="hidden w-full text-left text-sm md:table">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-1 font-medium">
              {t('columns.item')}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t('columns.generations')}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t('columns.tokens')}
            </th>
            {withCost ? (
              <th scope="col" className="py-1 text-right font-medium">
                {t('columns.cost')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border">
              <th scope="row" className="py-1 font-normal">
                {row.label}
              </th>
              <td className="py-1 text-right">{number(row.generations)}</td>
              <td className="py-1 text-right">{number(row.totalTokens)}</td>
              {withCost ? <td className="py-1 text-right">{row.costUsd ?? '—'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.key} className="rounded-control border border-border p-2 text-sm">
            <p className="font-medium">{row.label}</p>
            <p className="text-muted-foreground">
              {`${t('columns.generations')}: ${number(row.generations)} · ${t('columns.tokens')}: ${number(row.totalTokens)}`}
              {withCost ? ` · ${t('columns.cost')}: ${row.costUsd ?? '—'}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
