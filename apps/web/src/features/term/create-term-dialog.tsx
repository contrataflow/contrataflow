'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  buttonClassName,
  cx,
  toast,
} from '@contrataflow/ui';
import { TERM_MESSAGES, termCreateSchema } from '@contrataflow/validation';
import type { TermCreate } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { ApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { activeTermOf, createTerm, termHref, useProcessTerms } from './term.api';
import {
  processDocumentKeys,
  useActiveDocumentTypes,
  useProcessDocuments,
} from '../process-documents/process-documents.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';

/** Resultado de uma tentativa recusada pelo servidor (a faixa acima do formulário). */
type Outcome =
  | { readonly kind: 'exists'; readonly termId: string | null }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'invalidStatus' }
  | { readonly kind: 'typeNotAllowed' }
  | { readonly kind: 'validation' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'failed'; readonly correlationId: string | null };

interface FieldErrors {
  readonly templateId?: string;
  readonly title?: string;
}

/** `meta.existingTermId` do 409 `DOCUMENT_ALREADY_EXISTS` (o "Abrir TR existente"). */
function existingTermId(error: ApiError): string | null {
  const meta = (error.problem?.meta ?? {}) as { existingTermId?: unknown };
  return typeof meta.existingTermId === 'string' ? meta.existingTermId : null;
}

/** V-01/V-02: os erros por campo do 422 `VALIDATION_ERROR`. */
function serverFieldErrors(error: ApiError): FieldErrors {
  const result: { templateId?: string; title?: string } = {};
  for (const item of error.errors) {
    if (item.field === 'templateId') result.templateId = TERM_MESSAGES.templateInvalid;
    if (item.field === 'title') result.title = TERM_MESSAGES.titleLength;
  }
  return result;
}

function outcomeOf(error: unknown): Outcome {
  if (!isApiError(error)) return { kind: 'failed', correlationId: null };
  if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
    return { kind: 'exists', termId: existingTermId(error) };
  }
  if (error.code === 'NOT_PROCESS_CUSTODIAN') {
    return { kind: 'forbidden', message: TERM_MESSAGES.notCustodian };
  }
  if (error.status === 403) return { kind: 'forbidden', message: TERM_MESSAGES.permissionDenied };
  if (error.code === 'INVALID_PROCESS_STATUS' || error.code === 'DOCUMENT_NOT_EDITABLE') {
    return { kind: 'invalidStatus' };
  }
  if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') return { kind: 'typeNotAllowed' };
  if (error.status === 422 && error.code === 'VALIDATION_ERROR') return { kind: 'validation' };
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'reused' };
  if (error.status === 503) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'failed', correlationId: error.correlationId };
}

export interface CreateTermDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `CreateTermDialog` (US-036 · fluxo principal 2–5): TRM-01 traz os modelos de TR publicados (o
 * padrão pré-selecionado — FA-01) e o título padrão; TRM-02 leva uma `Idempotency-Key` por abertura
 * (renovada só se o corpo mudar ou a chave for recusada). Sem modelo publicado o envio fica
 * desabilitado. Sucesso: invalida os documentos do processo e navega para a SCR-012. Montado só
 * enquanto aberto: cada abertura começa do zero.
 */
export function CreateTermDialog({ processId, open, onOpenChange }: CreateTermDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <DialogBody processId={processId} onOpenChange={onOpenChange} /> : null}
    </Dialog>
  );
}

function DialogBody({
  processId,
  onOpenChange,
}: {
  readonly processId: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('term.create');
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const invalidateProcess = useInvalidateProcess(processId);
  const terms = useProcessTerms(processId);
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  // Uma `Idempotency-Key` por abertura; só muda se o corpo enviado mudar (ou for recusada).
  const attempt = useRef<{ readonly json: string; readonly key: string } | null>(null);

  const meta = terms.data?.meta;
  const templates = meta?.templates ?? [];
  const defaultTemplate = templates.find((template) => template.isDefault) ?? templates[0];
  const templateId = templateDraft ?? defaultTemplate?.id ?? '';
  const title = titleDraft ?? meta?.defaultTitle ?? '';
  const noTemplate = terms.data !== undefined && templates.length === 0;
  const errors: FieldErrors = { ...clientErrors, ...serverErrors };

  const submit = useMutation({
    mutationFn: (body: TermCreate) => {
      const json = JSON.stringify(body);
      if (attempt.current?.json !== json) attempt.current = { json, key: newIdempotencyKey() };
      return createTerm(processId, body, attempt.current.key);
    },
    onSuccess: (term) => {
      toast({
        title:
          term.code === null ? t('toast.createdNoCode') : t('toast.created', { code: term.code }),
        tone: 'success',
      });
      void queryClient.invalidateQueries({
        queryKey: processDocumentKeys.list(tenantId, processId),
      });
      void invalidateProcess();
      onOpenChange(false);
      router.push(termHref(processId, term.id));
    },
    onError: (error: unknown) => {
      const next = outcomeOf(error);
      setOutcome(next);
      if (next.kind === 'validation' && isApiError(error))
        setServerErrors(serverFieldErrors(error));
      if (next.kind === 'reused') attempt.current = null;
      if (['exists', 'forbidden', 'invalidStatus', 'typeNotAllowed'].includes(next.kind)) {
        // O estado do processo mudou: o painel recalcula o que o usuário pode criar.
        void invalidateProcess();
      }
    },
  });

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (submit.isPending || noTemplate || terms.data === undefined) return;
    setOutcome(null);
    setServerErrors({});
    const parsed = termCreateSchema.safeParse({
      ...(templateId === '' ? {} : { templateId }),
      title,
    });
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
      setClientErrors({
        ...(fields.has('templateId') ? { templateId: TERM_MESSAGES.templateInvalid } : {}),
        ...(fields.has('title') ? { title: TERM_MESSAGES.titleLength } : {}),
      });
      return;
    }
    setClientErrors({});
    submit.mutate(parsed.data);
  };

  let body: ReactNode;
  if (terms.data === undefined) {
    body = terms.isPending ? (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    ) : (
      <Alert tone="error" title={t('loadError')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void terms.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (noTemplate) {
    body = <Alert tone="warning" title={TERM_MESSAGES.noTemplate} />;
  } else {
    body = (
      <>
        <FormField id="term-template" label={t('fields.template')} error={errors.templateId}>
          {(control) => (
            <select
              {...control}
              className={INPUT_CLASS}
              value={templateId}
              disabled={submit.isPending}
              onChange={(event) => {
                setTemplateDraft(event.target.value);
                setServerErrors(({ templateId: _removed, ...rest }) => rest);
                setClientErrors(({ templateId: _removed, ...rest }) => rest);
              }}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.isDefault
                    ? t('fields.templateDefault', { name: template.name })
                    : template.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField id="term-title" label={t('fields.title')} required error={errors.title}>
          {(control) => (
            <input
              {...control}
              type="text"
              className={INPUT_CLASS}
              value={title}
              maxLength={300}
              disabled={submit.isPending}
              onChange={(event) => {
                setTitleDraft(event.target.value);
                setServerErrors(({ title: _removed, ...rest }) => rest);
                setClientErrors(({ title: _removed, ...rest }) => rest);
              }}
            />
          )}
        </FormField>
      </>
    );
  }

  return (
    <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
      <form className="flex min-w-0 flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div aria-live="polite">
          <OutcomeAlert processId={processId} outcome={outcome} onNavigate={onOpenChange} />
        </div>
        {body}
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            disabled={
              terms.data === undefined ||
              noTemplate ||
              submit.isPending ||
              outcome?.kind === 'exists'
            }
          >
            {submit.isPending ? t('submitting') : t('submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function OutcomeAlert({
  processId,
  outcome,
  onNavigate,
}: {
  readonly processId: string;
  readonly outcome: Outcome | null;
  readonly onNavigate: (open: boolean) => void;
}) {
  const t = useTranslations('term.create');
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'exists':
      return (
        <Alert tone="info" title={TERM_MESSAGES.alreadyExists}>
          {outcome.termId === null ? null : (
            <Link
              href={termHref(processId, outcome.termId)}
              className={cx(buttonClassName({ variant: 'secondary', size: 'sm' }), 'mt-2')}
              onClick={() => {
                onNavigate(false);
              }}
            >
              {t('openExisting')}
            </Link>
          )}
        </Alert>
      );
    case 'forbidden':
      return <Alert tone="error" title={outcome.message} />;
    case 'invalidStatus':
      return <Alert tone="error" title={TERM_MESSAGES.processNotEditable} />;
    case 'typeNotAllowed':
      return <Alert tone="error" title={TERM_MESSAGES.typeNotAllowedInStage} />;
    case 'validation':
      return <Alert tone="error" title={t('validation')} />;
    case 'reused':
      return <Alert tone="error" title={t('reused')} />;
    case 'unavailable':
      return (
        <Alert tone="error" title={t('unavailable')}>
          {outcome.correlationId === null ? null : (
            <p className="mt-1 text-xs">{outcome.correlationId}</p>
          )}
        </Alert>
      );
    case 'failed':
      return (
        <Alert
          tone="error"
          title={
            outcome.correlationId === null
              ? t('failed')
              : t('failedWithCode', { correlationId: outcome.correlationId })
          }
        />
      );
  }
}

/**
 * `CreateTermButton` no painel do processo (SCR-006 · fluxo principal 1): exibido só quando o DOC-01
 * diz que o usuário pode criar o tipo `TERM_OF_REFERENCE` agora (`meta.creatableTypeIds` —
 * `TERM_CREATE` + POL-02 + etapa + sem TR ativo). Com TR ativo (TRM-01 — FA-02) vira o link "Abrir
 * Termo de Referência".
 */
export function CreateTermButton({ processId }: { readonly processId: string }) {
  const t = useTranslations('term.create');
  const documents = useProcessDocuments(processId);
  const types = useActiveDocumentTypes();
  const termType = types.data?.find((type) => type.systemModule === 'TERM_OF_REFERENCE');
  const terms = useProcessTerms(processId, termType !== undefined);
  const existing = activeTermOf(terms.data);
  const [open, setOpen] = useState(false);
  const creatable =
    termType !== undefined && documents.data?.meta.creatableTypeIds.includes(termType.id) === true;

  return (
    <>
      {existing === null ? null : (
        <Link
          href={termHref(processId, existing.id)}
          className={buttonClassName({ variant: 'secondary', size: 'sm' })}
        >
          {existing.code === null ? t('openNoCode') : t('open', { code: existing.code })}
        </Link>
      )}
      {existing === null && creatable ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('action')}
        </Button>
      ) : null}
      <CreateTermDialog processId={processId} open={open} onOpenChange={setOpen} />
    </>
  );
}
