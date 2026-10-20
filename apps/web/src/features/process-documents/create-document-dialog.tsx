'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { DOCUMENT_LIMITS, DOCUMENT_MESSAGES } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { describeDocumentError } from '@/features/documents/document-errors';
import type { DocumentOutcome } from '@/features/documents/document-errors';
import { OutcomeAlert } from '@/features/documents/outcome-alert';
import { createProcessDocument } from '@/features/documents/uploaded-documents.api';
import { useReturnFocus } from '@/features/documents/use-return-focus';
import { OwnerLookup } from '@/features/risks/owner-lookup';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import type { PanelType } from './process-documents-model';
import { processDocumentKeys } from './process-documents.api';

export interface CreateDocumentDialogProps {
  readonly processId: string;
  readonly type: PanelType;
  readonly onClose: () => void;
}

/**
 * `CreateDocumentDialog` (US-063/US-064 · fluxo principal 1–3): título obrigatório (5–250
 * caracteres, contador e erro por `aria-describedby`) e, no livre, o responsável opcional (USR-02;
 * em branco = quem cria — RN-DOC-26) → DOC-02 com `Idempotency-Key` por intenção ("Tentar
 * novamente" após 503 repete a chave, sem duplicar — FA-04) → SCR-105 do documento criado: o editor
 * de seções (livre) ou o modo "Enviar arquivo" (externo). 403/404/409/422 da API aparecem no
 * diálogo; o menu volta a ser lido do DOC-01.
 */
export function CreateDocumentDialog({ processId, type, onClose }: CreateDocumentDialogProps) {
  const t = useTranslations('documents.create');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus();
  const freeText = type.kind === 'FREE_TEXT';
  const [title, setTitle] = useState('');
  const [responsible, setResponsible] = useState({ id: '', name: '' });
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DocumentOutcome | null>(null);

  const mutation = useIdempotentMutation({
    mutationFn: (
      body: { documentTypeId: string; title: string; responsibleId?: string },
      context,
    ) => createProcessDocument(processId, body, context),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: processDocumentKeys.list(tenantId, processId),
      });
      router.push(`/processos/${processId}/documentos/${result.document.id}`);
    },
  });

  const confirm = async () => {
    const trimmed = title.trim();
    if (trimmed.length < DOCUMENT_LIMITS.titleMin || trimmed.length > DOCUMENT_LIMITS.titleMax) {
      setError(DOCUMENT_MESSAGES.titleLength);
      field.current?.focus();
      return;
    }
    setError(null);
    setFeedback(null);
    try {
      await mutation.submit({
        documentTypeId: type.id,
        title: trimmed,
        ...(freeText && responsible.id !== '' ? { responsibleId: responsible.id } : {}),
      });
    } catch (failure) {
      const outcome = describeDocumentError(failure, pathname);
      if (outcome.kind === 'field') {
        setError(outcome.message);
        field.current?.focus();
        return;
      }
      if (outcome.kind === 'redirect') {
        router.push(outcome.href);
        return;
      }
      setFeedback(outcome);
    }
  };

  const pending = mutation.isPending;
  const describedBy = [`${id}-hint`, `${id}-count`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          returnFocus.remember();
          event.preventDefault();
          field.current?.focus();
        }}
        onCloseAutoFocus={returnFocus.restore}
      >
        <DialogTitle>{t('title', { type: type.name })}</DialogTitle>
        <DialogDescription>{t(freeText ? 'descriptionFreeText' : 'description')}</DialogDescription>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-field`} className="text-sm font-medium">
              {t('label')}
            </label>
            <input
              id={`${id}-field`}
              ref={field}
              required
              maxLength={DOCUMENT_LIMITS.titleMax + 50}
              className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
              value={title}
              aria-invalid={error !== null}
              aria-describedby={describedBy}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
            />
            <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
              <p id={`${id}-hint`}>{t('hint')}</p>
              <p id={`${id}-count`}>
                {t('count', { count: title.trim().length, max: DOCUMENT_LIMITS.titleMax })}
              </p>
            </div>
            {error ? (
              <p id={`${id}-error`} className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          {freeText ? (
            <div className="flex flex-col gap-1">
              <OwnerLookup
                id={`${id}-responsible`}
                kind="USER"
                value={responsible.id}
                name={responsible.name}
                disabled={pending}
                onChange={(userId, name) => {
                  setResponsible({ id: userId, name });
                }}
              />
              <p className="text-xs text-muted-foreground">{t('responsibleDefault')}</p>
            </div>
          ) : null}

          <div aria-live="assertive">
            {feedback?.kind === 'forbidden' || feedback?.kind === 'invalidState' ? (
              // 403 (POL-02) e 409 (processo fora de edição, tipo singular já criado): o motivo da API.
              <Alert tone="error" title={feedback.detail ?? t('notAllowed')} />
            ) : feedback?.kind === 'notFound' ? (
              <Alert tone="error" title={t('notFound')} />
            ) : feedback ? (
              <OutcomeAlert
                outcome={feedback}
                onRetry={() => {
                  void confirm();
                }}
              />
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
              {pending ? t('working') : t(freeText ? 'confirmFreeText' : 'confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
