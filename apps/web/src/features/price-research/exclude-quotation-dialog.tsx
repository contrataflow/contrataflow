'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@contrataflow/ui';
import { EXCLUSION_REASONS, PRICE_SOURCE_LIMITS } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { isApiError } from '@/lib/api/api-error';

import {
  EMPTY_EXCLUSION_FORM,
  excludeBodyOf,
  leavesItemWithoutValidQuotation,
  validateExclusionForm,
} from './price-source-model';
import type { ExclusionFormErrors, ExclusionFormValues, GridRow } from './price-source-model';
import { excludeQuotation } from './price-sources.api';
import { FormField, TEXTAREA_CLASS } from '../processes/form-field';

/*
 * `ExcludeQuotationDialog` (US-027 · SCR-009 · fluxo principal 1–4): motivo (`ExclusionReason`) e
 * justificativa (≥ 20 caracteres) para desconsiderar uma cotação `VALID` — PRS-16 com o `If-Match` da
 * cotação. O foco vai para "Motivo"; os erros dos campos (V-01/V-02) são anunciados por `aria-live`
 * e o diálogo continua aberto com o que foi digitado. FA-01: se for a última cotação válida do item,
 * avisa "Este item ficará sem cotação válida" antes de confirmar (não bloqueia). Recusas de estado
 * (`INVALID_STATE`, 412, documento não editável, 403) fecham o diálogo e pedem a recarga da grade; a
 * indisponibilidade (503) mantém o diálogo com os dados preenchidos.
 */

export function ExcludeQuotationDialog({
  row,
  onClose,
  onExcluded,
  onWriteError,
}: {
  readonly row: GridRow | null;
  readonly onClose: () => void;
  /** Recarregar fontes, itens e totais depois de gravar. */
  readonly onExcluded: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={null}>
        {row === null ? null : (
          <ExcludeQuotationForm
            row={row}
            onClose={onClose}
            onExcluded={onExcluded}
            onWriteError={onWriteError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExcludeQuotationForm({
  row,
  onClose,
  onExcluded,
  onWriteError,
}: {
  readonly row: GridRow;
  readonly onClose: () => void;
  readonly onExcluded: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.sources.excludeDialog');
  const tErrors = useTranslations('errors.correlation');
  const fieldId = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<ExclusionFormValues>(EMPTY_EXCLUSION_FORM);
  const [errors, setErrors] = useState<ExclusionFormErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly correlationId: string | null;
  } | null>(null);
  const quotation = row.quotation;

  const submit = async () => {
    if (quotation === null) return;
    const found = validateExclusionForm(values);
    setErrors(found);
    const body = excludeBodyOf(values);
    if (body === null || Object.keys(found).length > 0) {
      // Foco no primeiro campo com erro (leitor de tela anuncia a mensagem).
      queueMicrotask(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      await excludeQuotation(quotation.id, body, quotation.version);
      toast({ title: t('toast'), tone: 'success' });
      onClose();
      await onExcluded();
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const byField = new Map(error.errors.map((item) => [item.field, item.message]));
        setErrors({
          ...(byField.has('exclusionReason')
            ? { reason: byField.get('exclusionReason') ?? '' }
            : {}),
          ...(byField.has('exclusionJustification')
            ? { justification: byField.get('exclusionJustification') ?? '' }
            : {}),
        });
      } else if (
        isApiError(error) &&
        (error.status === 403 ||
          error.status === 412 ||
          error.code === 'INVALID_STATE' ||
          error.code === 'DOCUMENT_NOT_EDITABLE' ||
          error.status === 404)
      ) {
        onClose();
        onWriteError(error, t('errors.failed'));
      } else {
        setFailure({
          message: t('errors.unavailable'),
          correlationId: isApiError(error) ? error.correlationId : null,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={formRef} className="flex min-w-0 flex-col gap-4">
      <DialogTitle>{t('title', { number: row.item.sequence })}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
      {leavesItemWithoutValidQuotation(row) ? (
        <Alert tone="warning" title={t('lastValid')} />
      ) : null}
      <FormField id={`${fieldId}-reason`} label={t('reason')} required error={errors.reason}>
        {(control) => (
          <Select
            value={values.reason}
            onValueChange={(value) => {
              const reason = EXCLUSION_REASONS.find((candidate) => candidate === value);
              setValues((current) => ({ ...current, reason: reason ?? '' }));
              setErrors((current) => ({ ...current, reason: '' }));
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder={t('reasonPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {EXCLUSION_REASONS.map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {t(`reasons.${reason}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField
        id={`${fieldId}-justification`}
        label={t('justification')}
        hint={t('justificationHint', { min: PRICE_SOURCE_LIMITS.exclusionJustificationMin })}
        required
        error={errors.justification}
      >
        {(control) => (
          <textarea
            {...control}
            className={TEXTAREA_CLASS}
            maxLength={PRICE_SOURCE_LIMITS.exclusionJustificationMax}
            value={values.justification}
            onChange={(event) => {
              setValues((current) => ({ ...current, justification: event.target.value }));
              setErrors((current) => ({ ...current, justification: '' }));
            }}
          />
        )}
      </FormField>
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
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? t('saving') : t('confirm')}
        </Button>
      </DialogFooter>
    </div>
  );
}
