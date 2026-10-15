'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';

import {
  EXTENSION_OPTIONS,
  MASK_TOKENS,
  SELECT_OPTIONS,
  fieldKindOf,
  isLowContrast,
} from './settings-model';
import type { Draft } from './settings-model';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface SettingFieldProps {
  readonly settingKey: string;
  readonly draft: Draft;
  /** Valor gravado (para o rótulo "padrão ainda não gravado"). */
  readonly version: number;
  readonly onChange: (draft: Draft) => void;
  readonly disabled: boolean;
  /** Mensagem de erro já traduzida (rascunho inválido ou resposta 422 da API). */
  readonly error?: string | undefined;
}

/**
 * `SettingField` (SCR-041 · US-103): renderiza o editor certo pelo tipo do schema da chave — texto,
 * interruptor, número, seleção, cor, lista de extensões ou JSON — com rótulo e descrição
 * associados (`aria-describedby`) e o erro em `aria-live`.
 */
export function SettingField({
  settingKey,
  draft,
  version,
  onChange,
  disabled,
  error,
}: SettingFieldProps) {
  const t = useTranslations('settings');
  const id = useId();
  const kind = fieldKindOf(settingKey);
  const isFlag = settingKey.startsWith('features.');
  const name = settingKey.slice('features.'.length);

  // As chaves do registro são dinâmicas (os textos aninham pelo ponto da chave): o cast só informa
  // ao tipo das mensagens que o caminho existe — um teste confere os 32 caminhos.
  const label = isFlag
    ? t('field.featureFlag', { name })
    : t(`fields.${settingKey}.label` as 'fields.labels.secretariat.label');
  const description = isFlag
    ? t('field.featureFlagHint')
    : t(`fields.${settingKey}.description` as 'fields.labels.secretariat.description', MASK_TOKENS);
  const describedBy = [`${id}-description`, error ? `${id}-error` : undefined, `${id}-version`]
    .filter(Boolean)
    .join(' ');

  const common = {
    id,
    disabled,
    'aria-describedby': describedBy,
    'aria-invalid': error ? (true as const) : undefined,
  };
  const text = typeof draft === 'string' ? draft : '';

  let editor;
  switch (kind) {
    case 'boolean':
      editor = (
        <input
          {...common}
          type="checkbox"
          role="switch"
          className="h-5 w-5"
          checked={draft === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      );
      break;
    case 'select':
      editor = (
        <select
          {...common}
          className={INPUT}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {(SELECT_OPTIONS[settingKey] ?? []).map((option) => (
            <option key={option} value={option}>
              {t(`options.${option}` as 'options.NONE')}
            </option>
          ))}
        </select>
      );
      break;
    case 'color':
      editor = (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t('field.colorPicker')}
            disabled={disabled}
            className="h-10 w-12 rounded-control border border-border bg-surface p-1"
            value={/^#[0-9A-Fa-f]{6}$/.test(text) ? text : '#000000'}
            onChange={(event) => {
              onChange(event.target.value.toUpperCase());
            }}
          />
          <input
            {...common}
            className={`${INPUT} w-32 font-mono`}
            value={text}
            maxLength={7}
            spellCheck={false}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <span
            aria-hidden="true"
            className="h-10 min-w-24 rounded-control px-3 text-center text-sm leading-10 text-white"
            style={{ backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(text) ? text : '#000000' }}
          >
            Aa
          </span>
        </div>
      );
      break;
    case 'extensions':
      editor = (
        <fieldset
          disabled={disabled}
          aria-describedby={describedBy}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          <legend className="sr-only">{label}</legend>
          {EXTENSION_OPTIONS.map((extension) => {
            const selected = Array.isArray(draft) && draft.includes(extension);
            return (
              <label key={extension} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(draft) ? (draft as string[]) : [];
                    onChange(
                      event.target.checked
                        ? EXTENSION_OPTIONS.filter(
                            (item) => item === extension || current.includes(item),
                          )
                        : current.filter((item) => item !== extension),
                    );
                  }}
                />
                <span className="font-mono">{extension}</span>
              </label>
            );
          })}
        </fieldset>
      );
      break;
    case 'json':
      editor = (
        <textarea
          {...common}
          rows={8}
          spellCheck={false}
          className="rounded-control border border-border bg-surface p-3 font-mono text-sm"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
      break;
    case 'readonly':
      editor = (
        <p id={id} className="text-sm text-muted-foreground">
          {text === '' ? t('field.noLogo') : text}
        </p>
      );
      break;
    case 'integer':
    case 'number':
      editor = (
        <input
          {...common}
          type="text"
          inputMode={kind === 'integer' ? 'numeric' : 'decimal'}
          className={`${INPUT} w-40`}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
      break;
    default:
      editor = (
        <input
          {...common}
          className={`${INPUT} ${kind === 'mask' ? 'font-mono' : ''}`}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
  }

  const contrastWarning = kind === 'color' && isLowContrast(text);
  const isBoolean = kind === 'boolean';
  return (
    <div
      className={`flex flex-col gap-1 ${isBoolean ? 'sm:flex-row sm:items-start sm:gap-3' : ''}`}
    >
      {isBoolean ? <div className="pt-0.5">{editor}</div> : null}
      <div className="flex flex-1 flex-col gap-1">
        {kind === 'extensions' ? (
          <span className="text-sm font-medium">{label}</span>
        ) : (
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
        )}
        {isBoolean ? null : editor}
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive" aria-live="polite">
            {error}
          </p>
        ) : null}
        {contrastWarning && !error ? (
          <p className="text-sm text-destructive" aria-live="polite">
            {t('field.contrast')}
          </p>
        ) : null}
        <p id={`${id}-version`} className="text-xs text-muted-foreground">
          {version === 0 ? t('field.defaultHint') : t('field.versionHint', { version })}
        </p>
      </div>
    </div>
  );
}
