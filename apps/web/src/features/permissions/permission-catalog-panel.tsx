'use client';

import {
  Alert,
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  Input,
  Search,
  Skeleton,
  StatusChip,
} from '@contrataflow/ui';
import type { PermissionDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import type { Messages } from '@/i18n/messages';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  PERMISSION_CATALOG_STALE_TIME_MS,
  fetchPermissionCatalog,
  permissionCatalogKeys,
} from './permissions.api';
import { RiskLevelBadge } from './risk-level-badge';

type KnownModule = keyof Messages['permissions']['modules'];

/** Busca sem acento e sem diferença de maiúsculas ("Descricao" encontra "Descrição"). */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Agrupa por módulo na ordem de primeira aparição (a ordem do catálogo é a do permissions.md §2). */
function groupByModule(
  permissions: readonly PermissionDto[],
): { module: string; items: PermissionDto[] }[] {
  const groups = new Map<string, PermissionDto[]>();
  for (const permission of permissions) {
    const items = groups.get(permission.module);
    if (items) items.push(permission);
    else groups.set(permission.module, [permission]);
  }
  return [...groups].map(([module, items]) => ({ module, items }));
}

/**
 * Catálogo de permissões (US-094 · ROL-01): lista somente leitura, agrupada por módulo, com nível
 * de risco, indicação de escopo e selo de descontinuada (FA-03). Busca local sobre os itens já
 * carregados — o catálogo tem poucas dezenas de itens. Não decide permissão: quem chega aqui já
 * passou pela API, que responde 403 a quem não tem `ROLE_VIEW`.
 */
export function PermissionCatalogPanel() {
  const t = useTranslations('permissions');
  const tenantId = useTenantId();
  const headingId = useId();
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  const catalog = useQuery({
    queryKey: permissionCatalogKeys.all(tenantId),
    queryFn: async ({ signal }) => (await fetchPermissionCatalog(signal)).data,
    staleTime: PERMISSION_CATALOG_STALE_TIME_MS,
  });

  const groups = useMemo(() => {
    const term = fold(search.trim());
    const items = (catalog.data ?? []).filter(
      (permission) =>
        term === '' ||
        fold(permission.name).includes(term) ||
        fold(permission.code).includes(term) ||
        fold(permission.description).includes(term),
    );
    return groupByModule(items);
  }, [catalog.data, search]);

  if (catalog.error && isApiError(catalog.error) && catalog.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const filtering = search.trim() !== '';
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <header>
        <h2 id={headingId} className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

      {catalog.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {catalog.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void catalog.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {catalog.data ? (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t('search.label')} className="w-80 max-w-full">
              <Input
                type="search"
                icon={<Search aria-hidden="true" />}
                value={search}
                placeholder={t('search.placeholder')}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </Field>
            <p role="status" className="pb-2 text-sm text-muted-foreground">
              {t('search.summary', { count: total })}
            </p>
          </div>

          {groups.length === 0 ? (
            <Alert tone="info" title={t('search.empty')}>
              {t('search.emptyHint')}
            </Alert>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-card bg-surface shadow-card">
              {groups.map((group) => (
                <ModuleGroup
                  key={group.module}
                  module={group.module}
                  items={group.items}
                  open={filtering || opened.has(group.module)}
                  onOpenChange={(open) => {
                    const next = new Set(opened);
                    if (open) next.add(group.module);
                    else next.delete(group.module);
                    setOpened(next);
                  }}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function ModuleGroup({
  module,
  items,
  open,
  onOpenChange,
}: {
  readonly module: string;
  readonly items: readonly PermissionDto[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const label = t.has(`modules.${module as KnownModule}`)
    ? t(`modules.${module as KnownModule}`)
    : module;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <h3 className="m-0">
        <CollapsibleTrigger
          hideChevron
          className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-none px-4 py-2 text-left text-foreground hover:bg-muted/60"
        >
          <span data-module-label className="flex items-center gap-2 font-semibold">
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
            />
            {label}
          </span>
          <span className="text-sm font-normal text-muted-foreground">
            {t('group.count', { count: items.length })}
          </span>
        </CollapsibleTrigger>
      </h3>
      {/* `forceMount`: o conteúdo continua no DOM (oculto) com o módulo fechado, como o `details`. */}
      <CollapsibleContent forceMount>
        <ul aria-label={t('group.listLabel', { module: label })} className="border-t border-border">
          {items.map((permission) => (
            <PermissionRow key={permission.code} permission={permission} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PermissionRow({ permission }: { readonly permission: PermissionDto }) {
  const t = useTranslations('permissions');
  return (
    <li className="flex flex-col gap-1 border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{permission.name}</span>
        <code className="font-mono text-xs text-muted-foreground">{permission.code}</code>
        <RiskLevelBadge level={permission.riskLevel} />
        {permission.scopable ? <StatusChip tone="info">{t('badges.scopable')}</StatusChip> : null}
        {permission.isDeprecated ? (
          <StatusChip tone="neutral">{t('badges.deprecated')}</StatusChip>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{permission.description}</p>
    </li>
  );
}
