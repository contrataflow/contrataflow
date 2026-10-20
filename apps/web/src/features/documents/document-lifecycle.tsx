'use client';

import type { DocumentDto, DocumentMeta, Violation } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { AcknowledgeWarningsDialog } from './acknowledge-warnings-dialog';
import { CompletenessPanel } from './completeness-panel';
import { DeleteDraftDialog } from './delete-draft-dialog';
import { DocumentActionsBar } from './document-actions-bar';
import type { LifecycleAction } from './document-actions-bar';
import { endsFlow } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import { CancelDialog, ReopenDialog } from './reason-dialog';
import { useDocumentLifecycle } from './use-document-lifecycle';
import type { TransitionRequest } from './use-document-lifecycle';

type Flow =
  | {
      readonly kind: 'check';
      readonly action: 'FINALIZE' | 'SUBMIT';
      /** `violations[]` do 422: valem no lugar da consulta de pendências. */
      readonly violationsFromError: readonly Violation[] | null;
      /** Avisos do `AcknowledgeWarningsDialog` aberto sobre o painel (só avisos); `null` = fechado. */
      readonly acknowledging: readonly Violation[] | null;
    }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'delete' }
  | null;

export interface DocumentLifecycleProps {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
  /**
   * Onde o foco cai quando o botão que abriu o fluxo saiu da tela (o status mudou): o título da
   * página. Precisa ter identidade estável.
   */
  readonly fallbackFocus: () => void;
}

/** Impede o Radix de devolver o foco sozinho: a devolução é de `DocumentLifecycle`. */
const keepFocus = (event: Event) => {
  event.preventDefault();
};

type TypedLabels = {
  readonly actions: Partial<Record<LifecycleAction, string>>;
  readonly toasts: Partial<Record<TransitionRequest['action'], string>>;
} | null;

/**
 * Rótulos próprios do ciclo de vida por módulo tipado (`documents.typed.<módulo>`) — US-023:
 * "Concluir ETP"; US-039: "Concluir TR"/"Submeter para aprovação" e os toasts "TR concluído"/"TR
 * enviado para aprovação". Ausente = os genéricos.
 */
function useTypedLabels(systemModule: DocumentDto['documentType']['systemModule']): TypedLabels {
  const t = useTranslations('documents.typed');
  if (systemModule === 'ETP') {
    return { actions: { FINALIZE: t('ETP.FINALIZE') }, toasts: { FINALIZE: t('ETP.finalized') } };
  }
  if (systemModule === 'TERM_OF_REFERENCE') {
    return {
      actions: {
        FINALIZE: t('TERM_OF_REFERENCE.FINALIZE'),
        SUBMIT: t('TERM_OF_REFERENCE.SUBMIT'),
      },
      toasts: {
        FINALIZE: t('TERM_OF_REFERENCE.finalized'),
        SUBMIT: t('TERM_OF_REFERENCE.submitted'),
      },
    };
  }
  return null;
}

/**
 * Ciclo de vida do documento na SCR-105 (US-065): `DocumentActionsBar` e o fluxo que cada ação
 * abre — painel de pendências (Finalizar/Submeter) com o diálogo de reconhecimento de avisos,
 * `ReopenDialog`, `CancelDialog` e a confirmação de exclusão. Quem manda é a API: os botões vêm de
 * `meta.allowedActions` e toda recusa (412, 409, 403, 422) volta como o estado novo da tela.
 */
export function DocumentLifecycle({ document, meta, fallbackFocus }: DocumentLifecycleProps) {
  const typed = useTypedLabels(document.documentType.systemModule);
  const lifecycle = useDocumentLifecycle(document, typed?.toasts);
  const [flow, setFlow] = useState<Flow>(null);
  const [feedback, setFeedback] = useState<DocumentOutcome | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const lastRequest = useRef<TransitionRequest | null>(null);

  // Foco ao fim de um fluxo: o botão que o abriu ou, se saiu da tela, o título da página. Roda
  // depois do commit e do `setTimeout` do Radix, para que ninguém o tire do lugar.
  useEffect(() => {
    if (focusTick === 0) return undefined;
    const timer = setTimeout(() => {
      const target = opener.current;
      if (target?.isConnected) target.focus();
      else fallbackFocus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [focusTick, fallbackFocus]);

  const endFlow = () => {
    setFlow(null);
    setFeedback(null);
    setFocusTick((tick) => tick + 1);
  };

  const open = (action: LifecycleAction, element: HTMLElement | null) => {
    opener.current = element;
    lastRequest.current = null;
    setFeedback(null);
    if (action === 'FINALIZE' || action === 'SUBMIT') {
      setFlow({ kind: 'check', action, violationsFromError: null, acknowledging: null });
    } else if (action === 'REOPEN') {
      setFlow({ kind: 'reopen' });
    } else if (action === 'CANCEL') {
      setFlow({ kind: 'cancel' });
    } else {
      setFlow({ kind: 'delete' });
    }
  };

  const execute = async (request: TransitionRequest) => {
    lastRequest.current = request;
    setFeedback(null);
    const result = await lifecycle.run(request);
    if (result.status === 'busy') return;
    if (result.status === 'done') {
      // O botão que abriu o fluxo costuma sair da tela (o status mudou): o foco vai ao título.
      opener.current = null;
      endFlow();
      return;
    }
    const { outcome } = result;
    if (outcome.kind === 'incomplete') {
      // 422: o painel reabre com as `violations` do corpo do erro (bloqueantes ou avisos).
      setFlow((current) =>
        current?.kind === 'check'
          ? {
              ...current,
              violationsFromError: outcome.violations.length > 0 ? outcome.violations : null,
              acknowledging: null,
            }
          : current,
      );
      return;
    }
    if (endsFlow(outcome)) {
      // 412, 409, 403…: o documento já foi recarregado; o que estava aberto não vale mais.
      opener.current = null;
      endFlow();
      return;
    }
    setFeedback(outcome);
  };

  const retry = () => {
    if (lastRequest.current) void execute(lastRequest.current);
  };

  const check = flow?.kind === 'check' ? flow : null;
  const acknowledging = check?.acknowledging ?? null;

  return (
    <>
      <DocumentActionsBar
        allowedActions={meta.allowedActions}
        busy={lifecycle.pending}
        labels={typed?.actions}
        onAction={open}
      />

      {check ? (
        <CompletenessPanel
          // Outra ação, outra consulta: o painel nasce do zero.
          key={check.action}
          documentId={document.id}
          action={check.action}
          violationsFromError={check.violationsFromError}
          pending={lifecycle.pending}
          feedback={acknowledging ? null : feedback}
          onConfirm={() => {
            void execute({ action: check.action, acknowledgedWarnings: [] });
          }}
          onContinue={(warnings) => {
            setFeedback(null);
            setFlow({ ...check, acknowledging: warnings });
          }}
          onRetry={retry}
          onClose={endFlow}
        />
      ) : null}
      <AcknowledgeWarningsDialog
        open={acknowledging !== null}
        action={check?.action ?? 'FINALIZE'}
        warnings={acknowledging ?? []}
        pending={lifecycle.pending}
        feedback={acknowledging ? feedback : null}
        onConfirm={(acknowledgedWarnings) => {
          if (check) void execute({ action: check.action, acknowledgedWarnings });
        }}
        onRetry={retry}
        onCancel={() => {
          // Volta ao painel; o Radix devolve o foco a "Continuar".
          if (check) setFlow({ ...check, acknowledging: null });
          setFeedback(null);
        }}
      />

      <ReopenDialog
        open={flow?.kind === 'reopen'}
        pending={lifecycle.pending}
        feedback={flow?.kind === 'reopen' ? feedback : null}
        onSubmit={(reopenReason) => {
          void execute({ action: 'REOPEN', reopenReason });
        }}
        onRetry={retry}
        onClose={endFlow}
        onCloseAutoFocus={keepFocus}
      />
      <CancelDialog
        open={flow?.kind === 'cancel'}
        pending={lifecycle.pending}
        feedback={flow?.kind === 'cancel' ? feedback : null}
        onSubmit={(cancellationReason) => {
          void execute({ action: 'CANCEL', cancellationReason });
        }}
        onRetry={retry}
        onClose={endFlow}
        onCloseAutoFocus={keepFocus}
      />
      <DeleteDraftDialog
        open={flow?.kind === 'delete'}
        pending={lifecycle.pending}
        feedback={flow?.kind === 'delete' ? feedback : null}
        onConfirm={() => {
          void execute({ action: 'DELETE' });
        }}
        onClose={endFlow}
        onCloseAutoFocus={keepFocus}
      />
    </>
  );
}
