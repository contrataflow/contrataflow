'use client';

import {
  Alert,
  BottomSheetContent,
  Button,
  Dialog,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import { DOCUMENT_STATUSES } from '@contrataflow/validation';
import type { DocumentStatus, ProcessDocumentDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { CreateDocumentDialog } from './create-document-dialog';
import {
  EMPTY_FILTER,
  creatableTypes,
  documentHref,
  filterDocuments,
  groupDocuments,
  isFiltering,
  responsiblesOf,
  summaryValueOf,
} from './process-documents-model';
import type { DocumentGroup, PanelFilter, PanelType } from './process-documents-model';
import { useActiveDocumentTypes, useProcessDocuments } from './process-documents.api';
import { ElaborateDfdOutcome, useElaborateDfd } from '../dfd/elaborate-dfd';
import { DocumentStatusBadge, PendingApprovalBadge } from '../documents/document-status-badge';
import { useIsDesktop } from '../workflows/use-is-desktop';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** `ConfidentialityLock`: valor do resumo escondido por POL-09 — texto, não só o ícone. */
function ConfidentialityLock() {
  const t = useTranslations('documents.panel');
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {t('confidential')}
    </span>
  );
}

/** Uma linha de documento: código, título, status, selo, responsável e última atualização. */
function DocumentRow({
  processId,
  document,
  timeZone,
}: {
  readonly processId: string;
  readonly document: ProcessDocumentDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('documents.panel');
  const value = summaryValueOf(document);
  const updatedAt = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(document.updatedAt));
  return (
    <li className="flex flex-col gap-1 rounded-control border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {document.code ?? t('noNumber')}
        </span>
        <DocumentStatusBadge status={document.status} />
        {document.pendingApprovalId === null ? null : <PendingApprovalBadge />}
      </div>
      <Link
        href={documentHref(processId, document)}
        className="text-sm font-medium break-words text-primary underline-offset-2 hover:underline focus-visible:underline"
      >
        {document.title}
      </Link>
      <p className="text-xs text-muted-foreground">
        {t('meta', {
          responsible: document.responsibleName ?? t('noResponsible'),
          updatedAt,
        })}
      </p>
      {value === null ? null : (
        <p className="text-xs">
          <span className="text-muted-foreground">{t('totalValue')} </span>
          {value.masked ? (
            <ConfidentialityLock />
          ) : (
            <span className="font-medium">{money.format(Number(value.value))}</span>
          )}
        </p>
      )}
    </li>
  );
}

/** `DocumentTypeCard`: um cartão por tipo — singular com o documento ou "Não iniciado". */
function DocumentTypeCard({
  processId,
  group,
  timeZone,
  onCreate,
}: {
  readonly processId: string;
  readonly group: DocumentGroup;
  readonly timeZone: string;
  readonly onCreate: (type: PanelType) => void;
}) {
  const t = useTranslations('documents.panel');
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {group.type.name}
        </h3>
        {group.type.singular ? null : (
          <span className="text-xs text-muted-foreground">
            {t('count', { count: group.documents.length })}
          </span>
        )}
      </header>
      {group.pending ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">{t('notStarted')}</p>
          {group.creatable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onCreate(group.type);
              }}
            >
              {t('start', { type: group.type.name })}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {group.documents.map((document) => (
            <DocumentRow
              key={document.id}
              processId={processId}
              document={document}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `CreateDocumentMenu` (RN-DOC-16): os tipos de `meta.creatableTypeIds`. Menu suspenso navegável
 * por teclado; abaixo de 768 px vira folha inferior.
 */
function CreateDocumentMenu({
  types,
  onCreate,
  prominent,
}: {
  readonly types: readonly PanelType[];
  readonly onCreate: (type: PanelType) => void;
  readonly prominent: boolean;
}) {
  const t = useTranslations('documents.panel');
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  if (types.length === 0) return null;
  const trigger = (
    <Button size={prominent ? 'md' : 'sm'} variant={prominent ? 'primary' : 'secondary'}>
      {t('create')}
    </Button>
  );
  if (desktop) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t('createMenu')}>
          {types.map((type) => (
            <DropdownMenuItem
              key={type.id}
              onSelect={() => {
                onCreate(type);
              }}
            >
              {type.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <BottomSheetContent aria-describedby={undefined}>
        <DialogTitle className="text-base font-semibold">{t('createMenu')}</DialogTitle>
        <ul className="flex flex-col gap-1">
          {types.map((type) => (
            <li key={type.id}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  onCreate(type);
                }}
              >
                {type.name}
              </Button>
            </li>
          ))}
        </ul>
      </BottomSheetContent>
    </Dialog>
  );
}

/** Filtros sobre a lista carregada (RN-DOC-20): tipo, status, responsável e busca (≥ 2). */
function PanelFilters({
  filter,
  onChange,
  types,
  responsibles,
}: {
  readonly filter: PanelFilter;
  readonly onChange: (filter: PanelFilter) => void;
  readonly types: readonly { readonly id: string; readonly name: string }[];
  readonly responsibles: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('documents.panel.filters');
  const tStatus = useTranslations('documents.statuses');
  const id = useId();
  const select =
    'h-9 rounded-control border border-border bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-primary';
  return (
    <div role="search" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${id}-q`}>
        {t('search')}
        <input
          id={`${id}-q`}
          type="search"
          value={filter.q}
          placeholder={t('searchPlaceholder')}
          className={select}
          onChange={(event) => {
            onChange({ ...filter, q: event.target.value });
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${id}-type`}>
        {t('type')}
        <select
          id={`${id}-type`}
          value={filter.typeId ?? ''}
          className={select}
          onChange={(event) => {
            onChange({ ...filter, typeId: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">{t('all')}</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${id}-status`}>
        {t('status')}
        <select
          id={`${id}-status`}
          value={filter.status ?? ''}
          className={select}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...filter, status: value === '' ? null : (value as DocumentStatus) });
          }}
        >
          <option value="">{t('all')}</option>
          {DOCUMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {tStatus(status)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${id}-responsible`}>
        {t('responsible')}
        <select
          id={`${id}-responsible`}
          value={filter.responsibleId ?? ''}
          className={select}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...filter, responsibleId: value === '' ? null : value });
          }}
        >
          <option value="">{t('all')}</option>
          {responsibles.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Falha ao carregar: 404 (processo não visível), 503/429 ("Tentar novamente") ou inesperado. */
function PanelError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const t = useTranslations('documents.panel.errors');
  const tErrors = useTranslations('errors');
  if (isApiError(error) && (error.status === 404 || error.status === 403)) {
    return (
      <Alert tone="error" title={t('notFound')}>
        <Link href="/processos" className="text-sm text-primary underline">
          {t('backToList')}
        </Link>
      </Alert>
    );
  }
  const unexpected = isApiError(error) && error.status === 500;
  const correlationId = isApiError(error) ? error.correlationId : null;
  return (
    <Alert tone="error" title={unexpected ? t('unexpected') : t('unavailable')}>
      {unexpected && correlationId ? (
        <CorrelationCode
          correlationId={correlationId}
          labels={{
            code: tErrors('correlation.label', { correlationId }),
            copy: tErrors('correlation.copy'),
            copied: tErrors('correlation.copied'),
          }}
        />
      ) : null}
      <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
        {t('retry')}
      </Button>
    </Alert>
  );
}

function PanelSkeleton() {
  const t = useTranslations('documents.panel');
  return (
    <div role="status" className="grid gap-4 md:grid-cols-2">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-32" />
      ))}
    </div>
  );
}

/**
 * `DocumentsPanel` — SCR-006, aba "Documentos" (US-062): DOC-01 e DTY-01 em paralelo; cartões por
 * tipo (`sortOrder`), selo "Em aprovação" (RN-DOC-15), resumo sob POL-09 (RN-DOC-17), filtros
 * locais (RN-DOC-20) e o menu "Criar documento" (RN-DOC-16). Revalida ao focar a janela.
 */
export function DocumentsPanel({ processId }: { readonly processId: string }) {
  const t = useTranslations('documents.panel');
  const tProcess = useTranslations('processes.panel.actions');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const documents = useProcessDocuments(processId);
  const types = useActiveDocumentTypes();
  const [filter, setFilter] = useState<PanelFilter>(EMPTY_FILTER);

  const [creating, setCreating] = useState<PanelType | null>(null);

  // Destinos de criação: o diálogo da US-064 (UPLOADED → SCR-105 "Enviar arquivo") e o DFD-02 da
  // US-014 (DFD → SCR-007); o da US-063 (FREE_TEXT) e os demais módulos tipados ainda não chegaram.
  const elaborate = useElaborateDfd(processId);
  const onCreate = (type: PanelType) => {
    if (type.kind === 'UPLOADED') {
      setCreating(type);
      return;
    }
    if (type.systemModule === 'DFD') {
      elaborate.elaborate();
      return;
    }
    toast({ title: tProcess('notYet') });
  };

  if (documents.data === undefined || types.data === undefined) {
    const error = documents.error ?? types.error;
    if (error === null) return <PanelSkeleton />;
    return (
      <PanelError
        error={error}
        onRetry={() => {
          void documents.refetch();
          void types.refetch();
        }}
      />
    );
  }

  const { items, meta } = documents.data;
  const filtering = isFiltering(filter);
  const groups = groupDocuments(types.data, filterDocuments(items, filter), meta, { filtering });
  const menu = creatableTypes(types.data, meta);
  const empty = items.length === 0 && meta.pendingTypeIds.length === 0;
  const typeOptions = [
    ...new Map(items.map((item) => [item.documentType.id, item.documentType])).values(),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <CreateDocumentMenu types={menu} onCreate={onCreate} prominent={empty} />
      </div>
      <ElaborateDfdOutcome processId={processId} outcome={elaborate.outcome} />
      {creating ? (
        <CreateDocumentDialog
          processId={processId}
          type={creating}
          onClose={() => {
            setCreating(null);
          }}
        />
      ) : null}
      {items.length > 0 ? (
        <PanelFilters
          filter={filter}
          onChange={setFilter}
          types={typeOptions}
          responsibles={responsiblesOf(items)}
        />
      ) : null}
      {empty ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-dashed border-border p-6">
          <p className="text-sm font-medium">{t('empty')}</p>
          <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMatches')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <DocumentTypeCard
              key={group.type.id}
              processId={processId}
              group={group}
              timeZone={timeZone}
              onCreate={onCreate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
