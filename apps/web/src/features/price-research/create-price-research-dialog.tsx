'use client';

import { localDateOf } from '@contrataflow/types';
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
import { PRICE_RESEARCH_MESSAGES, priceResearchDocumentTitle } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useShellSession } from '@/lib/session/session-context';

import {
  canSubmit,
  createBodyOf,
  existingResearchId,
  headerIssues,
  isItemsRequired,
  mapValidationErrors,
  normalizeQuantity,
  researchRows,
  rowIssues,
  rowMessage,
} from './price-research-model';
import type { HeaderIssues, ResearchRow, RowEdit } from './price-research-model';
import {
  activeResearchOf,
  createPriceResearch,
  priceResearchHref,
  processItemsHref,
  useProcessPriceResearch,
} from './price-research.api';
import {
  processDocumentKeys,
  useActiveDocumentTypes,
  useProcessDocuments,
} from '../process-documents/process-documents.api';
import { useProcessItems } from '../process-items/process-items.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  fetchProcess,
  processKeys,
} from '../processes/processes.api';

/** Resultado de uma tentativa recusada pelo servidor (a faixa acima do formulário). */
type Outcome =
  | { readonly kind: 'validation' }
  | { readonly kind: 'noItems' }
  | { readonly kind: 'exists'; readonly researchId: string | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalidStatus' }
  | { readonly kind: 'typeNotAllowed' }
  | { readonly kind: 'failed'; readonly correlationId: string | null };

interface ServerErrors {
  readonly rows: ReadonlyMap<string, string>;
  readonly header: HeaderIssues;
}

const NO_SERVER_ERRORS: ServerErrors = { rows: new Map(), header: {} };

function withoutHeaderError(errors: ServerErrors, field: keyof HeaderIssues): ServerErrors {
  const { [field]: _removed, ...header } = errors.header;
  return { ...errors, header };
}

export interface CreatePriceResearchDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `CreatePriceResearchDialog` (US-024 · fluxo principal 2–7): lista os itens do processo (PRC-13)
 * todos marcados, com a quantidade editável (a de referência vem preenchida; sem ela a linha fica
 * destacada e o envio bloqueado — FA-03), a data-base (hoje, não futura — V-05) e o título sugerido
 * (V-06). Valida com os MESMOS schemas/regras da API; o PRS-02 leva uma `Idempotency-Key` por
 * abertura do diálogo (renovada só se o corpo mudar). Montado só enquanto aberto: cada abertura
 * começa do zero.
 */
export function CreatePriceResearchDialog({
  processId,
  open,
  onOpenChange,
}: CreatePriceResearchDialogProps) {
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
  const t = useTranslations('priceResearch.create');
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const today = localDateOf(new Date(), session.activeTenant.timezone);
  const invalidateProcess = useInvalidateProcess(processId);

  const process = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const items = useProcessItems(processId);
  const units = useQuery({
    queryKey: processKeys.activeCatalog(tenantId, 'UNIT_OF_MEASURE'),
    queryFn: ({ signal }) => fetchActiveCatalog('UNIT_OF_MEASURE', signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });

  const [edits, setEdits] = useState<Readonly<Record<string, RowEdit>>>({});
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [serverErrors, setServerErrors] = useState<ServerErrors>(NO_SERVER_ERRORS);
  // Uma `Idempotency-Key` por abertura; só muda se o corpo enviado mudar (V-11).
  const attempt = useRef<{ readonly json: string; readonly key: string } | null>(null);

  const unitAllowsDecimal = new Map(
    (units.data ?? []).map((unit) => [unit.id, unit.metadata.allowsDecimal !== false]),
  );
  const rows = researchRows(items.data?.items ?? [], unitAllowsDecimal, edits);
  const title = titleDraft ?? priceResearchDocumentTitle(process.data?.code ?? null);
  const referenceDate = dateDraft ?? today;
  const draft = { title, referenceDate, rows, today };
  const issues = rowIssues(rows);
  const header = { ...headerIssues(draft), ...serverErrors.header };
  const ready = canSubmit(draft) && serverErrors.rows.size === 0;
  const selectedCount = rows.filter((row) => row.selected).length;
  const messages = new Map(
    rows.flatMap((row) => {
      const message =
        serverErrors.rows.get(row.processItemId) ??
        rowMessage(issues.get(row.processItemId) ?? null);
      return message === null ? [] : [[row.processItemId, message] as const];
    }),
  );

  const submit = useMutation({
    mutationFn: (body: ReturnType<typeof createBodyOf>) => {
      const json = JSON.stringify(body);
      if (attempt.current?.json !== json) attempt.current = { json, key: newIdempotencyKey() };
      return createPriceResearch(processId, body, attempt.current.key);
    },
    onSuccess: ({ research }) => {
      toast({
        title:
          research.code === null
            ? t('toast.createdNoCode')
            : t('toast.created', { code: research.code }),
        tone: 'success',
      });
      void queryClient.invalidateQueries({
        queryKey: processDocumentKeys.list(tenantId, processId),
      });
      void invalidateProcess();
      onOpenChange(false);
      router.push(priceResearchHref(processId, research.id));
    },
    onError: (error: unknown, body) => {
      if (!isApiError(error)) {
        setOutcome({ kind: 'failed', correlationId: null });
        return;
      }
      if (error.status === 422 && error.code === 'VALIDATION_ERROR') {
        const mapped = mapValidationErrors(error, body.items ?? []);
        setServerErrors({ rows: mapped.rows, header: mapped.header });
        setOutcome({ kind: 'validation' });
        return;
      }
      if (isItemsRequired(error)) {
        setOutcome({ kind: 'noItems' });
        return;
      }
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
        setOutcome({ kind: 'exists', researchId: existingResearchId(error) });
        return;
      }
      if (error.status === 403) {
        setOutcome({ kind: 'forbidden' });
      } else if (error.code === 'INVALID_PROCESS_STATUS') {
        setOutcome({ kind: 'invalidStatus' });
      } else if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        setOutcome({ kind: 'typeNotAllowed' });
      } else {
        setOutcome({ kind: 'failed', correlationId: error.correlationId });
        return;
      }
      // O estado do processo mudou: o painel recalcula o que o usuário pode criar.
      void invalidateProcess();
    },
  });

  const changeRow = (row: ResearchRow, edit: RowEdit) => {
    setEdits((current) => ({
      ...current,
      [row.processItemId]: { ...current[row.processItemId], ...edit },
    }));
    if (serverErrors.rows.has(row.processItemId)) {
      const next = new Map(serverErrors.rows);
      next.delete(row.processItemId);
      setServerErrors({ ...serverErrors, rows: next });
    }
    setOutcome((current) => (current?.kind === 'validation' ? null : current));
  };
  const changeAll = (selected: boolean) => {
    setEdits((current) => ({
      ...current,
      ...Object.fromEntries(
        rows.map((row) => [row.processItemId, { ...current[row.processItemId], selected }]),
      ),
    }));
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || submit.isPending) return;
    setOutcome(null);
    setServerErrors(NO_SERVER_ERRORS);
    submit.mutate(createBodyOf(draft));
  };

  let body: ReactNode;
  if (items.data === undefined) {
    body = items.isPending ? (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-full" />
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
            void items.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (items.data.items.length === 0 || outcome?.kind === 'noItems') {
    // FA-02: sem itens no processo.
    body = (
      <Alert tone="warning" title={PRICE_RESEARCH_MESSAGES.noProcessItems}>
        <Link
          href={processItemsHref(processId)}
          className={cx(buttonClassName({ variant: 'secondary', size: 'sm' }), 'mt-2')}
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('noItems.goToItems')}
        </Link>
      </Alert>
    );
  } else {
    body = (
      <form className="flex min-w-0 flex-col gap-4" onSubmit={onSubmit} noValidate>
        <OutcomeAlert processId={processId} outcome={outcome} onNavigate={onOpenChange} />
        <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
          <FormField id="pr-title" label={t('fields.title')} required error={header.title}>
            {(control) => (
              <input
                {...control}
                type="text"
                className={INPUT_CLASS}
                value={title}
                maxLength={300}
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  setServerErrors((current) => withoutHeaderError(current, 'title'));
                }}
              />
            )}
          </FormField>
          <FormField
            id="pr-reference-date"
            label={t('fields.referenceDate')}
            hint={t('fields.referenceDateHint')}
            required
            error={header.referenceDate}
          >
            {(control) => (
              <input
                {...control}
                type="date"
                className={INPUT_CLASS}
                value={referenceDate}
                max={today}
                onChange={(event) => {
                  setDateDraft(event.target.value);
                  setServerErrors((current) => withoutHeaderError(current, 'referenceDate'));
                }}
              />
            )}
          </FormField>
        </div>
        <ItemsTable
          rows={rows}
          messages={messages}
          selectedCount={selectedCount}
          disabled={submit.isPending}
          itemsError={header.items}
          onChange={changeRow}
          onChangeAll={changeAll}
        />
        <p className="sr-only" role="status" aria-live="polite">
          {messages.size > 0 ? t('rowErrors', { count: messages.size }) : ''}
        </p>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={!ready || submit.isPending}>
            {submit.isPending ? t('submitting') : t('submit')}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
      {body}
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
  const t = useTranslations('priceResearch.create.errors');
  if (outcome === null || outcome.kind === 'noItems') return null;
  switch (outcome.kind) {
    case 'validation':
      return <Alert tone="error" title={t('fix')} />;
    case 'exists':
      return (
        <Alert tone="info" title={t('exists')}>
          {outcome.researchId === null ? null : (
            <Link
              href={priceResearchHref(processId, outcome.researchId)}
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
      return <Alert tone="error" title={t('forbidden')} />;
    case 'invalidStatus':
      return <Alert tone="error" title={t('invalidStatus')} />;
    case 'typeNotAllowed':
      return <Alert tone="error" title={t('typeNotAllowed')} />;
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

const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

function ItemsTable({
  rows,
  messages,
  selectedCount,
  disabled,
  itemsError,
  onChange,
  onChangeAll,
}: {
  readonly rows: readonly ResearchRow[];
  readonly messages: ReadonlyMap<string, string>;
  readonly selectedCount: number;
  readonly disabled: boolean;
  readonly itemsError: string | undefined;
  readonly onChange: (row: ResearchRow, edit: RowEdit) => void;
  readonly onChangeAll: (selected: boolean) => void;
}) {
  const t = useTranslations('priceResearch.create');
  const all = selectedCount === rows.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4"
            checked={all}
            ref={(element) => {
              if (element) element.indeterminate = selectedCount > 0 && !all;
            }}
            disabled={disabled}
            onChange={(event) => {
              onChangeAll(event.target.checked);
            }}
          />
          {t('selectAll')}
        </label>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('selectedCount', { selected: selectedCount, total: rows.length })}
        </p>
      </div>
      {itemsError === undefined ? null : (
        <p className="text-sm text-destructive" role="alert">
          {itemsError}
        </p>
      )}
      <table className="block w-full md:table">
        <caption className="sr-only">{t('caption')}</caption>
        <thead className="hidden text-left text-sm text-muted-foreground md:table-header-group">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('columns.select')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.sequence')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.lot')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.description')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.unit')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.reference')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('columns.quantity')}
            </th>
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
          {rows.map((row) => {
            const message = messages.get(row.processItemId) ?? null;
            const quantityId = `pr-quantity-${row.processItemId}`;
            return (
              <tr
                key={row.processItemId}
                className={cx(
                  'grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 border-b border-border p-3 md:table-row md:p-0',
                  message !== null && 'bg-warning-soft',
                )}
              >
                <td className="row-span-6 md:table-cell md:px-3 md:py-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={row.selected}
                    disabled={disabled}
                    aria-label={t('selectItem', { number: row.sequence })}
                    onChange={(event) => {
                      onChange(row, { selected: event.target.checked });
                    }}
                  />
                </td>
                <td className="col-start-2 font-medium md:table-cell md:px-3 md:py-2">
                  <span className="text-muted-foreground md:hidden">{t('columns.sequence')} </span>
                  {row.sequence}
                </td>
                <td className="col-start-2 text-sm md:table-cell md:px-3 md:py-2">
                  <span className="text-muted-foreground md:hidden">{t('columns.lot')}: </span>
                  {row.lotNumber === null
                    ? t('noLot')
                    : row.lotName === null
                      ? row.lotNumber
                      : `${String(row.lotNumber)} — ${row.lotName}`}
                </td>
                <td className="col-start-2 min-w-0 text-sm break-words md:table-cell md:px-3 md:py-2">
                  {row.description}
                </td>
                <td className="col-start-2 text-sm md:table-cell md:px-3 md:py-2">
                  <span className="text-muted-foreground md:hidden">{t('columns.unit')}: </span>
                  {row.unitLabel}
                </td>
                <td className="col-start-2 text-sm md:table-cell md:px-3 md:py-2">
                  <span className="text-muted-foreground md:hidden">
                    {t('columns.reference')}:{' '}
                  </span>
                  {row.referenceQuantity === ''
                    ? t('noReference')
                    : quantityFormat.format(Number(row.referenceQuantity))}
                </td>
                <td className="col-start-2 md:table-cell md:px-3 md:py-2">
                  <label htmlFor={quantityId} className="text-xs text-muted-foreground md:sr-only">
                    {t('quantityOf', { number: row.sequence })}
                  </label>
                  <input
                    id={quantityId}
                    type="text"
                    className={cx(INPUT_CLASS, 'md:w-36')}
                    inputMode={row.allowsDecimal ? 'decimal' : 'numeric'}
                    value={row.quantity}
                    disabled={disabled || !row.selected}
                    aria-invalid={message === null ? undefined : true}
                    aria-describedby={message === null ? undefined : `${quantityId}-error`}
                    onChange={(event) => {
                      onChange(row, { quantity: event.target.value });
                    }}
                    onBlur={() => {
                      const normalized = normalizeQuantity(row.quantity);
                      if (normalized !== row.quantity) onChange(row, { quantity: normalized });
                    }}
                  />
                  {message === null ? null : (
                    <p
                      id={`${quantityId}-error`}
                      className="mt-1 text-sm text-destructive"
                      aria-live="polite"
                    >
                      {message}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Criar pesquisa de preços" no painel do processo (SCR-006 · fluxo principal 1): exibido só quando
 * o DOC-01 diz que o usuário pode criar o tipo `PRICE_RESEARCH` agora (`meta.creatableTypeIds` —
 * `PRICE_RESEARCH_CREATE` + POL-02 + etapa + sem pesquisa ativa). Com pesquisa ativa (PRS-01 — FA-01)
 * vira o link "Abrir pesquisa {código}". A UI nunca recalcula a regra.
 */
export function CreatePriceResearchButton({ processId }: { readonly processId: string }) {
  const t = useTranslations('priceResearch.create');
  const documents = useProcessDocuments(processId);
  const types = useActiveDocumentTypes();
  const priceType = types.data?.find((type) => type.systemModule === 'PRICE_RESEARCH');
  const research = useProcessPriceResearch(processId, priceType !== undefined);
  const existing = activeResearchOf(research.data);
  const [open, setOpen] = useState(false);
  const creatable =
    priceType !== undefined &&
    documents.data?.meta.creatableTypeIds.includes(priceType.id) === true;

  return (
    <>
      {existing === null ? null : (
        <Link
          href={priceResearchHref(processId, existing.id)}
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
      <CreatePriceResearchDialog processId={processId} open={open} onOpenChange={setOpen} />
    </>
  );
}
