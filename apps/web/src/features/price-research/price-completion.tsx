'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import {
  BELOW_MINIMUM_JUSTIFICATION_MAX,
  PRICE_COMPLETION_MESSAGES,
} from '@contrataflow/validation';
import type { PriceItemDto, PriceResearchDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { formatDate, formatMoney } from '@/lib/i18n/format';

import {
  completedToast,
  completionPreview,
  justificationIssue,
  needsBelowMinimumJustification,
  pendingFromViolations,
} from './price-completion-model';
import type { PendingItem } from './price-completion-model';
import { completePriceResearch, updatePriceItem } from './price-research.api';
import type { PriceResearchResult } from './price-research.api';
import { FormField, TEXTAREA_CLASS } from '../processes/form-field';

/*
 * Conclusão da pesquisa na SCR-009 (US-032 · PRS-23): `CompleteResearchDialog` (resumo, pendências
 * previstas e o aviso de itens com alerta antes de confirmar — FA-03), `IncompleteItemsList` (as
 * pendências do 422 com links aos itens — FA-01; recebe o foco), `CompletedBadge` e o campo da
 * justificativa de cotações insuficientes do item (PRS-07 — FA-02). O botão só aparece com
 * `COMPLETE` em `meta.allowedActions`; a regra final é sempre a do PRS-23.
 */

export interface CompletionNotice {
  readonly tone: 'warning' | 'error' | 'info';
  readonly text: string;
}

/** `CompletedBadge`: selo "Concluída" (com a data no `title`). */
export function CompletedBadge({
  completedAt,
  timeZone,
}: {
  readonly completedAt: string;
  readonly timeZone: string;
}) {
  const t = useTranslations('priceResearch.completion');
  return (
    <span
      title={t('badgeAt', { date: formatDate(completedAt, timeZone) })}
      className="inline-flex items-center rounded-control border border-success/30 bg-success-soft px-2 py-0.5 text-xs font-medium"
    >
      {t('badge')}
    </span>
  );
}

/** Botão "Concluir pesquisa" + `CompleteResearchDialog`. */
export function CompleteResearchButton({
  research,
  version,
  items,
  onCompleted,
  onIncomplete,
  onRejected,
}: {
  readonly research: PriceResearchDto;
  readonly version: number;
  readonly items: readonly PriceItemDto[];
  readonly onCompleted: (result: PriceResearchResult) => Promise<void>;
  /** 422 `PRICE_RESEARCH_INCOMPLETE`: a lista de pendências com links. */
  readonly onIncomplete: (pending: readonly PendingItem[]) => void;
  /** Recusas de estado (412/409/403/422 do documento): aviso na tela e recarga. */
  readonly onRejected: (notice: CompletionNotice) => void;
}) {
  const t = useTranslations('priceResearch.completion');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('action')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={null}>
          {open ? (
            <CompleteResearchForm
              research={research}
              version={version}
              items={items}
              onClose={() => {
                setOpen(false);
              }}
              onCompleted={onCompleted}
              onIncomplete={onIncomplete}
              onRejected={onRejected}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CompleteResearchForm({
  research,
  version,
  items,
  onClose,
  onCompleted,
  onIncomplete,
  onRejected,
}: {
  readonly research: PriceResearchDto;
  readonly version: number;
  readonly items: readonly PriceItemDto[];
  readonly onClose: () => void;
  readonly onCompleted: (result: PriceResearchResult) => Promise<void>;
  readonly onIncomplete: (pending: readonly PendingItem[]) => void;
  readonly onRejected: (notice: CompletionNotice) => void;
}) {
  const t = useTranslations('priceResearch.completion');
  const tErrors = useTranslations('errors.correlation');
  // A mesma chave em cada reenvio desta confirmação (idempotência do PRS-23).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly correlationId: string | null;
  } | null>(null);
  const preview = completionPreview(items, research.parameters.minQuotations);
  const total = research.totalEstimatedValueMasked
    ? PRICE_COMPLETION_MESSAGES.confidentialValue
    : research.totalEstimatedValue === null
      ? t('dialog.notCalculated')
      : formatMoney(research.totalEstimatedValue);

  const complete = useMutation({
    mutationFn: () => completePriceResearch(research.id, version, idempotencyKey),
    onSuccess: async (result) => {
      onClose();
      toast({ title: completedToast(result.research), tone: 'success' });
      await onCompleted(result);
    },
    onError: (error: unknown) => {
      if (!isApiError(error) || error.status >= 500 || error.status === 0) {
        setFailure({
          message: PRICE_COMPLETION_MESSAGES.unavailable,
          correlationId: isApiError(error) ? error.correlationId : null,
        });
        return;
      }
      onClose();
      if (error.code === 'PRICE_RESEARCH_INCOMPLETE') {
        onIncomplete(pendingFromViolations(error.violations, items));
      } else if (error.code === 'DOCUMENT_INCOMPLETE') {
        onRejected({ tone: 'error', text: t('documentIncomplete') });
      } else if (error.status === 412 || error.code === 'PRECONDITION_REQUIRED') {
        onRejected({ tone: 'warning', text: PRICE_COMPLETION_MESSAGES.versionConflict });
      } else if (error.code === 'DOCUMENT_NOT_EDITABLE') {
        onRejected({ tone: 'error', text: PRICE_COMPLETION_MESSAGES.notEditable });
      } else if (error.status === 403) {
        onRejected({ tone: 'error', text: PRICE_COMPLETION_MESSAGES.permissionDenied });
      } else {
        onRejected({ tone: 'error', text: error.message || PRICE_COMPLETION_MESSAGES.unavailable });
      }
    },
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DialogTitle>{t('dialog.title')}</DialogTitle>
      <DialogDescription>{t('dialog.description')}</DialogDescription>
      <dl aria-label={t('dialog.summary')} className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('dialog.items')}</dt>
          <dd className="font-semibold">{research.itemsCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('dialog.total')}</dt>
          <dd className="font-semibold">{total}</dd>
        </div>
      </dl>
      {preview.itemsWithAlerts > 0 ? (
        <Alert
          tone="warning"
          title={PRICE_COMPLETION_MESSAGES.withAlerts(preview.itemsWithAlerts)}
        />
      ) : null}
      {preview.pending.length > 0 ? (
        <Alert tone="error" title={t('dialog.pendingTitle')}>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {preview.pending.map((pending) => (
              <li key={pending.itemId}>{pending.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div aria-live="polite">
        {failure === null ? null : (
          <Alert tone="error" title={failure.message}>
            {failure.correlationId === null ? null : (
              <CorrelationCode
                correlationId={failure.correlationId}
                labels={{
                  code: tErrors('label', { correlationId: failure.correlationId }),
                  copy: tErrors('copy'),
                  copied: tErrors('copied'),
                }}
              />
            )}
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('dialog.cancel')}
        </Button>
        <Button
          disabled={complete.isPending}
          onClick={() => {
            setFailure(null);
            complete.mutate();
          }}
        >
          {complete.isPending
            ? t('completing')
            : failure === null
              ? t('dialog.confirm')
              : t('dialog.retry')}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** `IncompleteItemsList` (FA-01): as pendências com link a cada item; recebe o foco ao aparecer. */
export function IncompleteItemsList({
  pending,
  onOpenItem,
}: {
  readonly pending: readonly PendingItem[];
  readonly onOpenItem: (item: PendingItem) => void;
}) {
  const t = useTranslations('priceResearch.completion.incomplete');
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [pending]);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-card border border-destructive/30 bg-destructive-soft p-4"
    >
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-base font-semibold">
        {t('title')}
      </h2>
      <ul className="flex flex-col gap-2 text-sm">
        {pending.map((item) => (
          <li key={item.itemId} className="flex flex-wrap items-center gap-2">
            <span>{item.message}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onOpenItem(item);
              }}
            >
              {t('open', { number: item.sequence })}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Id do campo da justificativa do item (o link da lista de pendências leva até ele). */
export const justificationFieldId = (itemId: string) => `pr-below-min-${itemId}`;

/**
 * Justificativa de cotações insuficientes do item (FA-02 · PRS-07): editável com `UPDATE` quando o
 * item está abaixo do mínimo (ou já justificado); senão, o texto gravado em leitura.
 */
export function BelowMinimumJustificationField({
  item,
  minQuotations,
  canUpdate,
  onSaved,
  onWriteError,
}: {
  readonly item: PriceItemDto;
  readonly minQuotations: number;
  readonly canUpdate: boolean;
  readonly onSaved: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.completion.justification');
  const saved = item.belowMinimumJustification ?? '';
  const [draft, setDraft] = useState(saved);
  const [touched, setTouched] = useState(false);
  const [serverIssue, setServerIssue] = useState<string | null>(null);
  const issue = serverIssue ?? justificationIssue(draft);
  const changed = draft.trim() !== saved;
  const save = useMutation({
    mutationFn: () =>
      updatePriceItem(
        item.id,
        { belowMinimumJustification: draft.trim() === '' ? null : draft.trim() },
        item.version,
      ),
    onSuccess: async () => {
      toast({ title: t('saved', { number: item.sequence }), tone: 'success' });
      await onSaved();
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.status === 422) {
        setServerIssue(error.errors[0]?.message ?? t('failed'));
        return;
      }
      onWriteError(error, t('failed'));
    },
  });
  if (!needsBelowMinimumJustification(item, minQuotations)) return null;
  if (!canUpdate) {
    return saved === '' ? null : (
      <p className="text-sm break-words text-muted-foreground">{t('readOnly', { text: saved })}</p>
    );
  }
  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!changed || issue !== null || save.isPending) return;
        save.mutate();
      }}
    >
      <FormField
        id={justificationFieldId(item.id)}
        label={t('label')}
        hint={t('hint', { min: minQuotations })}
        error={touched ? (issue ?? undefined) : undefined}
      >
        {(control) => (
          <textarea
            {...control}
            rows={3}
            className={TEXTAREA_CLASS}
            maxLength={BELOW_MINIMUM_JUSTIFICATION_MAX}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setServerIssue(null);
            }}
          />
        )}
      </FormField>
      <div>
        <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}
