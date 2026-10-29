'use client';

import {
  Button,
  DatePicker,
  Field,
  Input,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  X,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import type { RuleContextSchemaDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

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

/**
 * `ConditionBuilder` (US-044 · RN-WF-58): combinador E/OU e linhas campo/operador/valor sobre os
 * campos do RuleContext (WF-19), gerando JSON Logic no cliente; "Editar como JSON" é a alternativa
 * para expressões que o construtor não representa. Controles do kit (navegáveis por teclado); a
 * API revalida a whitelist de operações antes de qualquer execução.
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
      <fieldset className="flex flex-col gap-3 rounded-control border border-border p-3">
        <legend className="px-1 text-sm font-semibold">{t('legend')}</legend>
        {representable ? null : (
          <p className="text-[0.8125rem] text-muted-foreground">{t('notRepresentable')}</p>
        )}
        <Field
          label={t('json')}
          description={t('jsonHint')}
          error={errors['config.expression']}
          disabled={disabled}
        >
          <Textarea
            rows={8}
            className="font-mono text-xs"
            value={draft.conditionJson}
            onChange={(event) => {
              onChange({ conditionJson: event.target.value });
            }}
          />
        </Field>
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
    <fieldset className="flex flex-col gap-3 rounded-control border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{t('legend')}</legend>
      <Field label={t('combinator')} disabled={disabled}>
        <Select
          value={tree.combinator}
          onValueChange={(value) => {
            setTree({ ...tree, combinator: value as Combinator });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">{t('and')}</SelectItem>
            <SelectItem value="or">{t('or')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {tree.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {tree.rows.map((row, index) => {
            const position = index + 1;
            const type = types.get(row.path) ?? 'string';
            const error = errors[`condition.${String(index)}`];
            const errorId = `condicao-${String(index)}-erro`;
            const invalid = error ? true : undefined;
            const describedBy = error ? errorId : undefined;
            return (
              <li
                // A posição identifica a linha (linhas não têm id; remover reindexa a lista).
                key={index}
                className="flex flex-col gap-2 rounded-control bg-muted/60 p-2"
              >
                <Select
                  value={row.path}
                  disabled={disabled}
                  onValueChange={(path) => {
                    setRow(index, withRowPath(row, path, types.get(path) ?? 'string'));
                  }}
                >
                  <SelectTrigger
                    aria-label={t('field', { position })}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {types.has(row.path) ? null : (
                      <SelectItem value={row.path}>{row.path}</SelectItem>
                    )}
                    {schema.fields.map((field) => (
                      <SelectItem key={field.path} value={field.path}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
                  <Select
                    value={row.operator}
                    disabled={disabled}
                    onValueChange={(operator) => {
                      setRow(index, { ...row, operator: operator as ConditionOperator });
                    }}
                  >
                    <SelectTrigger aria-label={t('operator', { position })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {operatorsFor(type).map((operator) => (
                        <SelectItem key={operator} value={operator}>
                          {t(`operators.${operator}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isUnary(row.operator) ? (
                    <span aria-hidden="true" />
                  ) : type === 'boolean' ? (
                    <Select
                      value={row.value === 'false' ? 'false' : 'true'}
                      disabled={disabled}
                      onValueChange={(value) => {
                        setRow(index, { ...row, value });
                      }}
                    >
                      <SelectTrigger aria-label={t('value', { position })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">{t('true')}</SelectItem>
                        <SelectItem value="false">{t('false')}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : type === 'date' ? (
                    <DatePicker
                      aria-label={t('value', { position })}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      disabled={disabled}
                      value={fromIsoDate(row.value)}
                      onValueChange={(date) => {
                        setRow(index, { ...row, value: date ? toIsoDate(date) : '' });
                      }}
                    />
                  ) : (
                    <Input
                      aria-label={t('value', { position })}
                      type={type === 'number' ? 'number' : 'text'}
                      value={row.value}
                      disabled={disabled}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        setRow(index, { ...row, value: event.target.value });
                      }}
                    />
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    disabled={disabled}
                    aria-label={t('remove', { position })}
                    onClick={() => {
                      setTree({ ...tree, rows: tree.rows.filter((_item, at) => at !== index) });
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {error ? (
                  <p id={errorId} className="text-[0.8125rem] font-semibold text-destructive">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {errors['config.expression'] ? (
        <p className="text-[0.8125rem] font-semibold text-destructive">
          {errors['config.expression']}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconLeft={<Plus />}
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
