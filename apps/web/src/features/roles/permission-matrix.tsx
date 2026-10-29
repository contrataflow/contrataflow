'use client';

import {
  Alert,
  Checkbox,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  Input,
  Label,
  Search,
} from '@contrataflow/ui';
import type { PermissionDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import type { Messages } from '@/i18n/messages';

import {
  countSelected,
  filterPermissions,
  groupByModule,
  switchState,
} from './permission-matrix-model';
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

type RowProps = Omit<PermissionMatrixProps, 'catalog'>;

/**
 * `PermissionMatrix` (SCR-031 · US-095): caixas de seleção agrupadas por módulo em blocos
 * recolhíveis (fechados ao abrir), cada um com o resumo "n de N" e o `RiskLevelBadge` por
 * permissão. A busca por nome ou código filtra a lista e abre os módulos com resultado. Caixas
 * travadas continuam focáveis (`aria-disabled`) e explicam o motivo (protegida — FA-01; fora do
 * alcance do ator — FA-02 · POL-13; somente leitura). Só a página rola.
 */
export function PermissionMatrix({ catalog, ...rest }: PermissionMatrixProps) {
  const t = useTranslations('roles.matrix');
  const searchId = useId();
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const searching = search.trim() !== '';

  const visible = useMemo(() => filterPermissions(catalog, search), [catalog, search]);
  const groups = useMemo(() => groupByModule(visible), [visible]);
  const totals = useMemo(() => {
    const all = new Map(groupByModule(catalog).map((group) => [group.module, group.items]));
    return all;
  }, [catalog]);
  const selectedTotal = countSelected(catalog, rest.selected);

  const setGroupOpen = (module: string, open: boolean) => {
    const next = new Set(opened);
    if (open) next.add(module);
    else next.delete(module);
    setOpened(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <Field label={t('search')} id={searchId} className="w-full max-w-sm">
          <Input
            type="search"
            icon={<Search aria-hidden="true" />}
            value={search}
            placeholder={t('searchPlaceholder')}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </Field>
        <p role="status" className="pb-2 text-sm text-muted-foreground">
          {searching
            ? t('searchSummary', { count: visible.length })
            : t('total', { selected: selectedTotal, total: catalog.length })}
        </p>
      </div>

      {groups.length === 0 ? (
        <Alert tone="info" live={false} title={t('searchEmpty')}>
          {t('searchEmptyHint')}
        </Alert>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-card bg-surface shadow-card">
          {groups.map((group) => (
            <ModuleGroup
              key={group.module}
              module={group.module}
              items={group.items}
              all={totals.get(group.module) ?? group.items}
              open={searching || opened.has(group.module)}
              onOpenChange={(open) => {
                setGroupOpen(group.module, open);
              }}
              {...rest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModuleGroup({
  module,
  items,
  all,
  open,
  onOpenChange,
  ...props
}: RowProps & {
  readonly module: string;
  /** Itens que passam pela busca. */
  readonly items: readonly PermissionDto[];
  /** Todos os itens do módulo (a contagem "n de N" não muda com a busca). */
  readonly all: readonly PermissionDto[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const tr = useTranslations('roles.matrix');
  const label = t.has(`modules.${module as KnownModule}`)
    ? t(`modules.${module as KnownModule}`)
    : module;
  const counts = { selected: countSelected(all, props.selected), total: all.length };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <h3 className="m-0">
        <CollapsibleTrigger
          hideChevron
          className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-none px-4 py-2 text-left text-foreground hover:bg-muted/60"
        >
          <span className="flex items-center gap-2 font-semibold">
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
            />
            {label}
          </span>
          <span
            className="text-sm font-normal text-muted-foreground"
            aria-label={tr('groupCountLabel', counts)}
          >
            {tr('groupCount', counts)}
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent>
        <ul aria-label={tr('groupLabel', { module: label })} className="border-t border-border">
          {items.map((permission) => (
            <PermissionRow key={permission.code} permission={permission} {...props} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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

function PermissionRow({
  permission,
  granted,
  selected,
  isProtectedRole,
  canManage,
  actor,
  onToggle,
}: RowProps & { readonly permission: PermissionDto }) {
  const t = useTranslations('roles.matrix');
  const controlId = useId();
  const hintId = useId();
  const checked = selected.has(permission.code);
  const state = switchState({ code: permission.code, isProtectedRole, granted, canManage, actor });
  const locked = state !== 'enabled';
  const hint = locked ? t(HINT[state]) : undefined;
  return (
    <li className="flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <Checkbox
        id={controlId}
        data-code={permission.code}
        checked={checked}
        aria-disabled={locked || undefined}
        aria-describedby={hint ? hintId : undefined}
        title={hint}
        className={locked ? 'cursor-not-allowed opacity-60' : undefined}
        onCheckedChange={(next) => {
          if (!locked) onToggle(permission.code, next === true);
        }}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <Label
          htmlFor={controlId}
          className={locked ? 'cursor-not-allowed font-bold' : 'cursor-pointer font-bold'}
        >
          {permission.name}
        </Label>
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
    </li>
  );
}
