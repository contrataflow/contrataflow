'use client';

import { Button } from '@contrataflow/ui';
import type { RuleContextSchemaDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import {
  conditionOf,
  conditionToJsonLogic,
  fieldTypesOf,
  isUnary,
  newConditionRow,
  operatorsFor,
  withRowPath,
} from './workflow-rules-model';
import type {
  Combinator,
  ConditionOperator,
  ConditionRow,
  ConditionTree,
  RuleDraft,
} from './workflow-rules-model';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';

/**
 * `ConditionBuilder` (US-044 · RN-WF-58): combinador E/OU e linhas campo/operador/valor sobre os
 * campos do RuleContext (WF-19), gerando JSON Logic no cliente; "Editar como JSON" é a alternativa
 * para expressões que o construtor não representa. Tudo em controles nativos (navegável por
 * teclado); a API revalida a whitelist de operações antes de qualquer execução.
 */
export function ConditionBuilder({
  draft,
  schema,
  errors,
  disabled,
  onChange,
}: {
  readonly draft: RuleDraft;
  readonly schema: RuleContextSchemaDto;
  /** Erros por `condition.N` e `config.expression`. */
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<RuleDraft>) => void;
}) {
  const t = useTranslations('workflows.rules.condition');
  const ids = useId();
  const types = fieldTypesOf(schema);
  const tree = draft.condition;

  const setTree = (next: ConditionTree) => {
    onChange({ condition: next });
  };
  const setRow = (index: number, row: ConditionRow) => {
    setTree({ ...tree, rows: tree.rows.map((item, at) => (at === index ? row : item)) });
  };

  if (draft.conditionMode === 'json') {
    const representable = (() => {
      try {
        return conditionOf(JSON.parse(draft.conditionJson)) !== null;
      } catch {
        return false;
      }
    })();
    return (
      <fieldset className="flex flex-col gap-2 rounded-card border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
        {representable ? null : (
          <p className="text-xs text-muted-foreground">{t('notRepresentable')}</p>
        )}
        <label htmlFor={`${ids}-json`} className="text-sm font-medium">
          {t('json')}
        </label>
        <textarea
          id={`${ids}-json`}
          className="min-h-40 w-full rounded-control border border-border bg-surface p-3 font-mono text-xs"
          value={draft.conditionJson}
          disabled={disabled}
          aria-invalid={errors['config.expression'] ? true : undefined}
          aria-describedby={`${ids}-json-hint${errors['config.expression'] ? ` ${ids}-json-error` : ''}`}
          onChange={(event) => {
            onChange({ conditionJson: event.target.value });
          }}
        />
        <p id={`${ids}-json-hint`} className="text-xs text-muted-foreground">
          {t('jsonHint')}
        </p>
        {errors['config.expression'] ? (
          <p id={`${ids}-json-error`} className="text-sm text-destructive">
            {errors['config.expression']}
          </p>
        ) : null}
        {representable ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => {
                const parsed = conditionOf(JSON.parse(draft.conditionJson));
                if (parsed) onChange({ condition: parsed, conditionMode: 'builder' });
              }}
            >
              {t('builderMode')}
            </Button>
          </div>
        ) : null}
      </fieldset>
    );
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-card border border-border p-3">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-combinator`} className="text-sm">
          {t('combinator')}
        </label>
        <select
          id={`${ids}-combinator`}
          className={INPUT}
          value={tree.combinator}
          disabled={disabled}
          onChange={(event) => {
            setTree({ ...tree, combinator: event.target.value as Combinator });
          }}
        >
          <option value="and">{t('and')}</option>
          <option value="or">{t('or')}</option>
        </select>
      </div>
      {tree.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {tree.rows.map((row, index) => {
            const position = index + 1;
            const type = types.get(row.path) ?? 'string';
            const error = errors[`condition.${String(index)}`];
            const errorId = `${ids}-row-${String(index)}-error`;
            return (
              <li
                // A posição identifica a linha (linhas não têm id; remover reindexa a lista).
                key={index}
                className="grid gap-2 rounded-control bg-muted p-2 md:grid-cols-[2fr_1.4fr_1.4fr_auto] md:items-end"
              >
                <select
                  aria-label={t('field', { position })}
                  className={INPUT}
                  value={row.path}
                  disabled={disabled}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => {
                    const path = event.target.value;
                    setRow(index, withRowPath(row, path, types.get(path) ?? 'string'));
                  }}
                >
                  {types.has(row.path) ? null : <option value={row.path}>{row.path}</option>}
                  {schema.fields.map((field) => (
                    <option key={field.path} value={field.path}>
                      {field.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('operator', { position })}
                  className={INPUT}
                  value={row.operator}
                  disabled={disabled}
                  onChange={(event) => {
                    setRow(index, { ...row, operator: event.target.value as ConditionOperator });
                  }}
                >
                  {operatorsFor(type).map((operator) => (
                    <option key={operator} value={operator}>
                      {t(`operators.${operator}`)}
                    </option>
                  ))}
                </select>
                {isUnary(row.operator) ? (
                  <span aria-hidden="true" />
                ) : type === 'boolean' ? (
                  <select
                    aria-label={t('value', { position })}
                    className={INPUT}
                    value={row.value}
                    disabled={disabled}
                    onChange={(event) => {
                      setRow(index, { ...row, value: event.target.value });
                    }}
                  >
                    <option value="true">{t('true')}</option>
                    <option value="false">{t('false')}</option>
                  </select>
                ) : (
                  <input
                    aria-label={t('value', { position })}
                    className={INPUT}
                    type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                    value={row.value}
                    disabled={disabled}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(event) => {
                      setRow(index, { ...row, value: event.target.value });
                    }}
                  />
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  aria-label={t('remove', { position })}
                  onClick={() => {
                    setTree({ ...tree, rows: tree.rows.filter((_item, at) => at !== index) });
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </Button>
                {error ? (
                  <p id={errorId} className="text-sm text-destructive md:col-span-4">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {errors['config.expression'] ? (
        <p className="text-sm text-destructive">{errors['config.expression']}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || schema.fields.length === 0}
          onClick={() => {
            setTree({ ...tree, rows: [...tree.rows, newConditionRow(schema)] });
          }}
        >
          {t('add')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onChange({
              conditionMode: 'json',
              conditionJson: JSON.stringify(conditionToJsonLogic(tree, types), null, 2),
            });
          }}
        >
          {t('jsonMode')}
        </Button>
      </div>
    </fieldset>
  );
}
