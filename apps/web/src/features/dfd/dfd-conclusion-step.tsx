'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { PROCESS_FORWARD_LIMITS } from '@contrataflow/validation';
import type { DocumentAction, DocumentDto, ProcessDto } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { formatDate, formatDateTime } from '@/lib/i18n/format';
import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import {
  buildConclusionForwardBody,
  conclusionModeOf,
  conclusionWarnings,
  describeConclusionError,
  inApprovalOf,
  isMessageTooLong,
} from './dfd-conclusion-model';
import type { ConclusionProblem } from './dfd-conclusion-model';
import { useDfdValidation } from './dfd-review-step';
import { dfdKeys } from './dfd.api';
import { documentKeys, fetchDocument, transitionDocument } from '../documents/documents.api';
import { GeneratePdfButton } from '../documents/generate-pdf-button';
import { useAvailableActions, useProcessChecklist } from '../process-actions/process-actions.api';
import { useForwardProcess } from '../process-forward/process-forward.api';
import { TEXTAREA_CLASS } from '../processes/form-field';

/** RN-DFD-42 · FA-10: espera do descarregamento do autosave antes de concluir. */
const AUTOSAVE_FLUSH_TIMEOUT_MS = 10_000;

/** A fila de autosave do wizard (US-015): o passo 5 só envia com ela vazia. */
export interface ConclusionAutosave {
  readonly flush: () => Promise<void>;
  readonly snapshot: { readonly status: string };
}

export interface DfdConclusionStepProps {
  readonly processId: string;
  readonly documentId: string;
  /** DOC-03 (selo, versão corrente, ações do documento). */
  readonly document: DocumentDto;
  /** `meta.allowedActions` do DFD-03 (`FINALIZE` = DFD_SUBMIT + POL-02). */
  readonly allowedActions: readonly DocumentAction[];
  readonly process: ProcessDto | undefined;
  /** `null` em modo leitura (sem fila). */
  readonly autosave: ConclusionAutosave | null;
  /** Retentativas automáticas das mutações (padrão do cliente); os testes as zeram. */
  readonly retry?: RetryOptions | undefined;
}

type Phase = 'idle' | 'saving' | 'sending';

/**
 * `DfdConclusionStep` (US-016 · SCR-007 passo 5): o cartão "Pronto para envio" — situação do DFD,
 * destino e aprovador previsto (PRC-08 `approverPreview`), prazo, alertas com "Estou ciente" e a
 * "Mensagem ao aprovador" — com a ação "Concluir e enviar para aprovação" (PRC-19, a transição
 * `FORWARD` para a etapa `APPROVAL` — o painel de encaminhamento em modo resumido) ou, para quem
 * não encaminha mas conclui documentos, "Finalizar DFD" (DOC-10). Antes de enviar, descarrega o
 * autosave e repete o DOC-08 (RN-DFD-42). Concluído, mostra a faixa "Em aprovação" e o PDF da
 * versão (DOC-21/22/23).
 */
export function DfdConclusionStep({
  processId,
  documentId,
  document,
  allowedActions,
  process,
  autosave,
  retry,
}: DfdConclusionStepProps) {
  const t = useTranslations('dfd.conclusion');
  const tDfd = useTranslations('dfd');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const router = useRouter();
  const queryClient = useQueryClient();
  const messageId = useId();
  const validation = useDfdValidation(documentId);
  const actions = useAvailableActions(processId);
  const checklist = useProcessChecklist(processId);
  const forward = useForwardProcess(retry);
  const finalize = useIdempotentMutation({
    mutationFn: (
      variables: {
        readonly version: number;
        readonly expectedDraftRevision: number;
        readonly acknowledged: readonly string[];
      },
      context,
    ) =>
      transitionDocument(
        documentId,
        'finalize',
        {
          acknowledgedWarnings: [...variables.acknowledged],
          expectedDraftRevision: variables.expectedDraftRevision,
        },
        variables.version,
        context,
      ),
    retry,
  });
  const [message, setMessage] = useState('');
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<ConclusionProblem | null>(null);
  const [localError, setLocalError] = useState<'autosave' | 'blocking' | null>(null);

  const inApproval = inApprovalOf(document);
  const concluded = document.status !== 'DRAFT' && document.status !== 'RETURNED';
  const versionPdf =
    concluded && document.currentVersionId && document.currentVersionNumber !== null ? (
      <GeneratePdfButton
        source={{
          kind: 'version',
          versionId: document.currentVersionId,
          versionNumber: document.currentVersionNumber,
        }}
        label={t('pdf', { version: document.currentVersionNumber })}
      />
    ) : null;

  if (concluded) {
    return (
      <div className="flex flex-col gap-4" data-testid="dfd-conclusion-actions">
        {inApproval === null ? (
          <Alert tone="info" title={t('concluded')} />
        ) : (
          <Alert
            tone="info"
            title={
              inApproval.sentAt === null
                ? t('inApproval', { version: inApproval.versionNumber ?? 1 })
                : t('inApprovalSent', {
                    version: inApproval.versionNumber ?? 1,
                    at: formatDateTime(inApproval.sentAt, timeZone),
                  })
            }
          />
        )}
        {versionPdf}
      </div>
    );
  }

  if (validation.data === undefined || actions.data === undefined) {
    return (
      <div role="status">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const mode = conclusionModeOf(actions.data, allowedActions);
  const blocking = validation.data.summary.blocking;
  const transitionId = mode.kind === 'SEND' ? (mode.entry.transitionId ?? null) : null;
  const warnings = conclusionWarnings(validation.data, checklist.data ?? [], transitionId);
  const allAcknowledged = warnings.every((warning) => acknowledged.has(warning.key));
  const tooLong = isMessageTooLong(message);
  const busy = phase !== 'idle';

  const toggle = (key: string, checked: boolean) => {
    setAcknowledged((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const reloadAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'processes', processId) }),
      queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, documentId) }),
      queryClient.invalidateQueries({ queryKey: dfdKeys.detail(tenantId, documentId) }),
    ]);
  };

  const fail = async (error: unknown) => {
    const described = describeConclusionError(error);
    setProblem(described);
    if (described.reload === 'validation') await validation.refetch();
    if (described.reload === 'all') await reloadAll();
  };

  /** RN-DFD-42: fila do autosave vazia e DOC-08 repetido; devolve a validação fresca ou `null`. */
  const prepare = async () => {
    setProblem(null);
    setLocalError(null);
    if (autosave !== null) {
      if (autosave.snapshot.status === 'error' || autosave.snapshot.status === 'conflict') {
        setLocalError('autosave');
        return null;
      }
      setPhase('saving');
      const flushed = await Promise.race([
        autosave.flush().then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, AUTOSAVE_FLUSH_TIMEOUT_MS),
        ),
      ]);
      if (!flushed || autosave.snapshot.status === 'error') {
        setPhase('idle');
        setLocalError('autosave');
        return null;
      }
    }
    setPhase('sending');
    const fresh = (await validation.refetch()).data;
    if (fresh === undefined || fresh.summary.blocking > 0) {
      setPhase('idle');
      setLocalError('blocking');
      return null;
    }
    return fresh;
  };

  const send = async () => {
    const stage = process?.currentStage ?? null;
    if (mode.kind !== 'SEND' || process === undefined || stage === null) return;
    const fresh = await prepare();
    if (fresh === null) return;
    try {
      const result = await forward.submit({
        processId,
        version: process.version,
        body: buildConclusionForwardBody({
          entry: mode.entry,
          expectedStageId: stage.id,
          documentId,
          message,
          acknowledged: [...acknowledged],
        }),
      });
      const code = document.code ?? t('thisDfd');
      toast({
        title: t('sent', {
          code,
          approver: result.approval?.approverLabel ?? mode.entry.approverPreview?.label ?? '',
        }),
        tone: 'success',
      });
      await reloadAll();
      router.push(`/processos/${processId}`);
    } catch (error) {
      await fail(error);
    } finally {
      setPhase('idle');
    }
  };

  const conclude = async () => {
    const fresh = await prepare();
    if (fresh === null) return;
    try {
      const current = await fetchDocument(documentId);
      await finalize.submit({
        version: current.document.version,
        expectedDraftRevision: fresh.draftRevision,
        acknowledged: [...acknowledged],
      });
      toast({ title: t('finalized'), tone: 'success' });
      await reloadAll();
    } catch (error) {
      await fail(error);
    } finally {
      setPhase('idle');
    }
  };

  const entry = mode.kind === 'SEND' ? mode.entry : null;
  const approverUnresolved = entry?.reasons.find((reason) => reason.code === 'APPROVER_UNRESOLVED');
  const selfApproval =
    entry?.approverPreview?.userId !== undefined &&
    entry.approverPreview.userId === session.user.id;
  const disabled =
    busy ||
    blocking > 0 ||
    !allAcknowledged ||
    tooLong ||
    (entry !== null && !entry.enabled) ||
    (mode.kind === 'SEND' && (process?.currentStage ?? null) === null);
  const custodian = process?.currentResponsible?.name ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="dfd-conclusion-actions">
      <div aria-live="polite">
        {blocking === 0 ? (
          <Alert tone="success" title={`✓ ${t('ready')}`} />
        ) : (
          <Alert tone="warning" title={t('pending', { count: blocking })}>
            <p>{t('pendingHint')}</p>
          </Alert>
        )}
      </div>

      {mode.kind === 'NONE' ? (
        <Alert tone="info" title={t('notSender.title')}>
          <p>
            {custodian === null
              ? t('notSender.queue')
              : t('notSender.custodian', { name: custodian })}
          </p>
        </Alert>
      ) : (
        <section
          aria-labelledby="dfd-ready-title"
          className="flex flex-col gap-3 rounded-card border border-border p-4"
        >
          <h3 id="dfd-ready-title" className="font-semibold">
            {mode.kind === 'SEND' ? t('card.title') : t('card.finalizeTitle')}
          </h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
            <dt className="text-muted-foreground">{t('card.document')}</dt>
            <dd>
              {document.code ?? t('thisDfd')} · {tDfd(`readOnly.status.${document.status}`)}
            </dd>
            {entry === null ? null : (
              <>
                <dt className="text-muted-foreground">{t('card.destination')}</dt>
                <dd>
                  {entry.toStageName ?? entry.label}
                  {entry.approverPreview ? ` — ${entry.approverPreview.label}` : ''}
                </dd>
                {entry.dueAtPreview ? (
                  <>
                    <dt className="text-muted-foreground">{t('card.deadline')}</dt>
                    <dd>{t('card.until', { date: formatDate(entry.dueAtPreview, timeZone) })}</dd>
                  </>
                ) : null}
              </>
            )}
          </dl>
          {mode.kind === 'FINALIZE' ? <p className="text-sm">{t('finalizeHint')}</p> : null}
          {approverUnresolved ? (
            <Alert tone="error" title={t('errors.approverUnresolved')}>
              <p>{approverUnresolved.message}</p>
            </Alert>
          ) : null}
          {selfApproval ? <Alert tone="info" title={t('selfApproval')} /> : null}

          {warnings.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold">{t('warnings.title')}</legend>
              {warnings.map((warning) => {
                const id = `${messageId}-warning-${warning.key}`;
                return (
                  <div
                    key={warning.key}
                    className={`flex flex-col gap-1 rounded-control border p-3 text-sm ${
                      problem?.key === 'warnings' && !acknowledged.has(warning.key)
                        ? 'border-warning'
                        : 'border-border'
                    }`}
                  >
                    <p>
                      <span aria-hidden="true">⚠ </span>
                      {warning.message}
                    </p>
                    <label htmlFor={id} className="flex items-center gap-2">
                      <input
                        id={id}
                        type="checkbox"
                        checked={acknowledged.has(warning.key)}
                        disabled={busy}
                        onChange={(event) => {
                          toggle(warning.key, event.target.checked);
                        }}
                      />
                      {t('warnings.acknowledge')}
                      <span className="sr-only">: {warning.message}</span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}

          {mode.kind === 'SEND' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={messageId} className="text-sm font-medium">
                {t('message.label')}
              </label>
              <textarea
                id={messageId}
                className={TEXTAREA_CLASS}
                rows={3}
                value={message}
                disabled={busy}
                aria-invalid={tooLong}
                aria-describedby={`${messageId}-hint`}
                onChange={(event) => {
                  setMessage(event.target.value);
                }}
              />
              <p
                id={`${messageId}-hint`}
                className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {tooLong
                  ? t('message.tooLong')
                  : t('message.hint', {
                      count: message.trim().length,
                      max: PROCESS_FORWARD_LIMITS.commentMax,
                    })}
              </p>
            </div>
          ) : null}
        </section>
      )}

      <div role="status" aria-live="polite">
        {phase === 'saving' ? <p className="text-sm">{t('saving')}</p> : null}
        {localError === 'autosave' ? <Alert tone="error" title={t('errors.autosave')} /> : null}
        {localError === 'blocking' ? <Alert tone="error" title={t('errors.blocked')} /> : null}
        {problem === null ? null : (
          <Alert tone="error" title={problem.detail ?? t(`errors.${problem.key}`)}>
            {problem.correlationId !== null && problem.key === 'unavailable' ? (
              <p className="text-xs text-muted-foreground">
                {t('errors.correlation', { id: problem.correlationId })}
              </p>
            ) : null}
          </Alert>
        )}
      </div>

      {mode.kind === 'NONE' ? null : (
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border bg-background py-3">
          {mode.kind === 'SEND' ? (
            <Button variant="primary" disabled={disabled} onClick={() => void send()}>
              {phase === 'sending' ? t('sending') : t('send')}
            </Button>
          ) : (
            <Button variant="primary" disabled={disabled} onClick={() => void conclude()}>
              {phase === 'sending' ? t('finalizing') : t('finalize')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
