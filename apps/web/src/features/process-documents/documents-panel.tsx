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
  EmptyState,
  Field,
  FilterToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
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
import { DuplicateDfdButton } from '../dfd-duplicate/duplicate-dfd-dialog';
import { DocumentStatusBadge, PendingApprovalBadge } from '../documents/document-status-badge';
import { GeneratePdfButton } from '../documents/generate-pdf-button';
import type { PdfSource } from '../documents/generate-pdf-button';
import { CreateEtpDialog } from '../etp/create-etp-dialog';
import { CreatePriceResearchDialog } from '../price-research/create-price-research-dialog';
import { CreateTermDialog } from '../term/create-term-dialog';
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

/**
 * PDF do cartão (US-067): o oficial da versão atual (DOC-21) quando há versão; senão, a prévia do
 * rascunho (DOC-20). Documento externo (`UPLOADED`) já é o próprio arquivo — sem botão.
 */
function pdfSourceOf(document: ProcessDocumentDto): PdfSource | null {
  if (document.documentType.kind === 'UPLOADED') return null;
  if (document.currentVersionId !== null && document.currentVersionNumber !== null) {
    return {
      kind: 'version',
      versionId: document.currentVersionId,
      versionNumber: document.currentVersionNumber,
    };
  }
  return { kind: 'preview', documentId: document.id };
}

/** Um cartão de documento: código, status, selo, título, versão, responsável, PDF e atualização. */
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
  const pdf = pdfSourceOf(document);
  const updatedAt = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(document.updatedAt));
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-control border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground tabular-nums">
          {document.code ?? t('noNumber')}
        </span>
        <DocumentStatusBadge status={document.status} />
        {document.pendingApprovalId === null ? null : <PendingApprovalBadge />}
        <span className="text-xs text-muted-foreground">
          {document.currentVersionNumber === null
            ? t('noVersion')
            : t('version', { number: document.currentVersionNumber })}
        </span>
      </div>
      <Link
        href={documentHref(processId, document)}
        className="text-sm font-semibold break-words text-primary underline-offset-2 hover:text-primary-hover hover:underline focus-visible:underline"
      >
        {document.title}
      </Link>
      <p className="text-xs text-muted-foreground">
        {t('meta', {
          responsible: document.responsibleName ?? t('noResponsible'),
          updatedAt,
        })}
      </p>
      {pdf === null ? null : <GeneratePdfButton source={pdf} />}
      {document.documentType.systemModule === 'DFD' ? (
        <div>
          <DuplicateDfdButton dfd={{ id: document.id, processId, code: document.code }} />
        </div>
      ) : null}
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
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5 shadow-card"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-section-title text-brand-ink">
          {group.type.name}
        </h3>
        {group.type.singular ? null : (
          <span className="rounded-full bg-neutral-soft px-2 py-px text-xs font-bold text-neutral-soft-foreground">
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

/** "Todos" nos `Select` do popover (o Radix não aceita valor vazio). */
const ANY = 'all';

/**
 * Filtros sobre a lista carregada (RN-DOC-20): busca inline (≥ 2) e, no popover "Filtros", tipo,
 * status e responsável — o que estiver ativo aparece como chip removível.
 */
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
  const chips: FilterToolbarChip[] = [];
  const addChip = (id: string, label: string, value: string, next: PanelFilter) => {
    chips.push({
      id,
      label: t('chip', { label, value }),
      removeLabel: t('remove', { label: `${label}: ${value}` }),
      onRemove: () => {
        onChange(next);
      },
    });
  };
  if (filter.typeId !== null) {
    const name = types.find((type) => type.id === filter.typeId)?.name ?? '…';
    addChip('type', t('type'), name, { ...filter, typeId: null });
  }
  if (filter.status !== null) {
    addChip('status', t('status'), tStatus(filter.status), { ...filter, status: null });
  }
  if (filter.responsibleId !== null) {
    const name = responsibles.find((person) => person.id === filter.responsibleId)?.name ?? '…';
    addChip('responsible', t('responsible'), name, { ...filter, responsibleId: null });
  }

  return (
    <FilterToolbar
      search={{
        value: filter.q,
        onChange: (q) => {
          onChange({ ...filter, q });
        },
        label: t('search'),
        placeholder: t('searchPlaceholder'),
      }}
      filters={
        <>
          <Field label={t('type')}>
            <Select
              value={filter.typeId ?? ANY}
              onValueChange={(value) => {
                onChange({ ...filter, typeId: value === ANY ? null : value });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('all')}</SelectItem>
                {types.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('status')}>
            <Select
              value={filter.status ?? ANY}
              onValueChange={(value) => {
                onChange({ ...filter, status: value === ANY ? null : (value as DocumentStatus) });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('all')}</SelectItem>
                {DOCUMENT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {tStatus(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('responsible')}>
            <Select
              value={filter.responsibleId ?? ANY}
              onValueChange={(value) => {
                onChange({ ...filter, responsibleId: value === ANY ? null : value });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('all')}</SelectItem>
                {responsibles.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      }
      activeCount={chips.length}
      chips={chips}
      onClearAll={() => {
        onChange(EMPTY_FILTER);
      }}
      labels={{ filters: t('open'), clearAll: t('clear'), activeFilters: t('active') }}
    />
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

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
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
  const [creatingPriceResearch, setCreatingPriceResearch] = useState(false);
  const [creatingEtp, setCreatingEtp] = useState(false);
  const [creatingTerm, setCreatingTerm] = useState(false);

  // Destinos de criação: o diálogo das US-063/064 (FREE_TEXT → editor de seções e UPLOADED → "Enviar
  // arquivo", ambos na SCR-105), o DFD-02 da US-014 (DFD → SCR-007), o diálogo do ETP (US-019 →
  // SCR-008) e o da pesquisa de preços (US-024 → SCR-009), o do TR (US-036 → SCR-012); os demais
  // módulos tipados ainda não chegaram.
  const elaborate = useElaborateDfd(processId);
  const onCreate = (type: PanelType) => {
    if (type.kind === 'UPLOADED' || type.kind === 'FREE_TEXT') {
      setCreating(type);
      return;
    }
    if (type.systemModule === 'DFD') {
      elaborate.elaborate();
      return;
    }
    // ETP-02 (US-019): o diálogo "Criar ETP" com o cartão de importação do DFD.
    if (type.systemModule === 'ETP') {
      setCreatingEtp(true);
      return;
    }
    // TRM-02 (US-036): o diálogo "Criar Termo de Referência" com o modelo e o título.
    if (type.systemModule === 'TERM_OF_REFERENCE') {
      setCreatingTerm(true);
      return;
    }
    // PRS-02 (US-024): o diálogo de criação da pesquisa de preços.
    if (type.systemModule === 'PRICE_RESEARCH') {
      setCreatingPriceResearch(true);
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
        <h2 className="text-section-title text-brand-ink">{t('title')}</h2>
        {empty ? null : <CreateDocumentMenu types={menu} onCreate={onCreate} prominent={false} />}
      </div>
      <ElaborateDfdOutcome processId={processId} outcome={elaborate.outcome} />
      <CreateEtpDialog processId={processId} open={creatingEtp} onOpenChange={setCreatingEtp} />
      <CreateTermDialog processId={processId} open={creatingTerm} onOpenChange={setCreatingTerm} />
      <CreatePriceResearchDialog
        processId={processId}
        open={creatingPriceResearch}
        onOpenChange={setCreatingPriceResearch}
      />
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
        <EmptyState
          icon={<DocumentIcon />}
          title={t('empty')}
          description={t('emptyHint')}
          action={<CreateDocumentMenu types={menu} onCreate={onCreate} prominent />}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title={t('noMatches')}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setFilter(EMPTY_FILTER);
              }}
            >
              {t('filters.clear')}
            </Button>
          }
        />
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
