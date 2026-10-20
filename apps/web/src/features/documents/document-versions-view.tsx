'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { DOCUMENT_VERSION_LIMITS, DOCUMENT_VERSION_MESSAGES } from '@contrataflow/validation';
import type {
  CollectionDiff,
  DocumentVersionComparisonDto,
  DocumentVersionSummaryDto,
  HeaderDiff,
  SectionDiff,
  SectionSide,
  VersionChangeType,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ErrorView } from '@/components/errors/error-view';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  compareDocumentVersions,
  documentKeys,
  fetchDocument,
  fetchDocumentVersions,
  versionKeys,
} from './documents.api';
import { GeneratePdfButton } from './generate-pdf-button';
import { SaveVersionAction } from './save-version-dialog';

export interface DocumentVersionsViewProps {
  readonly processId: string;
  readonly documentId: string;
}

interface Selection {
  readonly from: string;
  readonly to: string;
}

/**
 * SCR-106 — Versões e comparação (US-066): `VersionList` (DOC-15, com "Comparar com a anterior"),
 * `VersionComparePicker` (duas versões quaisquer) e `VersionDiffView` (DOC-18: cabeçalho, seções e
 * coleções, cada linha com o indicador em texto além da cor). "Salvar versão" aparece pelas mesmas
 * regras da SCR-105. Estados: skeleton, lista vazia, erro ao comparar com "Recarregar".
 */
export function DocumentVersionsView({ processId, documentId }: DocumentVersionsViewProps) {
  const t = useTranslations('documents.versions');
  const tenantId = useTenantId();
  const [selection, setSelection] = useState<Selection | null>(null);
  const diffHeading = useRef<HTMLHeadingElement>(null);

  const document = useQuery({
    queryKey: documentKeys.detail(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocument(documentId, signal),
    throwOnError: false,
  });
  const versions = useQuery({
    queryKey: versionKeys.list(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocumentVersions(documentId, signal),
    throwOnError: false,
  });

  const choose = (next: Selection) => {
    setSelection(next);
    setTimeout(() => diffHeading.current?.focus(), 0);
  };

  const documentHref = `/processos/${processId}/documentos/${documentId}`;
  const notFound =
    (isApiError(versions.error) && versions.error.status === 404) ||
    (isApiError(document.error) && document.error.status === 404);
  if (notFound) {
    return (
      <ErrorView
        title={t('notFoundTitle')}
        description={DOCUMENT_VERSION_MESSAGES.notFound}
        actions={
          <Link
            href={`/processos/${processId}`}
            className="self-center text-sm text-primary underline"
          >
            {t('backToProcess')}
          </Link>
        }
      />
    );
  }

  const current = document.data;
  const canSave =
    current !== undefined &&
    current.meta.allowedActions.includes('UPDATE') &&
    current.document.documentType.kind !== 'UPLOADED';
  const items = versions.data?.items ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-2">
        <Link href={documentHref} className="text-sm text-primary underline">
          {t('backToDocument')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight break-words">{t('title')}</h1>
        {current ? (
          <p className="text-sm break-words text-muted-foreground">
            {current.document.code ? `${current.document.code} — ` : ''}
            {current.document.title}
          </p>
        ) : null}
        {canSave ? (
          <div>
            <SaveVersionAction document={current.document} />
          </div>
        ) : null}
      </header>

      {versions.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : versions.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => {
              void versions.refetch();
            }}
          >
            {t('reload')}
          </Button>
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <VersionList
            versions={items}
            onCompare={choose}
            pdfEnabled={current !== undefined && current.document.documentType.kind !== 'UPLOADED'}
          />
          {items.length > 1 ? (
            <VersionComparePicker versions={items} selection={selection} onCompare={choose} />
          ) : null}
        </>
      )}

      {selection ? (
        <section aria-labelledby={`${documentId}-diff`} className="flex min-w-0 flex-col gap-4">
          <h2
            id={`${documentId}-diff`}
            ref={diffHeading}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {t('diff.title')}
          </h2>
          <VersionComparison documentId={documentId} selection={selection} />
        </section>
      ) : null}
    </div>
  );
}

// --- VersionList --------------------------------------------------------------------------------

function VersionList({
  versions,
  onCompare,
  pdfEnabled,
}: {
  readonly versions: readonly DocumentVersionSummaryDto[];
  readonly onCompare: (selection: Selection) => void;
  /** US-067: "Gerar PDF desta versão" (DOC-21); documento externo já é o próprio arquivo. */
  readonly pdfEnabled: boolean;
}) {
  const t = useTranslations('documents.versions');
  const format = useFormatter();
  return (
    <ol aria-label={t('listLabel')} className="flex flex-col gap-3">
      {versions.map((version, index) => {
        const previous = versions[index + 1];
        return (
          <li
            key={version.id}
            className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">
                  <span>{t('number', { number: version.versionNumber })}</span>
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {t(`reasons.${version.reason}`)}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('by', {
                    author: version.createdByName ?? t('unknownAuthor'),
                    date: format.dateTime(new Date(version.createdAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }),
                  })}
                </p>
                <p className="text-sm break-words">
                  {version.changeSummary ?? (
                    <span className="text-muted-foreground">
                      {DOCUMENT_VERSION_MESSAGES.noSummary}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('hash')}{' '}
                  <code title={version.contentHash}>
                    {version.contentHash.slice(0, DOCUMENT_VERSION_LIMITS.hashPrefix)}
                  </code>
                </p>
              </div>
              {previous ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onCompare({ from: previous.id, to: version.id });
                  }}
                >
                  {t('compareWithPrevious')}
                  <span className="sr-only">
                    {' '}
                    {t('compareWithPreviousTarget', { number: version.versionNumber })}
                  </span>
                </Button>
              ) : null}
            </div>
            {pdfEnabled ? (
              <GeneratePdfButton
                source={{
                  kind: 'version',
                  versionId: version.id,
                  versionNumber: version.versionNumber,
                }}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// --- VersionComparePicker -----------------------------------------------------------------------

function VersionComparePicker({
  versions,
  selection,
  onCompare,
}: {
  readonly versions: readonly DocumentVersionSummaryDto[];
  readonly selection: Selection | null;
  readonly onCompare: (selection: Selection) => void;
}) {
  const t = useTranslations('documents.versions');
  const id = useId();
  const [from, setFrom] = useState(selection?.from ?? versions[1]?.id ?? '');
  const [to, setTo] = useState(selection?.to ?? versions[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  // "Comparar com a anterior" também preenche o seletor.
  const [synced, setSynced] = useState(selection);
  if (selection !== synced) {
    setSynced(selection);
    if (selection) {
      setFrom(selection.from);
      setTo(selection.to);
      setError(null);
    }
  }

  const option = (version: DocumentVersionSummaryDto) => (
    <option key={version.id} value={version.id}>
      {t('number', { number: version.versionNumber })} — {t(`reasons.${version.reason}`)}
    </option>
  );

  return (
    <form
      aria-label={t('picker.label')}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (from === to) {
          setError(DOCUMENT_VERSION_MESSAGES.sameVersion);
          return;
        }
        setError(null);
        onCompare({ from, to });
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-from`} className="text-sm font-medium">
            {t('picker.from')}
          </label>
          <select
            id={`${id}-from`}
            className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
            value={from}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setFrom(event.target.value);
              setError(null);
            }}
          >
            {versions.map(option)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-to`} className="text-sm font-medium">
            {t('picker.to')}
          </label>
          <select
            id={`${id}-to`}
            className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
            value={to}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setTo(event.target.value);
              setError(null);
            }}
          >
            {versions.map(option)}
          </select>
        </div>
        <Button type="submit" variant="primary">
          {t('picker.compare')}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// --- VersionDiffView ----------------------------------------------------------------------------

function VersionComparison({
  documentId,
  selection,
}: {
  readonly documentId: string;
  readonly selection: Selection;
}) {
  const t = useTranslations('documents.versions');
  const tenantId = useTenantId();
  const comparison = useQuery({
    queryKey: versionKeys.compare(tenantId, documentId, selection.from, selection.to),
    queryFn: ({ signal }) =>
      compareDocumentVersions(documentId, selection.from, selection.to, signal),
    throwOnError: false,
  });
  if (comparison.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('diff.loading')}</span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (comparison.isError) {
    const detail = isApiError(comparison.error)
      ? (comparison.error.errors[0]?.message ?? null)
      : null;
    return (
      <Alert tone="error" title={detail ?? t('diff.failed')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => {
            void comparison.refetch();
          }}
        >
          {t('reload')}
        </Button>
      </Alert>
    );
  }
  return <VersionDiffView comparison={comparison.data} />;
}

const CHANGE_TONES: Record<VersionChangeType, string> = {
  ADDED: 'bg-success-soft text-foreground',
  REMOVED: 'bg-destructive-soft text-foreground',
  CHANGED: 'bg-warning-soft text-foreground',
  UNCHANGED: 'bg-muted text-muted-foreground',
  MASKED: 'bg-muted text-foreground',
};

/** Indicador de mudança: o texto ("Alterado", "Valor sigiloso"…) diz a situação, nunca só a cor. */
function ChangeBadge({ changeType }: { readonly changeType: VersionChangeType }) {
  const t = useTranslations('documents.versions.changes');
  return (
    <span
      data-change={changeType}
      className={`inline-flex items-center rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHANGE_TONES[changeType]}`}
    >
      {t(changeType)}
    </span>
  );
}

const KNOWN_FIELDS = [
  'document.title',
  'document.code',
  'document.confidentiality',
  'template.versionNumber',
  'file.attachmentId',
  'file.sha256',
] as const;
type KnownField = (typeof KNOWN_FIELDS)[number];
const isKnownField = (field: string): field is KnownField =>
  (KNOWN_FIELDS as readonly string[]).includes(field);

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** `VersionDiffView` — os três blocos do DOC-18 lado a lado (empilhados em telas estreitas). */
export function VersionDiffView({
  comparison,
}: {
  readonly comparison: DocumentVersionComparisonDto;
}) {
  const t = useTranslations('documents.versions');
  const fromLabel = t('number', { number: comparison.from.versionNumber });
  const toLabel = t('number', { number: comparison.to.versionNumber });
  const nothing =
    comparison.header.length === 0 &&
    comparison.sections.length === 0 &&
    comparison.collections.length === 0;
  if (nothing) return <p className="text-sm text-muted-foreground">{t('diff.empty')}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {comparison.kind === 'UPLOADED' ? (
        <p className="text-sm text-muted-foreground">{t('diff.uploadedNote')}</p>
      ) : null}
      {comparison.header.length > 0 ? (
        <HeaderBlock entries={comparison.header} fromLabel={fromLabel} toLabel={toLabel} />
      ) : null}
      {comparison.sections.length > 0 ? (
        <SectionsBlock entries={comparison.sections} fromLabel={fromLabel} toLabel={toLabel} />
      ) : null}
      {comparison.collections.length > 0 ? (
        <CollectionsBlock
          entries={comparison.collections}
          fromLabel={fromLabel}
          toLabel={toLabel}
        />
      ) : null}
    </div>
  );
}

interface BlockProps<T> {
  readonly entries: readonly T[];
  readonly fromLabel: string;
  readonly toLabel: string;
}

function MaskedValue() {
  const t = useTranslations('documents.versions');
  return (
    <span>
      — <span className="text-xs text-muted-foreground">({t('changes.MASKED')})</span>
    </span>
  );
}

/**
 * Tabela rolável na horizontal em telas estreitas: região nomeada e focável para quem navega por
 * teclado (axe `scrollable-region-focusable`).
 */
function ScrollRegion({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- região rolável precisa de foco (axe)
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto">
      {children}
    </div>
  );
}

function HeaderBlock({ entries, fromLabel, toLabel }: BlockProps<HeaderDiff>) {
  const t = useTranslations('documents.versions');
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="font-semibold">{t('diff.header')}</h3>
      <ScrollRegion label={t('diff.header')}>
        <table aria-label={t('diff.header')} className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2 pr-3">
                {t('diff.field')}
              </th>
              <th scope="col" className="py-2 pr-3">
                {fromLabel}
              </th>
              <th scope="col" className="py-2 pr-3">
                {toLabel}
              </th>
              <th scope="col" className="py-2">
                {t('diff.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.field} className="border-b border-border align-top">
                <th scope="row" className="py-2 pr-3 font-medium">
                  {isKnownField(entry.field) ? t(`fields.${entry.field}`) : entry.field}
                </th>
                <td className="py-2 pr-3 break-words">
                  {entry.changeType === 'MASKED' ? <MaskedValue /> : display(entry.from)}
                </td>
                <td className="py-2 pr-3 break-words">
                  {entry.changeType === 'MASKED' ? <MaskedValue /> : display(entry.to)}
                </td>
                <td className="py-2">
                  <ChangeBadge changeType={entry.changeType} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </section>
  );
}

function SectionText({
  label,
  side,
}: {
  readonly label: string;
  readonly side: SectionSide | null;
}) {
  const t = useTranslations('documents.versions');
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {side === null ? (
        <p className="text-sm text-muted-foreground">{t('diff.absent')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t(`sectionStates.${side.state}`)}</p>
          {side.text ? (
            <p className="text-sm break-words whitespace-pre-line">{side.text}</p>
          ) : null}
          {side.justification ? (
            <p className="text-sm break-words whitespace-pre-line">
              {t('diff.justification', { text: side.justification })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function SectionsBlock({ entries, fromLabel, toLabel }: BlockProps<SectionDiff>) {
  const t = useTranslations('documents.versions');
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="font-semibold">{t('diff.sections')}</h3>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.sectionKey} className="rounded-card border border-border bg-surface p-3">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <span className="font-medium break-all">{entry.sectionKey}</span>
                <ChangeBadge changeType={entry.changeType} />
                <span className="text-xs text-primary underline">{t('diff.openText')}</span>
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <SectionText label={fromLabel} side={entry.from} />
                <SectionText label={toLabel} side={entry.to} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function rowSummary(row: Readonly<Record<string, unknown>> | null, masked: readonly string[]) {
  if (row === null) return '—';
  return Object.entries(row)
    .filter(([key]) => !key.endsWith('Masked'))
    .map(([key, value]) => `${key}: ${masked.includes(key) ? '—' : display(value)}`)
    .join(' · ');
}

function CollectionsBlock({ entries, fromLabel, toLabel }: BlockProps<CollectionDiff>) {
  const t = useTranslations('documents.versions');
  const groups = [...new Set(entries.map((entry) => entry.collection))];
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h3 className="font-semibold">{t('diff.collections')}</h3>
      {groups.map((collection) => (
        <div key={collection} className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-medium">{collection}</h4>
          <ScrollRegion label={collection}>
            <table aria-label={collection} className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-3">
                    {t('diff.item')}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {fromLabel}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {toLabel}
                  </th>
                  <th scope="col" className="py-2">
                    {t('diff.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries
                  .filter((entry) => entry.collection === collection)
                  .map((entry) => (
                    <tr
                      key={`${entry.collection}:${entry.itemId}`}
                      className={`border-b border-border align-top ${entry.changeType === 'UNCHANGED' ? '' : 'bg-warning-soft/40'}`}
                    >
                      <th scope="row" className="py-2 pr-3 font-medium break-all">
                        {entry.itemId}
                      </th>
                      <td className="py-2 pr-3 break-words">
                        {rowSummary(entry.from, entry.maskedFields)}
                      </td>
                      <td className="py-2 pr-3 break-words">
                        {rowSummary(entry.to, entry.maskedFields)}
                      </td>
                      <td className="flex flex-col items-start gap-1 py-2">
                        <ChangeBadge changeType={entry.changeType} />
                        {entry.changedFields.length > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t('diff.changedFields', { fields: entry.changedFields.join(', ') })}
                          </span>
                        ) : null}
                        {entry.maskedFields.length > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t('diff.maskedFields', { fields: entry.maskedFields.join(', ') })}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </ScrollRegion>
        </div>
      ))}
    </section>
  );
}
