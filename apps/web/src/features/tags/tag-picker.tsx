'use client';

import { TAG_LIMITS } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { TagChip } from './tag-chip';
import { atLimit, filterOptions, nextSelection, quickCreateName } from './tag-model';
import type { PickerOption } from './tag-model';

export interface TagPickerProps {
  /** Opções já resolvidas (ativas + inativas já aplicadas — `pickerOptions`). */
  readonly options: readonly PickerOption[];
  /** Todos os nomes do cadastro (inclusive inativas): evita oferecer criar um nome que já existe. */
  readonly knownNames: readonly { readonly name: string }[];
  readonly selected: readonly string[];
  readonly onSelectedChange: (selected: string[]) => void;
  /** Com `TAG_MANAGE`: oferece "Criar etiqueta" para um nome inexistente (FA-01). */
  readonly canCreate: boolean;
  readonly onCreate: (name: string) => void;
  readonly creating: boolean;
  /** Mensagem de erro da criação rápida, quando houver. */
  readonly createError: string | null;
  readonly disabled: boolean;
}

/**
 * `TagPicker` (US-007 · SCR-006): combobox ARIA de multisseleção com busca, contador "3/10" e
 * criação rápida. Setas movem a opção ativa (`aria-activedescendant`), Enter marca/desmarca;
 * a quantidade marcada é anunciada por `aria-live`. Inativa já aplicada só pode ser removida.
 */
export function TagPicker({
  options,
  knownNames,
  selected,
  onSelectedChange,
  canCreate,
  onCreate,
  creating,
  createError,
  disabled,
}: TagPickerProps) {
  const t = useTranslations('tags.picker');
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const visible = filterOptions(options, query);
  const createName = canCreate && !creating ? quickCreateName(query, knownNames) : null;
  const rows = visible.length + (createName === null ? 0 : 1);
  const current = rows === 0 ? -1 : Math.min(active, rows - 1);
  const optionId = (index: number) => `${baseId}-option-${String(index)}`;
  const full = atLimit(selected);

  const blocked = (option: PickerOption): boolean =>
    disabled || (!selected.includes(option.id) && (full || !option.isActive));

  const toggle = (option: PickerOption) => {
    if (blocked(option)) return;
    onSelectedChange(nextSelection(selected, option.id));
  };

  const activate = (index: number) => {
    const option = visible[index];
    if (option) toggle(option);
    else if (createName !== null && !disabled) onCreate(createName);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (rows === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % rows);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + rows) % rows);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setActive(rows - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current >= 0) activate(current);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {t('search')}
        </label>
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {t('counter', { count: selected.length, max: TAG_LIMITS.perProcess })}
        </span>
      </div>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={options.length === 0 && createName === null ? undefined : listId}
        aria-autocomplete="list"
        aria-describedby={hintId}
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        autoComplete="off"
        maxLength={TAG_LIMITS.nameMax}
        className="h-11 rounded-control border border-border bg-surface px-3 text-sm md:h-9"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <p id={hintId} className="sr-only">
        {t('searchHint')}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {t('announce', { count: selected.length, max: TAG_LIMITS.perProcess })}
      </p>

      {options.length === 0 && createName === null ? (
        <p className="rounded-card border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {canCreate ? t('emptyManage') : t('empty')}
        </p>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={t('listLabel')}
          aria-multiselectable="true"
          className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-card border border-border p-1"
        >
          {visible.map((option, index) => {
            const isSelected = selected.includes(option.id);
            const isBlocked = blocked(option);
            return (
              <div key={option.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={optionId(index)}
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={isBlocked || undefined}
                  title={!option.isActive ? t('inactiveHint') : undefined}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left text-sm md:min-h-9 ${
                    current === index ? 'bg-muted' : ''
                  } ${isBlocked ? 'cursor-not-allowed opacity-70' : 'hover:bg-muted'}`}
                  onClick={() => {
                    setActive(index);
                    toggle(option);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-4 shrink-0 items-center justify-center rounded border border-border text-xs"
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                  <TagChip name={option.name} color={option.color} isActive={option.isActive} />
                </button>
              </div>
            );
          })}
          {createName === null ? null : (
            <div role="presentation">
              <button
                type="button"
                role="option"
                id={optionId(visible.length)}
                tabIndex={-1}
                aria-selected={false}
                aria-disabled={disabled || undefined}
                className={`flex min-h-11 w-full items-center rounded-control px-2 text-left text-sm font-medium text-primary md:min-h-9 ${
                  current === visible.length ? 'bg-muted' : 'hover:bg-muted'
                }`}
                onClick={() => {
                  if (!disabled) onCreate(createName);
                }}
              >
                {t('create', { name: createName })}
              </button>
            </div>
          )}
        </div>
      )}

      {options.length > 0 && visible.length === 0 && createName === null ? (
        <p className="text-sm text-muted-foreground">{t('noResults')}</p>
      ) : null}
      {creating ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('creating')}
        </p>
      ) : null}
      {createError ? (
        <p role="alert" className="text-sm text-destructive">
          {createError}
        </p>
      ) : null}
      {full ? (
        <p className="text-xs text-muted-foreground">
          {t('limitReached', { max: TAG_LIMITS.perProcess })}
        </p>
      ) : null}
    </div>
  );
}
