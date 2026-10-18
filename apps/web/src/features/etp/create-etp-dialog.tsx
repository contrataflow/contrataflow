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
import type { ImportableDfdDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { ApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { activeEtpOf, createEtp, etpHref, useProcessEtps } from './etp.api';
import {
  processDocumentKeys,
  useActiveDocumentTypes,
  useProcessDocuments,
} from '../process-documents/process-documents.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

/** Resultado de uma tentativa recusada pelo servidor (a faixa acima do botão). */
type Outcome =
  | { readonly kind: 'exists'; readonly etpId: string | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notEditable' }
  | { readonly kind: 'typeNotAllowed' }
  | { readonly kind: 'noEligibleDfd' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'failed'; readonly correlationId: string | null };

/** `meta.existingEtpId` do 409 `DOCUMENT_ALREADY_EXISTS` (o "Abrir ETP"). */
function existingEtpId(error: ApiError): string | null {
  const meta = (error.problem?.meta ?? {}) as { existingEtpId?: unknown };
  return typeof meta.existingEtpId === 'string' ? meta.existingEtpId : null;
}

/** V-04: 422 com `NOT_ALLOWED` em `importFromDfd`. */
function isNoEligibleDfd(error: ApiError): boolean {
  return (
    error.code === 'VALIDATION_ERROR' &&
    error.errors.some((item) => item.field === 'importFromDfd' && item.code === 'NOT_ALLOWED')
  );
}

function outcomeOf(error: unknown): Outcome {
  if (!isApiError(error)) return { kind: 'failed', correlationId: null };
  if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
    return { kind: 'exists', etpId: existingEtpId(error) };
  }
  if (isNoEligibleDfd(error)) return { kind: 'noEligibleDfd' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.code === 'DOCUMENT_NOT_EDITABLE' || error.code === 'INVALID_PROCESS_STATUS') {
    return { kind: 'notEditable' };
  }
  if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') return { kind: 'typeNotAllowed' };
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'reused' };
  if (error.status === 503) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'failed', correlationId: error.correlationId };
}

/**
 * `ImportFromDfdCard` (US-019 · passo 2): o DFD elegível (objeto, nº de itens e situação no PCA) e
 * a opção "Importar dados do DFD", pré-selecionada. A elegibilidade é a do servidor (ETP-01 —
 * `meta.importableDfd`); a UI nunca recalcula a regra.
 */
export function ImportFromDfdCard({
  dfd,
  checked,
  disabled,
  onChange,
}: {
  readonly dfd: ImportableDfdDto;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const t = useTranslations('etp.create.import');
  const checkboxId = useId();
  const hintId = useId();
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border p-4">
      <h3 className="text-sm font-semibold">
        {dfd.code === null ? t('titleNoCode') : t('title', { code: dfd.code })}
      </h3>
      <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-[auto_1fr] md:gap-x-4">
        <dt className="text-muted-foreground">{t('object')}</dt>
        <dd className="min-w-0 break-words">{dfd.objectSummary}</dd>
        <dt className="text-muted-foreground">{t('itemsLabel')}</dt>
        <dd>{t('items', { count: dfd.itemsCount })}</dd>
        <dt className="text-muted-foreground">{t('pca')}</dt>
        <dd>{t(`pcaStatus.${dfd.pcaStatus ?? 'unknown'}`)}</dd>
      </dl>
      <div className="flex items-start gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 size-4"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={checkboxId} className="text-sm font-medium">
            {t('label')}
          </label>
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('hint')}
          </p>
        </div>
      </div>
    </section>
  );
}

export interface CreateEtpDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `CreateEtpDialog` (US-019 · fluxo principal 2–7): ETP-01 para o DFD elegível (cartão de
 * importação pré-marcado; oculto sem DFD — FA-02) e ETP-02 com uma `Idempotency-Key` por abertura
 * (renovada só se o corpo mudar ou a chave for recusada — V-05). Sucesso: invalida os documentos do
 * processo e navega para a SCR-008. Montado só enquanto aberto: cada abertura começa do zero.
 */
export function CreateEtpDialog({ processId, open, onOpenChange }: CreateEtpDialogProps) {
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
  const t = useTranslations('etp.create');
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const invalidateProcess = useInvalidateProcess(processId);
  const etps = useProcessEtps(processId);
  const [importDraft, setImportDraft] = useState<boolean | null>(null);
  const [importBlocked, setImportBlocked] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Uma `Idempotency-Key` por abertura; só muda se o corpo enviado mudar (FA-04 · V-05).
  const attempt = useRef<{ readonly json: string; readonly key: string } | null>(null);

  const importable = importBlocked ? null : (etps.data?.importableDfd ?? null);
  const importFromDfd = importable !== null && (importDraft ?? true);

  const submit = useMutation({
    mutationFn: (body: { readonly importFromDfd: boolean }) => {
      const json = JSON.stringify(body);
      if (attempt.current?.json !== json) attempt.current = { json, key: newIdempotencyKey() };
      return createEtp(processId, body, attempt.current.key);
    },
    onSuccess: (etp) => {
      toast({
        title:
          etp.code === null ? t('toast.createdNoCode') : t('toast.created', { code: etp.code }),
        tone: 'success',
      });
      void queryClient.invalidateQueries({
        queryKey: processDocumentKeys.list(tenantId, processId),
      });
      void invalidateProcess();
      onOpenChange(false);
      router.push(etpHref(processId, etp.id));
    },
    onError: (error: unknown) => {
      const next = outcomeOf(error);
      setOutcome(next);
      if (next.kind === 'noEligibleDfd') {
        // V-04: desmarca e desabilita a importação; o próximo envio cria em branco.
        setImportBlocked(true);
        setImportDraft(false);
      }
      if (next.kind === 'reused') attempt.current = null;
      if (['exists', 'forbidden', 'notEditable', 'typeNotAllowed'].includes(next.kind)) {
        // O estado do processo mudou: o painel recalcula o que o usuário pode criar.
        void invalidateProcess();
      }
    },
  });

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (submit.isPending) return;
    setOutcome(null);
    submit.mutate({ importFromDfd });
  };

  let card: ReactNode;
  if (etps.data === undefined) {
    card = etps.isPending ? (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-28 w-full" />
      </div>
    ) : (
      <Alert tone="error" title={t('loadError')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void etps.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (importable === null) {
    card = <p className="text-sm text-muted-foreground">{t('noDfd')}</p>;
  } else {
    card = (
      <ImportFromDfdCard
        dfd={importable}
        checked={importFromDfd}
        disabled={submit.isPending}
        onChange={setImportDraft}
      />
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
        {card}
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
            disabled={etps.data === undefined || submit.isPending || outcome?.kind === 'exists'}
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
  const t = useTranslations('etp.create');
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'exists':
      return (
        <Alert tone="info" title={t('exists')}>
          {outcome.etpId === null ? null : (
            <Link
              href={etpHref(processId, outcome.etpId)}
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
    case 'notEditable':
    case 'typeNotAllowed':
    case 'noEligibleDfd':
    case 'reused':
      return <Alert tone="error" title={t(outcome.kind)} />;
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
 * `CreateEtpButton` no painel do processo (SCR-006 · fluxo principal 1): exibido só quando o DOC-01
 * diz que o usuário pode criar o tipo `ETP` agora (`meta.creatableTypeIds` — `ETP_CREATE` + POL-02 +
 * etapa + sem ETP ativo). Com ETP ativo (ETP-01 — FA-03) vira o link "Abrir ETP".
 */
export function CreateEtpButton({ processId }: { readonly processId: string }) {
  const t = useTranslations('etp.create');
  const documents = useProcessDocuments(processId);
  const types = useActiveDocumentTypes();
  const etpType = types.data?.find((type) => type.systemModule === 'ETP');
  const etps = useProcessEtps(processId, etpType !== undefined);
  const existing = activeEtpOf(etps.data);
  const [open, setOpen] = useState(false);
  const creatable =
    etpType !== undefined && documents.data?.meta.creatableTypeIds.includes(etpType.id) === true;

  return (
    <>
      {existing === null ? null : (
        <Link
          href={etpHref(processId, existing.id)}
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
      <CreateEtpDialog processId={processId} open={open} onOpenChange={setOpen} />
    </>
  );
}
