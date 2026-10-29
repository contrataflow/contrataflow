'use client';

import {
  Checkbox,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  fieldControlProps,
  useFieldControl,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import {
  EXTENSION_OPTIONS,
  MASK_TOKENS,
  SELECT_OPTIONS,
  documentMaskTypeOf,
  fieldKindOf,
  isLowContrast,
} from './settings-model';
import type { Draft, FieldKind } from './settings-model';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export interface SettingFieldProps {
  readonly settingKey: string;
  readonly draft: Draft;
  /** Valor gravado (para o rótulo "padrão ainda não gravado"). */
  readonly version: number;
  readonly onChange: (draft: Draft) => void;
  readonly disabled: boolean;
  /** Mensagem de erro já traduzida (rascunho inválido ou resposta 422 da API). */
  readonly error?: string | undefined;
  /** Conteúdo logo abaixo do editor, associado ao campo (ex.: prévia da máscara — US-105). */
  readonly addon?: ReactNode;
}

/**
 * `SettingField` (SCR-041 · US-103): o controle do kit certo para o tipo do schema da chave —
 * `Input` (texto, máscara, número), `Switch`, `Select`, cor com amostra, `Checkbox`es das
 * extensões ou `Textarea` do JSON — dentro de um `Field` que liga rótulo, ajuda e erro ao controle
 * (`aria-describedby`, `aria-invalid`). A versão gravada fecha a ajuda.
 */
export function SettingField({
  settingKey,
  draft,
  version,
  onChange,
  disabled,
  error,
  addon,
}: SettingFieldProps) {
  const t = useTranslations('settings');
  const id = useId();
  const kind = fieldKindOf(settingKey);
  const isFlag = settingKey.startsWith('features.');
  const name = settingKey.slice('features.'.length);

  // As chaves do registro são dinâmicas (os textos aninham pelo ponto da chave): o cast só informa
  // ao tipo das mensagens que o caminho existe — um teste confere os caminhos de todas as chaves.
  const documentType = documentMaskTypeOf(settingKey);
  let label: string;
  let description: string;
  if (isFlag) {
    label = t('field.featureFlag', { name });
    description = t('field.featureFlagHint');
  } else if (documentType !== null) {
    label = t('field.documentMask', { type: documentType });
    description = t('field.documentMaskHint', MASK_TOKENS);
  } else {
    label = t(`fields.${settingKey}.label` as 'fields.labels.secretariat.label');
    description = t(
      `fields.${settingKey}.description` as 'fields.labels.secretariat.description',
      MASK_TOKENS,
    );
  }

  const text = typeof draft === 'string' ? draft : '';
  const contrastWarning = kind === 'color' && isLowContrast(text);
  const addonId = addon ? `${id}-addon` : undefined;

  return (
    <Field
      id={id}
      group={kind === 'extensions'}
      label={label}
      description={
        <>
          {description}
          <span className="mt-0.5 block text-xs">
            {version === 0 ? t('field.defaultHint') : t('field.versionHint', { version })}
          </span>
        </>
      }
      error={error}
      disabled={disabled}
    >
      <SettingControl
        kind={kind}
        settingKey={settingKey}
        draft={draft}
        addonId={addonId}
        onChange={onChange}
      />
      {addon ? <div id={addonId}>{addon}</div> : null}
      {contrastWarning && !error ? (
        <p aria-live="polite" className="text-[0.8125rem] font-semibold text-destructive">
          {t('field.contrast')}
        </p>
      ) : null}
    </Field>
  );
}

function SettingControl({
  kind,
  settingKey,
  draft,
  addonId,
  onChange,
}: {
  readonly kind: FieldKind;
  readonly settingKey: string;
  readonly draft: Draft;
  readonly addonId: string | undefined;
  readonly onChange: (draft: Draft) => void;
}) {
  const t = useTranslations('settings');
  const field = useFieldControl();
  const text = typeof draft === 'string' ? draft : '';
  // A prévia da máscara (addon) entra na descrição do controle, depois da ajuda e do erro.
  const describedBy = [field?.describedBy, addonId].filter(Boolean).join(' ') || undefined;

  switch (kind) {
    case 'boolean':
      return (
        <Switch
          {...fieldControlProps(field, { 'aria-describedby': describedBy })}
          checked={draft === true}
          onCheckedChange={(checked) => {
            onChange(checked);
          }}
        />
      );
    case 'select':
      return (
        <Select
          value={text}
          onValueChange={onChange}
          {...(field?.disabled ? { disabled: true } : {})}
        >
          <SelectTrigger aria-describedby={describedBy} className="w-full sm:max-w-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(SELECT_OPTIONS[settingKey] ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {t(`options.${option}` as 'options.NONE')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'color': {
      const valid = HEX_COLOR.test(text);
      return (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="color"
            aria-label={t('field.colorPicker')}
            disabled={field?.disabled}
            className="h-11 w-12 rounded-control border border-border bg-surface p-1"
            value={valid ? text : '#000000'}
            onChange={(event) => {
              onChange(event.target.value.toUpperCase());
            }}
          />
          <Input
            aria-describedby={describedBy}
            className="w-36 font-mono"
            value={text}
            maxLength={7}
            spellCheck={false}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <span
            aria-hidden="true"
            className="grid h-11 min-w-24 place-items-center rounded-control px-3 text-sm font-bold text-white"
            style={{ backgroundColor: valid ? text : '#000000' }}
          >
            Aa
          </span>
        </div>
      );
    }
    case 'extensions':
      return (
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {EXTENSION_OPTIONS.map((extension) => {
            const current = Array.isArray(draft) ? (draft as string[]) : [];
            const extensionId = `${field?.id ?? settingKey}-${extension}`;
            return (
              <div key={extension} className="flex items-center gap-2.5">
                <Checkbox
                  id={extensionId}
                  checked={current.includes(extension)}
                  disabled={field?.disabled}
                  onCheckedChange={(checked) => {
                    onChange(
                      checked === true
                        ? EXTENSION_OPTIONS.filter(
                            (item) => item === extension || current.includes(item),
                          )
                        : current.filter((item) => item !== extension),
                    );
                  }}
                />
                <Label htmlFor={extensionId} className="font-mono font-normal">
                  {extension}
                </Label>
              </div>
            );
          })}
        </div>
      );
    case 'json':
      return (
        <Textarea
          aria-describedby={describedBy}
          rows={8}
          spellCheck={false}
          className="font-mono"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'readonly':
      return (
        <p id={field?.id} className="text-sm text-muted-foreground">
          {text === '' ? t('field.noLogo') : text}
        </p>
      );
    case 'integer':
    case 'number':
      return (
        <Input
          aria-describedby={describedBy}
          inputMode={kind === 'integer' ? 'numeric' : 'decimal'}
          className="w-40"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    default:
      return (
        <Input
          aria-describedby={describedBy}
          className={kind === 'mask' ? 'font-mono' : undefined}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
  }
}
