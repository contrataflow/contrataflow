'use client';

import type { PermissionDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import type { Messages } from '@/i18n/messages';

import { groupByModule, switchState } from './permission-matrix-model';
import type { ActorReach, SwitchState } from './permission-matrix-model';
import { RiskLevelBadge } from '../permissions/risk-level-badge';

type KnownModule = keyof Messages['permissions']['modules'];

export interface PermissionMatrixProps {
  readonly catalog: readonly PermissionDto[];
  /** Concessões salvas do perfil (ROL-04). */
  readonly granted: ReadonlySet<string>;
  /** Marcações atuais (ainda não salvas). */
  readonly selected: ReadonlySet<string>;
  readonly isProtectedRole: boolean;
  readonly canManage: boolean;
  readonly actor: ActorReach;
  readonly onToggle: (code: string, checked: boolean) => void;
}

/**
 * `PermissionMatrix` (SCR-031 · US-095): interruptores (`role="switch"`) agrupados por módulo, com
 * `RiskLevelBadge`. Interruptores travados continuam focáveis (`aria-disabled`) e explicam o motivo
 * (protegida — FA-01; fora do alcance do ator — FA-02 · POL-13; somente leitura). Cabeçalho de módulo
 * fixo na rolagem; rolagem horizontal em telas estreitas.
 */
export function PermissionMatrix(props: PermissionMatrixProps) {
  const groups = groupByModule(props.catalog);
  return (
    <div className="max-h-[70vh] overflow-auto rounded-card border border-border bg-surface shadow-card">
      <div className="min-w-[32rem]">
        {groups.map((group) => (
          <ModuleGroup key={group.module} module={group.module} items={group.items} {...props} />
        ))}
      </div>
    </div>
  );
}

function ModuleGroup({
  module,
  items,
  ...props
}: PermissionMatrixProps & { readonly module: string; readonly items: readonly PermissionDto[] }) {
  const t = useTranslations('permissions');
  const tr = useTranslations('roles.matrix');
  const headingId = useId();
  const label = t.has(`modules.${module as KnownModule}`)
    ? t(`modules.${module as KnownModule}`)
    : module;
  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="sticky top-0 z-10 border-b border-border bg-muted px-4 py-2 text-sm font-semibold"
      >
        {label}
      </h3>
      <ul aria-label={tr('groupLabel', { module: label })}>
        {items.map((permission) => (
          <PermissionSwitch key={permission.code} permission={permission} {...props} />
        ))}
      </ul>
    </section>
  );
}

const HINT: Record<
  Exclude<SwitchState, 'enabled'>,
  'protectedHint' | 'outOfReachHint' | 'readonlyHint'
> = {
  protected: 'protectedHint',
  'out-of-reach': 'outOfReachHint',
  readonly: 'readonlyHint',
};

function PermissionSwitch({
  permission,
  granted,
  selected,
  isProtectedRole,
  canManage,
  actor,
  onToggle,
}: PermissionMatrixProps & { readonly permission: PermissionDto }) {
  const t = useTranslations('roles.matrix');
  const labelId = useId();
  const hintId = useId();
  const checked = selected.has(permission.code);
  const state = switchState({ code: permission.code, isProtectedRole, granted, canManage, actor });
  const locked = state !== 'enabled';
  const hint = locked ? t(HINT[state]) : undefined;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col">
        <span id={labelId} className="font-medium">
          {permission.name}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs text-muted-foreground">{permission.code}</code>
          <RiskLevelBadge level={permission.riskLevel} />
        </span>
        {hint ? (
          <span id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        data-code={permission.code}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-disabled={locked || undefined}
        aria-describedby={hint ? hintId : undefined}
        title={hint}
        onClick={() => {
          if (!locked) onToggle(permission.code, !checked);
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
          checked ? 'bg-primary' : 'bg-muted'
        } ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </li>
  );
}
