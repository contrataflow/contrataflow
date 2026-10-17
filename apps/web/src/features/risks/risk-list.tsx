'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { RISK_MESSAGES, RISK_PHASE_LABELS, RISK_STATUS_LABELS } from '@contrataflow/validation';
import type { RiskDto, RiskListMetaDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { DeleteRiskDialog } from './delete-risk-dialog';
import { LevelBadge } from './level-badge';
import { RiskFormDrawer } from './risk-form-drawer';
import { lockStateOf, ownerLabelOf } from './risks-model';
import type { RiskLockState } from './risks-model';
import { useRisks } from './risks.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

type FormTarget = { readonly mode: 'add' } | { readonly mode: 'edit'; readonly riskId: string };

/** Uma linha (cartão abaixo de 768 px) com a avaliação, o responsável e as ações. */
function RiskRow({
  risk,
  meta,
  lock,
  noticeId,
  expanded,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly risk: RiskDto;
  readonly meta: RiskListMetaDto;
  readonly lock: RiskLockState;
  readonly noticeId: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('risks');
  const detailsId = useId();
  const owner = ownerLabelOf(risk);
  const otherScale = risk.scaleSnapshot.scale.max !== meta.scale.max;
  const describedBy = lock.disabled && lock.reason !== null ? noticeId : undefined;
  return (
    <>
      <tr className="flex flex-col gap-2 border-b border-border p-3 md:table-row md:p-0">
        <td className="block font-medium md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.code')}: </span>
          {risk.code}
        </td>
        <td className="block min-w-0 md:table-cell md:px-3 md:py-2">
          <span className="block font-medium break-words">{risk.title}</span>
          <span className="block text-xs text-muted-foreground">
            {risk.category.label} · {RISK_PHASE_LABELS[risk.phase]}
          </span>
          <button
            type="button"
            className="mt-1 text-xs text-primary underline"
            aria-label={
              expanded
                ? t('actions.hideDetailsFor', { code: risk.code })
                : t('actions.showDetailsFor', { code: risk.code })
            }
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggle}
          >
            {expanded ? t('actions.hideDetails') : t('actions.showDetails')}
          </button>
        </td>
        <td className="block text-sm md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.assessment')}: </span>
          <span className="inline-flex flex-wrap items-center gap-1">
            <LevelBadge level={risk.level} score={risk.score} />
            <span className="text-xs text-muted-foreground">
              {t('assessment.formula', { probability: risk.probability, impact: risk.impact })}
            </span>
          </span>
          {risk.residualLevel !== null && risk.residualScore !== null ? (
            <span className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              {t('assessment.residual')}
              <LevelBadge level={risk.residualLevel} score={risk.residualScore} />
            </span>
          ) : null}
        </td>
        <td className="block text-sm md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.owner')}: </span>
          {owner.missing ? (
            <span className="rounded-control bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
              {owner.text}
            </span>
          ) : (
            owner.text
          )}
        </td>
        <td className="block text-sm md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.status')}: </span>
          {RISK_STATUS_LABELS[risk.status]}
        </td>
        {lock.showActions ? (
          <td className="block md:table-cell md:px-3 md:py-2">
            <div
              role="group"
              aria-label={t('actions.riskActions', { code: risk.code })}
              className="flex flex-wrap gap-1"
            >
              <Button
                size="sm"
                variant="secondary"
                disabled={lock.disabled}
                aria-label={t('actions.editRisk', { code: risk.code })}
                aria-describedby={describedBy}
                onClick={onEdit}
              >
                {t('actions.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={lock.disabled}
                aria-label={t('actions.removeRisk', { code: risk.code })}
                aria-describedby={describedBy}
                onClick={onRemove}
              >
                {t('actions.remove')}
              </Button>
            </div>
          </td>
        ) : null}
      </tr>
      {expanded ? (
        <tr
          id={detailsId}
          className="block border-b border-border bg-muted/40 p-3 md:table-row md:p-0"
        >
          <td colSpan={lock.showActions ? 6 : 5} className="block md:table-cell md:px-3 md:py-3">
            <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              {risk.description !== null ? (
                <div className="md:col-span-2">
                  <dt className="font-medium">{t('details.description')}</dt>
                  <dd className="break-words text-muted-foreground">{risk.description}</dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium">{t('details.cause')}</dt>
                <dd className="break-words text-muted-foreground">{risk.cause}</dd>
              </div>
              <div>
                <dt className="font-medium">{t('details.consequence')}</dt>
                <dd className="break-words text-muted-foreground">{risk.consequence}</dd>
              </div>
              <div>
                <dt className="font-medium">{t('details.treatments')}</dt>
                <dd className="text-muted-foreground">
                  {risk.treatments.length === 0
                    ? t('details.noTreatments')
                    : t('details.treatmentCount', { count: risk.treatments.length })}
                </dd>
              </div>
              <div>
                <dt className="font-medium">{t('details.scale')}</dt>
                <dd className="text-muted-foreground">
                  {t('details.scaleUsed', {
                    size: `${String(risk.scaleSnapshot.scale.max)}×${String(risk.scaleSnapshot.scale.max)}`,
                  })}
                  {otherScale ? ` ${t('details.scaleChanged')}` : ''}
                </dd>
              </div>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * `RiskList` (US-033 · SCR-011, seção "Lista de riscos"): riscos do processo (RSK-01) com nível por
 * cor + texto, responsável ("Sem responsável" destacado — FA-03), detalhes por risco, "Novo risco",
 * edição/reavaliação e exclusão. Estados: skeleton, vazio, erro com "Tentar novamente", bloqueado
 * (FA-04: aviso + link para o Mapa de Riscos) e sem permissão (sem botões — cenário [Permissão]).
 * Abaixo de 768 px, cada risco vira um cartão.
 */
export function RiskList({ processId }: { readonly processId: string }) {
  const t = useTranslations('risks');
  const list = useRisks(processId);
  const invalidate = useInvalidateProcess(processId);
  const noticeId = useId();
  const [form, setForm] = useState<FormTarget | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (list.data === undefined) {
    if (list.isPending) {
      return (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      );
    }
    return (
      <Alert tone="error" title={t('errors.load')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t('errors.retry')}
        </Button>
      </Alert>
    );
  }

  const { risks, meta } = list.data;
  const lock = lockStateOf(meta);
  const byId = new Map(risks.map((risk) => [risk.id, risk]));
  const editing = form?.mode === 'edit' ? (byId.get(form.riskId) ?? null) : null;
  const formOpen = form !== null && (form.mode === 'add' || editing !== null);
  const removing = removingId === null ? null : (byId.get(removingId) ?? null);
  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const notice =
    lock.reason === null ? null : lock.reason === 'DOCUMENT_NOT_EDITABLE' ? (
      <Alert tone="warning" title={RISK_MESSAGES.locked} id={noticeId}>
        {meta.riskMap === null ? null : (
          <Link
            href={`/processos/${processId}/documentos/${meta.riskMap.id}`}
            className="text-primary underline"
          >
            {meta.riskMap.code === null
              ? t('locked.openDocument')
              : t('locked.openDocumentNamed', { code: meta.riskMap.code })}
          </Link>
        )}
      </Alert>
    ) : (
      <Alert
        tone="info"
        id={noticeId}
        title={
          lock.reason === 'INVALID_PROCESS_STATUS'
            ? RISK_MESSAGES.invalidProcessStatus
            : t(`locks.${lock.reason}` as 'locks.NOT_CUSTODIAN')
        }
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {notice}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('count', { count: risks.length })}</p>
        {lock.showActions ? (
          <Button
            disabled={lock.disabled}
            aria-describedby={lock.disabled ? noticeId : undefined}
            onClick={() => {
              setForm({ mode: 'add' });
            }}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {risks.length === 0 ? (
        <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <table className="block w-full md:table">
          <caption className="sr-only">{t('listCaption')}</caption>
          <thead className="hidden text-left text-sm text-muted-foreground md:table-header-group">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('columns.code')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('columns.risk')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('columns.assessment')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('columns.owner')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('columns.status')}
              </th>
              {lock.showActions ? (
                <th scope="col" className="px-3 py-2">
                  {t('columns.actions')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {risks.map((risk) => (
              <RiskRow
                key={risk.id}
                risk={risk}
                meta={meta}
                lock={lock}
                noticeId={noticeId}
                expanded={expanded.has(risk.id)}
                onToggle={() => {
                  toggle(risk.id);
                }}
                onEdit={() => {
                  setForm({ mode: 'edit', riskId: risk.id });
                }}
                onRemove={() => {
                  setRemovingId(risk.id);
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <RiskFormDrawer
        processId={processId}
        risk={editing}
        open={formOpen}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        meta={meta}
        onChanged={invalidate}
      />
      <DeleteRiskDialog
        risk={removing}
        scaleMax={meta.scale.max}
        onClose={() => {
          setRemovingId(null);
        }}
        onChanged={invalidate}
      />
    </div>
  );
}
