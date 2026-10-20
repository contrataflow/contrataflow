'use client';

import { Alert, Button } from '@contrataflow/ui';
import type { AlertTone } from '@contrataflow/ui';
import type { DfdDecisionDto, DocumentAction, DocumentDto } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { formatDateTime } from '@/lib/i18n/format';
import { useTenantId } from '@/lib/session/session-context';

import { dfdKeys } from './dfd.api';
import { endsFlow } from '../documents/document-errors';
import type { DocumentOutcome } from '../documents/document-errors';
import { ReopenDialog } from '../documents/reason-dialog';
import { useDocumentLifecycle } from '../documents/use-document-lifecycle';

const TONE: Readonly<Record<DfdDecisionDto['outcome'], AlertTone>> = {
  APPROVED: 'success',
  RETURNED: 'warning',
  REJECTED: 'error',
};

/**
 * A decisão vale para a tela enquanto o DFD está no status que ela produziu (DEC-018): reaberto ou
 * reenviado, o banner sai.
 */
export function visibleDecision(
  decision: DfdDecisionDto | null | undefined,
  status: DocumentDto['status'],
): DfdDecisionDto | null {
  if (decision === null || decision === undefined) return null;
  return decision.outcome === status ? decision : null;
}

/**
 * `DecisionBanner` (US-017 · SCR-007): o desfecho da aprovação do DFD (aprovado, devolvido,
 * indeferido), quem decidiu e quando, o motivo informado pelo aprovador e — com `REOPEN` em
 * `meta.allowedActions` (DOCUMENT_REOPEN + custódia — POL-11) — "Reabrir DFD" (DOC-12). Anunciado
 * por `aria-live`.
 */
export function DecisionBanner({
  decision,
  document,
  dfdId,
  allowedActions,
  timeZone,
}: {
  readonly decision: DfdDecisionDto | null | undefined;
  readonly document: DocumentDto;
  readonly dfdId: string;
  readonly allowedActions: readonly DocumentAction[];
  readonly timeZone: string;
}) {
  const t = useTranslations('dfd.decision');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const lifecycle = useDocumentLifecycle(document);
  const [reopening, setReopening] = useState(false);
  const [feedback, setFeedback] = useState<DocumentOutcome | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const visible = visibleDecision(decision, document.status);
  if (visible === null) return null;

  const reopen = async (reopenReason: string) => {
    setLastReason(reopenReason);
    setFeedback(null);
    const result = await lifecycle.run({ action: 'REOPEN', reopenReason });
    if (result.status === 'busy') return;
    if (result.status === 'done' || endsFlow(result.outcome)) {
      setReopening(false);
      // O wizard volta à revisão (RN-DFD-69): o DFD-03 traz o passo e as ações novas.
      void queryClient.invalidateQueries({ queryKey: dfdKeys.detail(tenantId, dfdId) });
      return;
    }
    setFeedback(result.outcome);
  };

  const by = visible.decidedBy?.name ?? t('unknownDecider');
  return (
    <div aria-live="polite">
      <Alert tone={TONE[visible.outcome]} title={t(`titles.${visible.outcome}`)} live={false}>
        <p>{t('byline', { name: by, at: formatDateTime(visible.decidedAt, timeZone) })}</p>
        {visible.comment === null ? null : (
          <p className="mt-1 break-words whitespace-pre-line">
            <span className="font-medium">{t('reason')}</span> {visible.comment}
          </p>
        )}
        {visible.outcome === 'RETURNED' ? <p className="mt-1">{t('returnedHint')}</p> : null}
        {allowedActions.includes('REOPEN') ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            disabled={lifecycle.pending}
            onClick={() => {
              setFeedback(null);
              setReopening(true);
            }}
          >
            {t('reopen')}
          </Button>
        ) : null}
      </Alert>
      <ReopenDialog
        open={reopening}
        pending={lifecycle.pending}
        feedback={feedback}
        onSubmit={(reason) => {
          void reopen(reason);
        }}
        onRetry={() => {
          if (lastReason !== null) void reopen(lastReason);
        }}
        onClose={() => {
          setReopening(false);
          setFeedback(null);
        }}
      />
    </div>
  );
}
