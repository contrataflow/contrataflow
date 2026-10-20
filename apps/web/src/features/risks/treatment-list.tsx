'use client';

import { Button, toast } from '@contrataflow/ui';
import { TREATMENT_STATUS_LABELS, TREATMENT_TYPE_LABELS } from '@contrataflow/validation';
import type { RiskDto, RiskTreatmentDto, TreatmentStatus } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { DeleteTreatmentDialog } from './delete-treatment-dialog';
import { OverdueBadge } from './overdue-badge';
import type { RiskLockState } from './risks-model';
import { updateTreatment } from './risks.api';
import { TreatmentFormDrawer } from './treatment-form-drawer';
import { TreatmentStatusSelect } from './treatment-status-select';
import {
  dueStateOf,
  formatDueDate,
  localToday,
  reorderPatches,
  treatmentProblemMessage,
  treatmentProblemOf,
} from './treatments-model';
import type { SortOrderPatch } from './treatments-model';

type FormTarget = { readonly mode: 'add' } | { readonly mode: 'edit'; readonly id: string };

export interface TreatmentListProps {
  readonly risk: RiskDto;
  /** O mesmo bloqueio dos riscos (RN-RISK-16 = RN-RISK-09 — `meta.canManage` de RSK-01). */
  readonly lock: RiskLockState;
  /** Aviso de bloqueio da tela (FA-05), referenciado pelos botões desabilitados. */
  readonly noticeId: string;
  readonly onChanged: () => Promise<void> | void;
  /** Hoje (`YYYY-MM-DD`) para o destaque de prazo; padrão: a data local do navegador. */
  readonly today?: string | undefined;
}

/**
 * `TreatmentList` (US-034 · SCR-011, painel expandido do risco): as ações de tratamento do risco por
 * `sortOrder`/prazo, com tipo, responsável, prazo e destaque "Atrasado"/"Vence em…" (FA-03), o
 * status com "Atualizar status" (RN-RISK-15), reordenação (FA-02), edição e exclusão. Estados: vazio
 * ("Nenhuma ação de tratamento. Adicione a primeira ação."), bloqueado (FA-05: ações desabilitadas)
 * e sem permissão (sem botões). Lista navegável por teclado; coluna única abaixo de 768 px.
 */
export function TreatmentList({ risk, lock, noticeId, onChanged, today }: TreatmentListProps) {
  const t = useTranslations('risks.treatments');
  const headingId = useId();
  const [form, setForm] = useState<FormTarget | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const treatments = risk.treatments;
  const byId = new Map(treatments.map((treatment) => [treatment.id, treatment]));
  const editing = form?.mode === 'edit' ? (byId.get(form.id) ?? null) : null;
  const formOpen = form !== null && (form.mode === 'add' || editing !== null);
  const removing = removingId === null ? null : (byId.get(removingId) ?? null);
  const describedBy = lock.disabled && lock.reason !== null ? noticeId : undefined;
  const day = today ?? localToday();

  const fail = (error: unknown) => {
    const problem = treatmentProblemOf(error);
    const message = treatmentProblemMessage(problem);
    toast({
      title:
        message ??
        t('toast.unexpected', {
          correlationId: problem.kind === 'unexpected' ? problem.correlationId : '—',
        }),
      tone: 'error',
    });
    // 409/412/403/404: a lista recarrega e o status/ordem exibidos voltam aos do servidor.
    if (problem.kind !== 'unavailable') void onChanged();
  };

  const status = useMutation({
    mutationFn: ({ target, next }: { target: RiskTreatmentDto; next: TreatmentStatus }) =>
      updateTreatment(target.id, { status: next }, target.version),
    onSuccess: async (saved) => {
      toast({
        title: t('toast.status', { status: TREATMENT_STATUS_LABELS[saved.status] }),
        tone: 'success',
      });
      await onChanged();
    },
    onError: fail,
  });

  const reorder = useMutation({
    mutationFn: async (patches: readonly SortOrderPatch[]) => {
      for (const patch of patches) {
        await updateTreatment(patch.id, { sortOrder: patch.sortOrder }, patch.version);
      }
    },
    onSuccess: async () => {
      toast({ title: t('toast.reordered'), tone: 'success' });
      await onChanged();
    },
    onError: fail,
  });
  const busy = status.isPending || reorder.isPending;
  const move = (from: number, to: number) => {
    const patches = reorderPatches(treatments, from, to);
    if (patches.length > 0) reorder.mutate(patches);
  };

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {t('title')}
        </h3>
        {lock.showActions ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={lock.disabled}
            aria-label={t('addFor', { code: risk.code })}
            aria-describedby={describedBy}
            onClick={() => {
              setForm({ mode: 'add' });
            }}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {treatments.length === 0 ? (
        <p className="rounded-card border border-dashed border-border p-3 text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ol aria-label={t('listLabel', { code: risk.code })} className="flex flex-col gap-2">
          {treatments.map((treatment, index) => {
            const position = index + 1;
            const names = { position, code: risk.code };
            const responsible = [
              treatment.responsible?.name,
              treatment.responsibleDepartment?.name,
            ].filter((part): part is string => part !== undefined && part !== '');
            return (
              <li
                key={treatment.id}
                className="flex flex-col gap-2 rounded-control border border-border bg-background p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
                    {TREATMENT_TYPE_LABELS[treatment.type]}
                  </span>
                  <OverdueBadge state={dueStateOf(treatment, day)} />
                </div>
                <p className="text-sm break-words">{treatment.description}</p>
                <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground md:grid-cols-3">
                  <div>
                    <dt className="sr-only">{t('labels.responsible')}</dt>
                    <dd>
                      {responsible.length === 0 ? t('noResponsible') : responsible.join(' · ')}
                    </dd>
                  </div>
                  <div>
                    <dt className="sr-only">{t('labels.dueDate')}</dt>
                    <dd>
                      {treatment.dueDate === null
                        ? t('noDueDate')
                        : t('dueDate', { date: formatDueDate(treatment.dueDate) })}
                    </dd>
                  </div>
                  {treatment.completedAt === null ? null : (
                    <div>
                      <dt className="sr-only">{t('labels.completedAt')}</dt>
                      <dd>
                        {t('completedAt', {
                          date: formatDueDate(treatment.completedAt.slice(0, 10)),
                        })}
                      </dd>
                    </div>
                  )}
                  {treatment.notes === null ? null : (
                    <div className="md:col-span-3">
                      <dt className="inline font-medium">{t('notes')}: </dt>
                      <dd className="inline break-words">{treatment.notes}</dd>
                    </div>
                  )}
                </dl>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <TreatmentStatusSelect
                    status={treatment.status}
                    label={t('status.labelFor', names)}
                    readOnly={!lock.showActions || lock.disabled}
                    disabled={busy}
                    describedBy={describedBy}
                    onChange={(next) => {
                      status.mutate({ target: treatment, next });
                    }}
                  />
                  {lock.showActions ? (
                    <div
                      role="group"
                      aria-label={t('actions.group', names)}
                      className="flex flex-wrap gap-1"
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lock.disabled || busy || index === 0}
                        aria-label={t('actions.moveUpFor', names)}
                        aria-describedby={describedBy}
                        onClick={() => {
                          move(index, index - 1);
                        }}
                      >
                        {t('actions.moveUp')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lock.disabled || busy || index === treatments.length - 1}
                        aria-label={t('actions.moveDownFor', names)}
                        aria-describedby={describedBy}
                        onClick={() => {
                          move(index, index + 1);
                        }}
                      >
                        {t('actions.moveDown')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={lock.disabled}
                        aria-label={t('actions.editFor', names)}
                        aria-describedby={describedBy}
                        onClick={() => {
                          setForm({ mode: 'edit', id: treatment.id });
                        }}
                      >
                        {t('actions.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lock.disabled}
                        aria-label={t('actions.removeFor', names)}
                        aria-describedby={describedBy}
                        onClick={() => {
                          setRemovingId(treatment.id);
                        }}
                      >
                        {t('actions.remove')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <TreatmentFormDrawer
        risk={risk}
        treatment={editing}
        open={formOpen}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        onChanged={onChanged}
      />
      <DeleteTreatmentDialog
        risk={risk}
        treatment={removing}
        onClose={() => {
          setRemovingId(null);
        }}
        onChanged={onChanged}
      />
    </section>
  );
}
