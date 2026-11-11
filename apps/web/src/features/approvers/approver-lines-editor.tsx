'use client';

import {
  Alert,
  Button,
  Combobox,
  Field,
  InfoTooltip,
  Input,
  Label,
  Switch,
} from '@contrataflow/ui';
import { APPROVAL_DECISION_POLICIES, APPROVER_LINES_LIMITS } from '@contrataflow/validation';
import type { ApprovalDecisionPolicy, ApproverType } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { newLineDraft, moveLine, withType } from './approver-lines-model';
import type { ApproverLineDraft, ApproverListProblems } from './approver-lines-model';
import { useApproverLookups } from './use-approver-lookups';
import type { ApproverLookups, ApproverOption } from './use-approver-lookups';
import { OptionSelect } from '../workflows/option-select';

const TYPES = ['DEPARTMENT_HEAD', 'USER', 'ROLE'] as const;
const RESOLUTIONS = ['REQUESTING_SECRETARIAT', 'REQUESTING_DEPARTMENT', 'FIXED'] as const;

/** `DecisionPolicySelect` (RN-APV-14): "Qualquer um aprova", "Todos aprovam", "Aprovam em sequência". */
export function DecisionPolicySelect({
  value,
  onChange,
  disabled,
}: {
  readonly value: ApprovalDecisionPolicy;
  readonly onChange: (policy: ApprovalDecisionPolicy) => void;
  readonly disabled?: boolean;
}) {
  const t = useTranslations('approverLines');
  const id = useId();
  return (
    <Field
      label={t('policy.label')}
      id={id}
      labelAddon={<InfoTooltip label={t('policy.label')}>{t('policy.help')}</InfoTooltip>}
    >
      <OptionSelect
        value={value}
        disabled={disabled}
        options={APPROVAL_DECISION_POLICIES.map((policy) => ({
          value: policy,
          label: t(`policy.${policy}`),
        }))}
        onValueChange={(next) => {
          onChange(next as ApprovalDecisionPolicy);
        }}
      />
    </Field>
  );
}

/** Nome exibido da linha: o rótulo ou o nome resolvido pelas listas de apoio. */
export function useLineName(lookups: ApproverLookups) {
  const t = useTranslations('approverLines');
  const find = (options: readonly ApproverOption[] | undefined, id: string) =>
    options?.find((option) => option.value === id)?.label;
  return (line: ApproverLineDraft): string => {
    if (line.label.trim() !== '') return line.label.trim();
    if (line.approverType === 'USER') {
      return find(lookups.users, line.approverUserId) ?? t('summary.unknown');
    }
    if (line.approverType === 'ROLE') {
      return find(lookups.roles, line.approverRoleId) ?? t('summary.unknown');
    }
    if (line.approverDepartmentResolution === 'FIXED') {
      const name = find(lookups.departments, line.approverFixedDepartmentId);
      return name ? t('summary.resolvedHead', { name }) : t('summary.unknown');
    }
    return line.approverDepartmentResolution === 'REQUESTING_DEPARTMENT'
      ? t('summary.requestingDepartment')
      : t('summary.requestingSecretariat');
  };
}

/** `ApproverSummary` (passo 5): "Aprovam em sequência: 1. Secretário → 2. Procurador-Geral". */
export function ApproverSummary({
  policy,
  lines,
  lookups,
}: {
  readonly policy: ApprovalDecisionPolicy;
  readonly lines: readonly ApproverLineDraft[];
  readonly lookups: ApproverLookups;
}) {
  const t = useTranslations('approverLines');
  const nameOf = useLineName(lookups);
  if (lines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{t(`policy.${policy}`)}</span> —{' '}
        {t('summary.single')}
      </p>
    );
  }
  const separator = policy === 'SEQUENTIAL' ? ' → ' : '; ';
  return (
    <p className="text-sm" data-testid="approver-summary">
      <span className="font-semibold">{t(`policy.${policy}`)}:</span>{' '}
      {lines
        .map((line, index) => t('summary.line', { position: index + 1, name: nameOf(line) }))
        .join(separator)}
    </p>
  );
}

export interface ApproverLinesEditorProps {
  readonly policy: ApprovalDecisionPolicy;
  readonly lines: readonly ApproverLineDraft[];
  readonly onLinesChange: (lines: ApproverLineDraft[]) => void;
  readonly problems: ApproverListProblems | null;
  /** Erros da API por linha (base 0). */
  readonly serverErrors?: Readonly<Record<number, string>>;
  readonly disabled?: boolean;
  /** `etapa`: lista vazia = aprovador único (SCR-034); `tipo`: SCR-108. */
  readonly context: 'stage' | 'documentType';
}

/**
 * `ApproverLinesEditor` (US-132 · SCR-034/SCR-108): lista ordenada de 1 a 20 aprovadores, com
 * "Adicionar aprovador", "Subir/Descer" (e as setas do teclado no botão de ordem), "Remover" e o
 * anúncio da nova posição por `aria-live`. Cada linha: tipo, referência (USR-02/ROL-02/DEP-02),
 * resolução da unidade, "Permitir substituto" e rótulo opcional.
 */
export function ApproverLinesEditor(props: ApproverLinesEditorProps) {
  const { policy, lines, onLinesChange, problems, serverErrors, disabled, context } = props;
  const t = useTranslations('approverLines');
  const ids = useId();
  const [announcement, setAnnouncement] = useState('');
  const lookups = useApproverLookups({
    users: lines.some((line) => line.approverType === 'USER'),
    roles: lines.some((line) => line.approverType === 'ROLE'),
    departments: lines.some(
      (line) =>
        line.approverType === 'DEPARTMENT_HEAD' && line.approverDepartmentResolution === 'FIXED',
    ),
  });
  const nameOf = useLineName(lookups);

  const replace = (index: number, next: ApproverLineDraft) => {
    onLinesChange(lines.map((line, position) => (position === index ? next : line)));
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = moveLine(lines, index, delta);
    const moved = lines[index];
    if (!moved || next[index + delta] !== moved) return;
    onLinesChange(next);
    setAnnouncement(t('list.moved', { name: nameOf(moved), position: index + delta + 1 }));
  };
  const onOrderKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, 1);
    }
  };
  const comboLabels = {
    placeholder: t('values.select'),
    search: t('values.search'),
    empty: t('values.noResults'),
  };
  const optionsWith = (current: string, items: readonly ApproverOption[] | undefined) => [
    ...(current !== '' && !items?.some((item) => item.value === current)
      ? [{ value: current, label: t('values.currentSelection') }]
      : []),
    ...(items ?? []),
  ];

  return (
    <fieldset
      disabled={disabled}
      className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
      aria-describedby={`${ids}-hint`}
    >
      <legend className="mb-1 p-0 text-sm font-semibold">{t('list.legend')}</legend>
      <p id={`${ids}-hint`} className="text-[0.8125rem] text-muted-foreground">
        {policy === 'SEQUENTIAL' ? `${t('list.orderHint')} ` : ''}
        {t('list.reorderHint')}
      </p>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {context === 'stage' ? t('list.empty') : t('list.emptyDocumentType')}
        </p>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {lines.map((line, index) => {
          const position = index + 1;
          const problem = problems?.lines[line.key];
          const problemText = problem
            ? t(`problems.${problem.code}`, { line: problem.line })
            : serverErrors?.[index];
          const fieldId = (name: string) => `${ids}-${line.key}-${name}`;
          const errorFor = (name: string) =>
            problemText && (problem?.field ?? 'approverType') === name ? problemText : undefined;
          return (
            <li
              key={line.key}
              aria-label={t('list.lineLabel', { line: position, total: lines.length })}
              className={`flex flex-col gap-3 rounded-card border p-3 ${
                problemText ? 'border-destructive' : 'border-border'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">
                  {t('list.line', { line: position })} — {nameOf(line)}
                </span>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('list.moveUpLabel', { line: position })}
                    disabled={index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                    onKeyDown={(event) => {
                      onOrderKey(event, index);
                    }}
                  >
                    ↑ {t('list.moveUp')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('list.moveDownLabel', { line: position })}
                    disabled={index === lines.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                    onKeyDown={(event) => {
                      onOrderKey(event, index);
                    }}
                  >
                    ↓ {t('list.moveDown')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('list.removeLabel', { line: position })}
                    onClick={() => {
                      onLinesChange(lines.filter((_item, item) => item !== index));
                    }}
                  >
                    {t('list.remove')}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('line.type')} id={fieldId('type')} error={errorFor('approverType')}>
                  <OptionSelect
                    value={line.approverType}
                    options={TYPES.map((type) => ({ value: type, label: t(`types.${type}`) }))}
                    onValueChange={(value) => {
                      replace(index, withType(line, value as ApproverType));
                    }}
                  />
                </Field>
                {line.approverType === 'USER' ? (
                  <Field
                    label={t('line.user')}
                    id={fieldId('user')}
                    error={errorFor('approverUserId')}
                    description={lookups.usersFailed ? t('values.optionsUnavailable') : undefined}
                  >
                    <Combobox
                      options={optionsWith(line.approverUserId, lookups.users)}
                      value={line.approverUserId}
                      labels={comboLabels}
                      clearable
                      onValueChange={(value) => {
                        replace(index, { ...line, approverUserId: value ?? '' });
                      }}
                    />
                  </Field>
                ) : null}
                {line.approverType === 'ROLE' ? (
                  <Field
                    label={t('line.role')}
                    id={fieldId('role')}
                    error={errorFor('approverRoleId')}
                    description={lookups.rolesFailed ? t('values.optionsUnavailable') : undefined}
                  >
                    <Combobox
                      options={optionsWith(line.approverRoleId, lookups.roles)}
                      value={line.approverRoleId}
                      labels={comboLabels}
                      clearable
                      onValueChange={(value) => {
                        replace(index, { ...line, approverRoleId: value ?? '' });
                      }}
                    />
                  </Field>
                ) : null}
                {line.approverType === 'DEPARTMENT_HEAD' ? (
                  <Field
                    label={t('line.resolution')}
                    id={fieldId('resolution')}
                    error={errorFor('approverDepartmentResolution')}
                  >
                    <OptionSelect
                      value={line.approverDepartmentResolution}
                      noneLabel={t('values.select')}
                      options={RESOLUTIONS.map((resolution) => ({
                        value: resolution,
                        label: t(`resolutions.${resolution}`),
                      }))}
                      onValueChange={(value) => {
                        replace(index, {
                          ...line,
                          approverDepartmentResolution:
                            value as ApproverLineDraft['approverDepartmentResolution'],
                          approverFixedDepartmentId: '',
                        });
                      }}
                    />
                  </Field>
                ) : null}
                {line.approverType === 'DEPARTMENT_HEAD' &&
                line.approverDepartmentResolution === 'FIXED' ? (
                  <Field
                    label={t('line.department')}
                    id={fieldId('department')}
                    error={errorFor('approverFixedDepartmentId')}
                    description={
                      lookups.departmentsFailed ? t('values.optionsUnavailable') : undefined
                    }
                  >
                    <Combobox
                      options={optionsWith(line.approverFixedDepartmentId, lookups.departments)}
                      value={line.approverFixedDepartmentId}
                      labels={comboLabels}
                      clearable
                      onValueChange={(value) => {
                        replace(index, { ...line, approverFixedDepartmentId: value ?? '' });
                      }}
                    />
                  </Field>
                ) : null}
                <Field label={t('line.label')} id={fieldId('label')} error={errorFor('label')}>
                  <Input
                    value={line.label}
                    maxLength={APPROVER_LINES_LIMITS.labelLength}
                    placeholder={t('line.labelPlaceholder')}
                    onChange={(event) => {
                      replace(index, { ...line, label: event.target.value });
                    }}
                  />
                </Field>
                {line.approverType === 'DEPARTMENT_HEAD' ? (
                  <div className="flex items-center justify-between gap-3 sm:col-span-2">
                    <Label htmlFor={fieldId('deputy')}>{t('line.allowDeputy')}</Label>
                    <Switch
                      id={fieldId('deputy')}
                      checked={line.allowDeputy}
                      onCheckedChange={(checked) => {
                        replace(index, { ...line, allowDeputy: checked });
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-col gap-2">
        {problems?.tooMany ? <Alert tone="error" title={t('problems.tooMany')} /> : null}
        {problems?.belowMinimum ? <Alert tone="error" title={t('problems.belowMinimum')} /> : null}
      </div>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={lines.length >= APPROVER_LINES_LIMITS.max}
          onClick={() => {
            onLinesChange([...lines, newLineDraft()]);
          }}
        >
          {t('list.add')}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </fieldset>
  );
}
