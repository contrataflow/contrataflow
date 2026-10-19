'use client';

import { Alert, Button } from '@contrataflow/ui';
import { isTermMoney, TERM_LIMITS, TERM_MESSAGES } from '@contrataflow/validation';
import type { TermDetailDto, TermPatch } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { formatMoney } from '@/lib/i18n/format';
import { useTenantId } from '@/lib/session/session-context';

import { objectProblem } from './term-editor-model';
import { patchTerm, termKeys } from './term.api';
import type { TermResult } from './term.api';
import { documentKeys } from '../documents/documents.api';
import { priceResearchHref } from '../price-research/price-research.api';
import { processDocumentKeys } from '../process-documents/process-documents.api';
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';
import { toDecimalMoney } from '../processes/money';

/*
 * `TermGeneralDataPanel` (SCR-012 · US-036 · fluxo principal 9): "Dados do TR" — o objeto (resumo)
 * e o valor estimado, gravados pelo TRM-04 com `If-Match: "<version>"` do TR. O valor vem da
 * pesquisa de preços (origem + link), é informado manualmente (com o aviso de FA-04 quando existe
 * pesquisa concluída) ou fica mascarado sob POL-09 ("Valor sigiloso" — FA-05; a tela nunca calcula
 * a máscara). As condições contratuais tipadas entram com a US-038.
 */

/** O valor estimado em texto (ou "Valor sigiloso" mascarado — POL-09) para quadros somente leitura. */
export function EstimatedValueText({
  term,
}: {
  readonly term: Pick<TermDetailDto, 'estimatedTotalValue' | 'estimatedTotalValueMasked'>;
}) {
  const t = useTranslations('term.general.value');
  if (term.estimatedTotalValueMasked) {
    return <span title={t('masked')}>{TERM_MESSAGES.confidentialValue}</span>;
  }
  if (term.estimatedTotalValue === null) {
    return <span className="text-muted-foreground">{t('notInformed')}</span>;
  }
  return <>{formatMoney(term.estimatedTotalValue)}</>;
}

type Notice =
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface TermGeneralDataPanelProps {
  readonly processId: string;
  readonly term: TermDetailDto;
  readonly editable: boolean;
}

export function TermGeneralDataPanel({ processId, term, editable }: TermGeneralDataPanelProps) {
  const t = useTranslations('term.general');
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const [objectDraft, setObjectDraft] = useState<string | null>(null);
  const [objectError, setObjectError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);

  const patch = useMutation({
    mutationFn: (body: TermPatch) => patchTerm(term.id, body, term.version),
    onSuccess: (result, body) => {
      // A versão nova (o próximo `If-Match`) vale já; o TRM-03 recarregado traz pesquisa e máscara.
      queryClient.setQueryData<TermResult>(termKeys.detail(tenantId, term.id), (previous) =>
        previous === undefined
          ? previous
          : {
              term: { ...previous.term, ...result.term },
              meta:
                result.meta === null
                  ? previous.meta
                  : { ...previous.meta, allowedActions: result.meta.allowedActions },
            },
      );
      void queryClient.invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) });
      void queryClient.invalidateQueries({
        queryKey: processDocumentKeys.list(tenantId, term.processId),
      });
      void queryClient.invalidateQueries({
        queryKey: documentKeys.detail(tenantId, term.documentId),
      });
      if (body.objectDefinition !== undefined) setObjectDraft(null);
      setNotice({
        kind: 'ok',
        message: body.objectDefinition !== undefined ? t('object.saved') : t('value.saved'),
      });
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.code === 'VERSION_CONFLICT') {
        // Recarrega o painel (a nova versão); a edição digitada fica para o usuário reaplicar.
        void queryClient.invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) });
        setNotice({ kind: 'error', message: TERM_MESSAGES.versionConflict });
        return;
      }
      if (isApiError(error) && error.code === 'DOCUMENT_NOT_EDITABLE') {
        setNotice({ kind: 'error', message: TERM_MESSAGES.notEditable });
        return;
      }
      if (isApiError(error) && error.status === 403) {
        setNotice({ kind: 'error', message: TERM_MESSAGES.permissionDenied });
        return;
      }
      if (isApiError(error) && error.status === 422 && error.code === 'VALIDATION_ERROR') {
        const first = error.errors[0];
        setNotice({
          kind: 'error',
          message: first?.message ?? t('errors.unexpected'),
        });
        return;
      }
      const correlationId = isApiError(error) ? error.correlationId : null;
      setNotice({
        kind: 'error',
        message:
          correlationId === null
            ? t('errors.unexpected')
            : t('errors.unexpectedWithCode', { correlationId }),
      });
    },
  });

  const objectText = objectDraft ?? term.objectDefinition;
  const saveObject = () => {
    const problem = objectProblem(objectText);
    if (problem !== null) {
      setObjectError(problem);
      return;
    }
    setObjectError(undefined);
    setNotice(null);
    patch.mutate({ objectDefinition: objectText.trim() });
  };
  const dirty = objectDraft !== null && objectDraft.trim() !== term.objectDefinition.trim();

  return (
    <section
      aria-labelledby="term-general-title"
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border p-4"
    >
      <h3 id="term-general-title" className="text-base font-semibold">
        {t('title')}
      </h3>
      <div aria-live="polite">
        {notice === null ? null : (
          <Alert
            tone={notice.kind === 'ok' ? 'success' : 'error'}
            title={notice.message}
            live={false}
          />
        )}
      </div>
      <FormField
        id="term-object"
        label={t('object.label')}
        hint={t('object.hint')}
        required
        error={objectError}
      >
        {(control) => (
          <textarea
            {...control}
            className={`${TEXTAREA_CLASS} min-h-24`}
            value={objectText}
            maxLength={TERM_LIMITS.objectMax}
            readOnly={!editable}
            onChange={(event) => {
              setObjectDraft(event.target.value);
              setObjectError(undefined);
            }}
          />
        )}
      </FormField>
      {editable ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || patch.isPending}
            onClick={saveObject}
          >
            {patch.isPending && patch.variables.objectDefinition !== undefined
              ? t('object.saving')
              : t('object.save')}
          </Button>
        </div>
      ) : null}
      <EstimatedValueCard
        processId={processId}
        term={term}
        editable={editable}
        pending={patch.isPending}
        onPatch={(body) => {
          setNotice(null);
          patch.mutate(body);
        }}
      />
    </section>
  );
}

/** A origem do valor estimado (RN-TR-08): pesquisa de preços (com link), ETP ou manual. */
function ValueSource({
  processId,
  term,
}: {
  readonly processId: string;
  readonly term: TermDetailDto;
}): ReactNode {
  const t = useTranslations('term.general.value');
  switch (term.estimatedValueSource) {
    case 'PRICE_RESEARCH':
      return term.priceResearch === null ? (
        t('sourceLabel.PRICE_RESEARCH')
      ) : (
        <>
          {term.priceResearch.code === null
            ? t('sourceLabel.PRICE_RESEARCH')
            : t('sourceLabel.PRICE_RESEARCH_CODE', { code: term.priceResearch.code })}
          {' · '}
          <Link
            href={priceResearchHref(processId, term.priceResearch.id)}
            className="text-primary underline"
          >
            {t('openResearch')}
          </Link>
        </>
      );
    case 'ETP':
      return t('sourceLabel.ETP');
    case 'MANUAL':
      return t('sourceLabel.MANUAL');
    case null:
      return t('sourceLabel.NONE');
  }
}

interface EstimatedValueCardProps {
  readonly processId: string;
  readonly term: TermDetailDto;
  readonly editable: boolean;
  readonly pending: boolean;
  readonly onPatch: (body: TermPatch) => void;
}

/**
 * `EstimatedValueCard` (US-036 · RN-TR-08/FA-04/FA-05): o total, a origem rastreável (pesquisa de
 * preços com link, ETP ou manual) e as ações "Informar manualmente" / "Usar o valor da pesquisa".
 */
export function EstimatedValueCard({
  processId,
  term,
  editable,
  pending,
  onPatch,
}: EstimatedValueCardProps) {
  const t = useTranslations('term.general.value');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');
  const [manualError, setManualError] = useState<string | undefined>(undefined);
  const completed = term.completedPriceResearch;
  // Já vinculada: o botão só reaparece no aviso do valor manual (revincular atualiza — RN-TR-08).
  const linked =
    completed !== null &&
    term.estimatedValueSource === 'PRICE_RESEARCH' &&
    term.priceResearchId === completed.id;
  const confirmManual = () => {
    const decimal = toDecimalMoney(manualText);
    if (manualText.trim() === '') {
      setManualError(TERM_MESSAGES.manualValueRequired);
      return;
    }
    if (decimal === null || !isTermMoney(decimal)) {
      setManualError(TERM_MESSAGES.valueInvalid);
      return;
    }
    setManualError(undefined);
    setManualOpen(false);
    setManualText('');
    onPatch({ estimatedValueSource: 'MANUAL', estimatedTotalValue: decimal });
  };

  const useResearch =
    completed === null ? null : (
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          setManualOpen(false);
          setManualError(undefined);
          onPatch({ priceResearchId: completed.id });
        }}
      >
        {completed.totalEstimatedValue === null || term.estimatedTotalValueMasked
          ? t('useResearch')
          : t('useResearchWithValue', { value: formatMoney(completed.totalEstimatedValue) })}
      </Button>
    );

  return (
    <section
      aria-labelledby="term-value-title"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3"
    >
      <h4 id="term-value-title" className="text-sm font-semibold">
        {t('title')}
      </h4>
      <p className="text-lg font-semibold" data-testid="term-estimated-value">
        <EstimatedValueText term={term} />
      </p>
      <p className="text-sm text-muted-foreground">
        {t('source')}: <ValueSource processId={processId} term={term} />
      </p>
      {editable && !manualOpen ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setManualOpen(true);
            }}
          >
            {t('manual')}
          </Button>
          {linked ? null : useResearch}
        </div>
      ) : null}
      {editable && manualOpen ? (
        <div className="flex flex-col gap-3">
          {completed === null ? null : (
            <Alert
              tone="warning"
              title={TERM_MESSAGES.manualWithCompletedResearch(completed.code ?? '—')}
            >
              {useResearch === null ? null : <div className="mt-2">{useResearch}</div>}
            </Alert>
          )}
          <FormField
            id="term-manual-value"
            label={t('manualLabel')}
            hint={t('manualHint')}
            required
            error={manualError}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                inputMode="decimal"
                className={INPUT_CLASS}
                value={manualText}
                onChange={(event) => {
                  setManualText(event.target.value);
                  setManualError(undefined);
                }}
              />
            )}
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={confirmManual}>
              {pending ? t('saving') : t('confirm')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setManualOpen(false);
                setManualError(undefined);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
