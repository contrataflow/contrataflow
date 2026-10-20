'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import {
  DOCUMENT_VERSION_LIMITS,
  DOCUMENT_VERSION_MESSAGES,
  documentVersionCreateSchema,
} from '@contrataflow/validation';
import type { DocumentDto } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { describeDocumentError, endsFlow } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import { documentKeys, saveDocumentVersion } from './documents.api';
import { OutcomeAlert } from './outcome-alert';
import { useReturnFocus } from './use-return-focus';

export interface SaveVersionActionProps {
  readonly document: DocumentDto;
}

/**
 * "Salvar versão" (US-066 · DOC-16) sobre a SCR-105: botão + `SaveVersionDialog` com o resumo
 * opcional da alteração (até 500 caracteres, contador e erro ligados por `aria-describedby`).
 * Quem decide mostrar o botão é a tela (POL-02 via `meta.allowedActions` e tipo não `UPLOADED`);
 * a API confere de novo. Sucesso → toast "Versão {n} salva" e o documento/lista recarregados.
 * `Idempotency-Key` por intenção: "Tentar novamente" após 503 repete a mesma chave.
 */
export function SaveVersionAction({ document }: SaveVersionActionProps) {
  const t = useTranslations('documents.versions');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('save')}
      </Button>
      {open ? (
        <SaveVersionDialog
          document={document}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SaveVersionDialog({
  document,
  onClose,
}: {
  readonly document: DocumentDto;
  readonly onClose: () => void;
}) {
  const t = useTranslations('documents.versions');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useReturnFocus();
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DocumentOutcome | null>(null);
  const lastBody = useRef<{ changeSummary?: string }>({});

  const mutation = useIdempotentMutation({
    mutationFn: (body: { changeSummary?: string }, context) =>
      saveDocumentVersion(document.id, body, context),
    onSuccess: (version) => {
      toast({ title: t('saved', { number: version.versionNumber }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, document.id) });
      onClose();
    },
  });

  const send = async (body: { changeSummary?: string }) => {
    lastBody.current = body;
    setFeedback(null);
    try {
      await mutation.submit(body);
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
      if (endsFlow(outcome)) {
        // 409/403/404: a ação não vale mais para o estado atual — mostra o motivo e recarrega.
        const detail =
          outcome.kind === 'invalidState' || outcome.kind === 'forbidden' ? outcome.detail : null;
        if (outcome.kind !== 'silent') toast({ title: detail ?? t('notAllowed'), tone: 'error' });
        void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, document.id) });
        onClose();
        return;
      }
      setFeedback(outcome);
    }
  };

  const confirm = () => {
    const parsed = documentVersionCreateSchema.safeParse({ changeSummary: summary });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? DOCUMENT_VERSION_MESSAGES.changeSummaryTooLong);
      field.current?.focus();
      return;
    }
    setError(null);
    const text = parsed.data.changeSummary ?? '';
    void send(text === '' ? {} : { changeSummary: text });
  };

  const describedBy = [`${id}-hint`, `${id}-count`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  const pending = mutation.isPending;

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
        <DialogTitle>{t('dialog.title')}</DialogTitle>
        <DialogDescription>{t('dialog.description')}</DialogDescription>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-field`} className="text-sm font-medium">
            {t('dialog.label')}
          </label>
          <textarea
            id={`${id}-field`}
            ref={field}
            rows={3}
            className="rounded-control border border-border bg-surface px-3 py-2 text-sm"
            value={summary}
            aria-invalid={error !== null}
            aria-describedby={describedBy}
            onChange={(event) => {
              setSummary(event.target.value);
              setError(null);
            }}
          />
          <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
            <p id={`${id}-hint`}>{t('dialog.hint')}</p>
            <p id={`${id}-count`}>
              {t('dialog.count', {
                count: summary.trim().length,
                max: DOCUMENT_VERSION_LIMITS.changeSummaryMax,
              })}
            </p>
          </div>
          {error ? (
            <p id={`${id}-error`} className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div aria-live="assertive">
          {feedback ? (
            <OutcomeAlert
              outcome={feedback}
              onRetry={() => {
                void send(lastBody.current);
              }}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" disabled={pending} aria-busy={pending} onClick={confirm}>
            {pending ? t('dialog.working') : t('dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
