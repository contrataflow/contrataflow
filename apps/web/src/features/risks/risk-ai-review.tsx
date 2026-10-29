'use client';

import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Label,
  toast,
} from '@contrataflow/ui';
import { hasToConfirmMarker, isAiReviewPending } from '@contrataflow/validation';
import type { RiskDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { reviewAiRisks } from './risks.api';

/*
 * Riscos gerados por IA (US-119 · RN-AI-42 · SCR-011): o risco criado pela proposta fica "Gerado por
 * IA · revisão pendente" até a pessoa marcá-lo como revisado (RSK-12 — por risco ou em lote, com a
 * versão vista de cada um); "[a confirmar" no texto do risco ou de um tratamento também bloqueia a
 * conclusão do Mapa de Riscos. Estado sempre em texto + ícone (nunca só cor).
 */

/** Texto do risco ou de um tratamento ativo com "[a confirmar…" (`RISK_PLACEHOLDER_PENDING`). */
export function riskHasPlaceholder(risk: RiskDto): boolean {
  return (
    [risk.title, risk.description, risk.cause, risk.consequence].some(hasToConfirmMarker) ||
    risk.treatments.some(
      (treatment) => treatment.status !== 'CANCELED' && hasToConfirmMarker(treatment.description),
    )
  );
}

/** `AiGeneratedBadge` do risco: "Gerado por IA · revisão pendente" ou "· revisado em {data}". */
export function RiskAiBadge({ risk }: { readonly risk: RiskDto }) {
  const t = useTranslations('risks.aiReview');
  const format = useFormatter();
  const session = useShellSession();
  if (risk.aiGenerationId === null) return null;
  const placeholder = riskHasPlaceholder(risk);
  if (isAiReviewPending(risk)) {
    return (
      <span className="mt-1 inline-flex flex-wrap items-center gap-1 rounded-control border border-warning bg-warning-soft px-2 py-0.5 text-xs font-semibold text-foreground">
        <span aria-hidden="true">✦</span>
        {t('badge.pending')}
        {placeholder ? <span className="font-normal">{t('badge.placeholder')}</span> : null}
      </span>
    );
  }
  const date = format.dateTime(new Date(risk.aiReviewedAt ?? ''), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-1 rounded-control border border-border bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
      <span aria-hidden="true">✓</span>
      {risk.aiReviewedBy?.id === session.user.id
        ? t('badge.reviewedByMe', { date })
        : t('badge.reviewed', { date })}
      {placeholder ? <span className="font-normal">{t('badge.placeholder')}</span> : null}
    </span>
  );
}

function useRiskReview(processId: string, onDone: (reviewed: number) => Promise<void> | void) {
  const t = useTranslations('risks.aiReview');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (risks: readonly RiskDto[]) => reviewAiRisks(processId, risks),
    onSuccess: async (result) => {
      setError(null);
      await onDone(result.reviewedRiskIds.length);
    },
    onError: async (failure) => {
      const code = isApiError(failure) ? failure.code : null;
      setError(
        code === 'VERSION_CONFLICT'
          ? t('errors.conflict')
          : code === 'DOCUMENT_NOT_EDITABLE'
            ? t('errors.locked')
            : t('errors.unavailable'),
      );
      // Versão divergente: a lista recarrega para a pessoa ler a versão atual (V-08).
      if (code === 'VERSION_CONFLICT') await onDone(0);
    },
  });
  return { mutation, error };
}

/** `MarkReviewedButton` do risco — RSK-12 de um risco, com a versão exibida na lista. */
export function MarkRiskReviewedButton({
  processId,
  risk,
  disabled,
  describedBy,
  onChanged,
}: {
  readonly processId: string;
  readonly risk: RiskDto;
  readonly disabled: boolean;
  readonly describedBy?: string | undefined;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('risks.aiReview');
  const review = useRiskReview(processId, async (reviewed) => {
    if (reviewed > 0) toast({ title: t('toast.one', { code: risk.code }), tone: 'success' });
    await onChanged();
  });
  const pending = review.mutation.isPending;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || pending}
        aria-busy={pending}
        aria-label={t('markReviewedFor', { code: risk.code })}
        aria-describedby={describedBy}
        onClick={() => {
          review.mutation.mutate([risk]);
        }}
      >
        {pending ? t('working') : t('markReviewed')}
      </Button>
      {review.error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {review.error}
        </span>
      )}
    </span>
  );
}

/** `ReviewAllDialog` dos riscos — "Li e revisei os N riscos" → RSK-12 em lote. */
export function ReviewAllRisksDialog({
  processId,
  risks,
  onClose,
  onChanged,
}: {
  readonly processId: string;
  readonly risks: readonly RiskDto[];
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('risks.aiReview');
  const [confirmed, setConfirmed] = useState(false);
  const confirmId = useId();
  const review = useRiskReview(processId, async (reviewed) => {
    await onChanged();
    if (reviewed > 0) {
      toast({ title: t('toast.many', { count: reviewed }), tone: 'success' });
      onClose();
    }
  });
  const pending = review.mutation.isPending;
  const count = risks.length;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="max-md:inset-0 max-md:h-full max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-none">
        <DialogTitle>{t('reviewAll.title')}</DialogTitle>
        <DialogDescription>{t('reviewAll.description', { count })}</DialogDescription>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {risks.map((risk) => (
            <li key={risk.id}>
              {risk.code} — {risk.title}
            </li>
          ))}
        </ul>
        <div className="flex items-start gap-2 text-sm font-medium">
          <Checkbox
            id={confirmId}
            className="mt-0.5"
            checked={confirmed}
            onCheckedChange={(checked) => {
              setConfirmed(checked === true);
            }}
          />
          <Label htmlFor={confirmId} className="font-medium">
            {t('reviewAll.confirmLabel', { count })}
          </Label>
        </div>
        {review.error === null ? null : (
          <Alert tone="error" title={review.error}>
            {null}
          </Alert>
        )}
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('reviewAll.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={pending || !confirmed}
            aria-busy={pending}
            onClick={() => {
              review.mutation.mutate(risks);
            }}
          >
            {pending ? t('working') : t('reviewAll.confirm', { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
