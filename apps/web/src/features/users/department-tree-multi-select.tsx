'use client';

import { useTranslations } from 'next-intl';

import { DepartmentMultiSelect } from './department-multi-select';

export interface DepartmentTreeMultiSelectProps {
  readonly id: string;
  /** Ids selecionados. */
  readonly value: readonly string[];
  /** Lotação principal escolhida (∈ `value`). */
  readonly primary: string | null;
  /** Nomes das lotações atuais do vínculo, por id. */
  readonly names: ReadonlyMap<string, string>;
  readonly onChange: (ids: string[], primary: string | null) => void;
  readonly error?: string | undefined;
}

/**
 * `DepartmentTreeMultiSelect` (SCR-029 · US-092 · USR-09): seleção múltipla de unidades ativas
 * (DEP-02) com a lotação principal escolhida de forma explícita (botão de opção em cada unidade
 * selecionada). Ao remover a principal, a primeira que sobra assume; ao marcar a primeira unidade,
 * ela vira a principal.
 */
export function DepartmentTreeMultiSelect({
  id,
  value,
  primary,
  names,
  onChange,
  error,
}: DepartmentTreeMultiSelectProps) {
  const t = useTranslations('users.detail');
  return (
    <DepartmentMultiSelect
      id={id}
      value={value}
      names={names}
      primary={primary}
      hint={t('departmentsHint')}
      error={error}
      onChange={(ids) => {
        onChange(ids, primary !== null && ids.includes(primary) ? primary : (ids[0] ?? null));
      }}
      onPrimaryChange={(departmentId) => {
        onChange([...value], departmentId);
      }}
    />
  );
}
