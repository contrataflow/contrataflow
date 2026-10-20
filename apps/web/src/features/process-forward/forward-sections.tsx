'use client';

import { Button, cx } from '@contrataflow/ui';
import type { ActionEntry, ProcessDocumentDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { isApprovalDestination, reasonsText, resolveDocumentId } from './forward-model';
import type { ForwardRule } from './forward-model';
import { FormField, INPUT_CLASS } from '../processes/form-field';

/*
 * Blocos do painel "Encaminhar processo" (SCR-103): "Para onde", busca de unidade/pessoa, documentos
 * e "Pendências e avisos". Só apresentação — o estado e os envios ficam em `ForwardPanel`.
 */

/** Espera curta entre teclas antes de buscar (DEP-02/USR-02). */
const SEARCH_DEBOUNCE_MS = 250;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return debounced;
}

// ---- Para onde --------------------------------------------------------------------------------

export function TransitionGroup({
  id,
  entries,
  selectedId,
  error,
  onSelect,
}: {
  readonly id: string;
  readonly entries: readonly ActionEntry[];
  readonly selectedId: string | null;
  readonly error: string | undefined;
  readonly onSelect: (transitionId: string) => void;
}) {
  const t = useTranslations('processes.forward.transition');
  const name = useId();
  const errorId = `${id}-error`;
  const focusable = entries.find((entry) => entry.transitionId === selectedId) ?? entries[0];
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="mb-1 text-sm font-semibold">{t('legend')}</legend>
      {entries.map((entry, index) => {
        const transitionId = entry.transitionId ?? '';
        const checked = transitionId === selectedId;
        const disabled = !entry.enabled;
        const detailId = `${name}-detail-${String(index)}`;
        const details = [
          entry.toStageName === undefined ? null : t('stage', { stage: entry.toStageName }),
          entry.departmentResolution?.departmentName === undefined
            ? null
            : t('department', { department: entry.departmentResolution.departmentName }),
          (entry.approverPreview ?? null) === null
            ? null
            : t('approver', { approver: entry.approverPreview?.label ?? '' }),
        ].filter((text) => text !== null);
        const radioId = entry === focusable ? id : `${name}-${String(index)}`;
        return (
          <div
            key={transitionId}
            className={cx(
              'flex min-w-0 items-start gap-3 rounded-control border p-3 text-sm',
              checked ? 'border-primary bg-primary-soft' : 'border-border',
              disabled && 'cursor-not-allowed opacity-70',
            )}
          >
            <input
              type="radio"
              name={name}
              id={radioId}
              value={transitionId}
              className="mt-1 size-4 flex-none"
              checked={checked}
              disabled={disabled}
              aria-describedby={detailId}
              onChange={() => {
                onSelect(transitionId);
              }}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={radioId} className="font-medium break-words">
                {entry.label}
              </label>
              <span id={detailId} className="text-xs break-words text-muted-foreground">
                {disabled
                  ? t('unavailable', { reasons: reasonsText(entry) })
                  : details.length > 0
                    ? details.join(' · ')
                    : null}
              </span>
            </div>
          </div>
        );
      })}
      {error ? (
        <p id={errorId} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

// ---- Unidade e responsável --------------------------------------------------------------------

export interface LookupOption {
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
}

/**
 * Busca com os resultados como botões (teclado e leitor de tela); a escolha troca o campo pelo nome
 * e o botão "Trocar". Com `minChars` 0 a lista já aparece ao abrir (DEP-02: até 50 unidades).
 */
export function LookupPicker({
  id,
  label,
  hint,
  error,
  required,
  selected,
  onSelect,
  queryKeyFor,
  search,
  minChars,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error: string | undefined;
  readonly required?: boolean;
  readonly selected: { readonly id: string; readonly name: string } | null;
  readonly onSelect: (item: { readonly id: string; readonly name: string } | null) => void;
  readonly queryKeyFor: (q: string) => QueryKey;
  readonly search: (q: string, signal: AbortSignal) => Promise<LookupOption[]>;
  readonly minChars: number;
}) {
  const t = useTranslations('processes.forward.lookup');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const enabled = selected === null && q.length >= minChars;
  const results = useQuery({
    queryKey: queryKeyFor(q),
    queryFn: ({ signal }) => search(q, signal),
    enabled,
    throwOnError: false,
  });

  if (selected !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm break-words">{t('selected', { name: selected.name })}</span>
          <Button
            id={id}
            size="sm"
            variant="secondary"
            onClick={() => {
              onSelect(null);
              setText('');
            }}
          >
            {t('change')}
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-destructive" aria-live="polite">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const items = results.data ?? [];
  return (
    <FormField id={id} label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <div className="flex min-w-0 flex-col gap-1">
          <input
            {...control}
            type="search"
            autoComplete="off"
            className={INPUT_CLASS}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          {enabled ? (
            <div aria-live="polite" className="text-sm">
              {results.isFetching ? (
                <p className="text-muted-foreground">{t('searching')}</p>
              ) : results.isError ? (
                <p className="text-destructive">{t('searchFailed')}</p>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground">{t('noResults')}</p>
              ) : (
                <ul
                  aria-label={t('results', { label })}
                  className="flex max-h-48 flex-col gap-1 overflow-y-auto"
                >
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="w-full rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:bg-muted"
                        onClick={() => {
                          onSelect({ id: item.id, name: item.name });
                        }}
                      >
                        <span className="block">{item.name}</span>
                        {item.detail === null ? null : (
                          <span className="block text-xs text-muted-foreground">{item.detail}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </FormField>
  );
}

// ---- Documentos -------------------------------------------------------------------------------

export function DocumentsChecklist({
  id,
  documents,
  selected,
  locked,
  entry,
  error,
  onToggle,
}: {
  readonly id: string;
  readonly documents: readonly ProcessDocumentDto[];
  readonly selected: readonly string[];
  readonly locked: readonly string[];
  readonly entry: ActionEntry | undefined;
  readonly error: string | undefined;
  readonly onToggle: (documentId: string, checked: boolean) => void;
}) {
  const t = useTranslations('processes.forward.documents');
  const tStatus = useTranslations('documents.statuses');
  const errorId = `${id}-error`;
  if (documents.length === 0) {
    return (
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="text-sm font-semibold">{t('legend')}</legend>
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      </fieldset>
    );
  }
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-sm font-semibold">{t('legend')}</legend>
      <p className="text-xs text-muted-foreground">
        {isApprovalDestination(entry) ? t('hintApproval') : t('hint')}
      </p>
      <ul className="flex flex-col gap-1">
        {documents.map((document, index) => {
          const isLocked = locked.includes(document.id);
          return (
            <li key={document.id}>
              <label className="flex min-w-0 items-start gap-2 rounded-control p-1 text-sm">
                <input
                  type="checkbox"
                  id={index === 0 ? id : undefined}
                  className="mt-1 size-4 flex-none"
                  checked={selected.includes(document.id)}
                  disabled={isLocked}
                  onChange={(event) => {
                    onToggle(document.id, event.target.checked);
                  }}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words">{document.title}</span>
                  <span className="text-xs break-words text-muted-foreground">
                    {[document.documentType.name, document.code, tStatus(document.status)]
                      .filter((text) => text !== null && text !== '')
                      .join(' · ')}
                  </span>
                  {isLocked ? (
                    <span className="text-xs font-medium text-primary">{t('willSubmit')}</span>
                  ) : null}
                  {document.pendingApprovalId === null ? null : (
                    <span className="text-xs font-medium text-warning">{t('inApproval')}</span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t('count', { count: selected.length })}</p>
      {error ? (
        <p id={errorId} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

// ---- Pendências e avisos ----------------------------------------------------------------------

export function RulesSection({
  id,
  processId,
  rules,
  documents,
  acknowledged,
  error,
  acknowledgeLabel,
  onAcknowledge,
  onResolve,
}: {
  readonly id: string;
  readonly processId: string;
  readonly rules: readonly ForwardRule[];
  readonly documents: readonly ProcessDocumentDto[];
  readonly acknowledged: readonly string[];
  readonly error: string | undefined;
  /** Rótulo da confirmação de cada aviso (padrão: o do encaminhamento; US-010 tem o seu). */
  readonly acknowledgeLabel?: string | undefined;
  readonly onAcknowledge: (ruleId: string, checked: boolean) => void;
  /** "Resolver" sem documento leva a `#pendencias`: o painel fecha para mostrar a página. */
  readonly onResolve: () => void;
}) {
  const t = useTranslations('processes.forward.rules');
  const headingId = useId();
  const blocking = rules.filter((rule) => rule.severity === 'BLOCKING');
  const warnings = rules.filter((rule) => rule.severity === 'WARNING');
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('title')}
      </h3>
      <p role="status" aria-live="polite" className="text-sm">
        {rules.length === 0
          ? t('none')
          : t('counts', { blocking: blocking.length, warnings: warnings.length })}
      </p>
      {blocking.length > 0 ? (
        <ul aria-label={t('blockingList')} className="flex flex-col gap-2">
          {blocking.map((rule) => {
            const documentId = resolveDocumentId(rule, documents);
            return (
              <li
                key={rule.ruleId}
                className="flex min-w-0 flex-col gap-1 rounded-control border border-destructive/40 bg-destructive-soft p-3 text-sm"
              >
                <span className="text-xs font-semibold uppercase">{t('blocking')}</span>
                <span className="font-medium break-words">{rule.message}</span>
                {documentId === null ? (
                  <a
                    href="#pendencias"
                    className="text-xs text-primary underline"
                    onClick={onResolve}
                  >
                    {t('resolve')}
                  </a>
                ) : (
                  <Link
                    href={`/processos/${processId}/documentos/${documentId}`}
                    className="text-xs text-primary underline"
                  >
                    {t('resolve')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul
          id={id}
          tabIndex={-1}
          aria-label={t('warningList')}
          aria-describedby={error ? `${id}-error` : undefined}
          className="flex flex-col gap-2 outline-none"
        >
          {warnings.map((rule) => {
            const messageId = `${id}-${rule.ruleId}`;
            return (
              <li
                key={rule.ruleId}
                className="flex min-w-0 flex-col gap-2 rounded-control border border-warning/30 bg-warning-soft p-3 text-sm"
              >
                <span className="text-xs font-semibold uppercase">{t('warning')}</span>
                <span id={messageId} className="break-words">
                  {rule.message}
                </span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 flex-none"
                    checked={acknowledged.includes(rule.ruleId)}
                    aria-describedby={messageId}
                    onChange={(event) => {
                      onAcknowledge(rule.ruleId, event.target.checked);
                    }}
                  />
                  {acknowledgeLabel ?? t('acknowledge')}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </section>
  );
}
