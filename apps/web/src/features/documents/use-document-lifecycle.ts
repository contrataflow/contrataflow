'use client';

import { toast } from '@contrataflow/ui';
import { DOCUMENT_MESSAGES } from '@contrataflow/validation';
import type { DocumentDto, DocumentTransition } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';

import { newCorrelationId, newIdempotencyKey, retryIdempotent } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { describeDocumentError } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import {
  cancelDocument,
  deleteDocument,
  documentKeys,
  processDocumentsHref,
  reopenDocument,
  transitionDocument,
} from './documents.api';
import type { DocumentResult } from './documents.api';
import { processActionKeys } from '../process-actions/process-actions.api';

export type TransitionRequest =
  | {
      readonly action: 'FINALIZE' | 'SUBMIT';
      /** Códigos dos avisos de DOC-08 reconhecidos pelo usuário. */
      readonly acknowledgedWarnings: readonly string[];
    }
  | { readonly action: 'REOPEN'; readonly reopenReason: string }
  | { readonly action: 'CANCEL'; readonly cancellationReason: string }
  | { readonly action: 'DELETE' };

export type TransitionResult =
  | { readonly status: 'done' }
  | { readonly status: 'busy' }
  | { readonly status: 'failed'; readonly outcome: DocumentOutcome };

interface Intent {
  readonly fingerprint: string;
  readonly context: IdempotentContext;
}

/** Falhas em que o servidor pode ter (ou não) concluído: a repetição leva a mesma chave. */
function keepsIntent(outcome: DocumentOutcome): boolean {
  return outcome.kind === 'unavailable' || outcome.kind === 'unexpected';
}

/**
 * Executa as transições do ciclo de vida do documento (DOC-09/10/12/13/14) e aplica os efeitos
 * comuns do resultado (US-065): toast e refetch no sucesso; no erro, o que a política pede — toast
 * e refetch para 412, 409 e 403; os desfechos que o painel ou o diálogo mostram em linha voltam
 * para quem chamou. `Idempotency-Key`: uma por tentativa de finalizar/submeter, reaproveitada na
 * repetição da mesma intenção ("Tentar novamente" após 503) e trocada quando a intenção muda.
 */
export function useDocumentLifecycle(document: DocumentDto) {
  const t = useTranslations('documents');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const intents = useRef(new Map<string, Intent>());
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const { id: documentId, processId, version } = document;

  const refetchDocument = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(tenantId, documentId) });
    void queryClient.invalidateQueries({ queryKey: processActionKeys.all(tenantId, processId) });
  }, [queryClient, tenantId, documentId, processId]);

  const intentFor = useCallback(
    (request: Extract<TransitionRequest, { action: 'FINALIZE' | 'SUBMIT' }>): IdempotentContext => {
      const fingerprint = JSON.stringify([request.action, version, request.acknowledgedWarnings]);
      const current = intents.current.get(request.action);
      if (current?.fingerprint === fingerprint) return current.context;
      const context = { idempotencyKey: newIdempotencyKey(), correlationId: newCorrelationId() };
      intents.current.set(request.action, { fingerprint, context });
      return context;
    },
    [version],
  );

  const send = useCallback(
    async (request: TransitionRequest): Promise<DocumentResult | null> => {
      switch (request.action) {
        case 'FINALIZE':
        case 'SUBMIT': {
          const context = intentFor(request);
          const body: DocumentTransition =
            request.acknowledgedWarnings.length > 0
              ? { acknowledgedWarnings: [...request.acknowledgedWarnings] }
              : {};
          return retryIdempotent(() =>
            transitionDocument(
              documentId,
              request.action === 'FINALIZE' ? 'finalize' : 'submit',
              body,
              version,
              context,
            ),
          );
        }
        case 'REOPEN':
          return reopenDocument(documentId, { reopenReason: request.reopenReason }, version);
        case 'CANCEL':
          return cancelDocument(
            documentId,
            { cancellationReason: request.cancellationReason },
            version,
          );
        case 'DELETE':
          await deleteDocument(documentId, version);
          return null;
      }
    },
    [documentId, version, intentFor],
  );

  /** Efeito global do desfecho de uma falha (toast, recarga, redirecionamento). */
  const applyOutcome = useCallback(
    (outcome: DocumentOutcome): void => {
      switch (outcome.kind) {
        case 'conflict':
          toast({ title: DOCUMENT_MESSAGES.versionConflict, tone: 'error' });
          refetchDocument();
          return;
        case 'invalidState':
          toast({ title: outcome.detail ?? DOCUMENT_MESSAGES.invalidState, tone: 'error' });
          refetchDocument();
          return;
        case 'forbidden':
          toast({ title: outcome.detail ?? t('errors.forbidden'), tone: 'error' });
          // O que o usuário pode fazer mudou (ex.: perdeu a custódia): vem um `allowedActions` novo.
          refetchDocument();
          return;
        case 'notFound':
          toast({ title: t('errors.notFound'), tone: 'error' });
          router.push(`/processos/${processId}`);
          return;
        case 'rateLimited':
          toast({ title: t('errors.rateLimited'), tone: 'info' });
          return;
        case 'redirect':
          window.location.assign(outcome.href);
          return;
        case 'incomplete':
          // A validação em cache ficou velha; o painel mostra as `violations` do erro enquanto refaz.
          void queryClient.invalidateQueries({
            queryKey: documentKeys.validation(tenantId, documentId),
          });
          return;
        case 'field':
        case 'unavailable':
        case 'silent':
        case 'unexpected':
          return;
      }
    },
    [t, router, processId, queryClient, tenantId, documentId, refetchDocument],
  );

  const run = useCallback(
    async (request: TransitionRequest): Promise<TransitionResult> => {
      if (running.current) return { status: 'busy' };
      running.current = true;
      setPending(true);
      let result: DocumentResult | null;
      try {
        result = await send(request);
      } catch (error) {
        const outcome = describeDocumentError(
          error,
          `${window.location.pathname}${window.location.search}`,
        );
        if (!keepsIntent(outcome)) intents.current.delete(request.action);
        applyOutcome(outcome);
        return { status: 'failed', outcome };
      } finally {
        running.current = false;
        setPending(false);
      }

      intents.current.delete(request.action);
      toast({ title: t(`toasts.${request.action}`), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: processActionKeys.all(tenantId, processId) });
      if (request.action === 'DELETE') {
        queryClient.removeQueries({ queryKey: documentKeys.all(tenantId, documentId) });
        router.push(processDocumentsHref(processId));
      } else {
        // A resposta já traz o documento novo; o refetch confirma e traz o `allowedActions` atual.
        // As transições não trazem `meta.template` (US-063): fica o lido no DOC-03.
        if (result) {
          queryClient.setQueryData<DocumentResult>(
            documentKeys.detail(tenantId, documentId),
            (previous) =>
              previous?.meta.template === undefined
                ? result
                : { ...result, meta: { ...result.meta, template: previous.meta.template } },
          );
        }
        void queryClient.invalidateQueries({ queryKey: documentKeys.detail(tenantId, documentId) });
      }
      return { status: 'done' };
    },
    [send, applyOutcome, t, queryClient, tenantId, processId, documentId, router],
  );

  return { run, pending };
}
