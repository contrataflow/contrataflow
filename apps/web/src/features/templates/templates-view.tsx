'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type { TemplateDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { TemplateFormDialog } from './template-form-dialog';
import {
  fetchTemplates,
  templateEditorHref,
  templateKeys,
  TEMPLATES_STALE_TIME_MS,
} from './templates.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

/** Minúsculas e sem acentos (busca local por nome). */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * SCR-033 (`/admin/templates` — US-107): templates do tenant com tipo, situação e versões, filtro
 * por tipo e nome, "Novo template" e "Editar dados" para quem tem `TEMPLATE_MANAGE` e o acesso ao
 * editor (SCR-114) — em modo leitura para quem só tem `TEMPLATE_VIEW`. A API decide (RN-FND-92).
 */
export function TemplatesView() {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const ids = useId();
  const canManage = usePermission('TEMPLATE_MANAGE').allowed;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TemplateDto | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const templates = useQuery({
    queryKey: templateKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchTemplates(signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
  });

  const types = useMemo(() => {
    const byId = new Map<string, string>();
    for (const template of templates.data ?? []) {
      byId.set(template.documentTypeId, template.documentType.name);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  }, [templates.data]);

  const visible = (templates.data ?? []).filter(
    (template) =>
      (typeFilter === '' || template.documentTypeId === typeFilter) &&
      (search.trim() === '' || fold(template.name).includes(fold(search.trim()))),
  );

  if (templates.error && isApiError(templates.error) && templates.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            {t('new')}
          </Button>
        ) : null}
      </header>

      {templates.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {templates.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void templates.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {templates.data ? (
        templates.data.length === 0 ? (
          <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-type`} className="text-sm font-medium">
                  {t('filters.type')}
                </label>
                <select
                  id={`${ids}-type`}
                  className={INPUT}
                  value={typeFilter}
                  onChange={(event) => {
                    setTypeFilter(event.target.value);
                  }}
                >
                  <option value="">{t('filters.allTypes')}</option>
                  {types.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-search`} className="text-sm font-medium">
                  {t('filters.search')}
                </label>
                <input
                  id={`${ids}-search`}
                  type="search"
                  className={INPUT}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                />
              </div>
            </div>
            <TemplateTable templates={visible} canManage={canManage} onEdit={setEditing} />
          </>
        )
      ) : null}

      <TemplateFormDialog
        open={creating}
        onOpenChange={setCreating}
        existing={templates.data ?? []}
      />
      <TemplateFormDialog
        open={editing !== null}
        template={editing ?? undefined}
        existing={templates.data ?? []}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

function Badge({ children, tone }: { readonly children: string; readonly tone: 'muted' | 'ok' }) {
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${
        tone === 'ok' ? 'bg-success-soft text-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {children}
    </span>
  );
}

function TemplateTable({
  templates,
  canManage,
  onEdit,
}: {
  readonly templates: readonly TemplateDto[];
  readonly canManage: boolean;
  readonly onEdit: (template: TemplateDto) => void;
}) {
  const t = useTranslations('templates');
  if (templates.length === 0) {
    return <p className="text-muted-foreground">{t('filters.noResults')}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <caption className="sr-only">{t('table.caption')}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('table.name')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.type')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.versions')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => {
            const target = template.draftVersion ?? template.currentPublishedVersion;
            const editable = canManage && template.draftVersion !== null;
            return (
              <tr key={template.id} className="border-t border-border align-top">
                <th scope="row" className="px-3 py-2 font-medium">
                  <span>{template.name}</span>
                  {template.isSystem ? (
                    <span className="ml-2">
                      <Badge tone="muted">{t('badges.system')}</Badge>
                    </span>
                  ) : null}
                  {template.description ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {template.description}
                    </span>
                  ) : null}
                </th>
                <td className="px-3 py-2">{template.documentType.name}</td>
                <td className="px-3 py-2">
                  <Badge tone={template.isActive ? 'ok' : 'muted'}>
                    {template.isActive ? t('badges.active') : t('badges.inactive')}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {template.draftVersion ? (
                    <span className="block">
                      {t('values.draft', {
                        number: template.draftVersion.versionNumber,
                        sections: template.draftVersion.sectionCount,
                      })}
                    </span>
                  ) : null}
                  {template.currentPublishedVersion ? (
                    <span className="block">
                      {t('values.published', {
                        number: template.currentPublishedVersion.versionNumber,
                      })}
                    </span>
                  ) : null}
                  {!template.draftVersion && !template.currentPublishedVersion
                    ? t('values.noVersion')
                    : null}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {target ? (
                      <Link
                        href={templateEditorHref(template.id, target.id)}
                        className="inline-flex h-8 items-center rounded-control border border-border px-3 text-sm font-medium hover:bg-muted"
                        aria-label={
                          editable
                            ? t('actions.editContent', { name: template.name })
                            : t('actions.viewContent', { name: template.name })
                        }
                      >
                        {editable ? t('actions.editContentLabel') : t('actions.viewContentLabel')}
                      </Link>
                    ) : null}
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.editData', { name: template.name })}
                        onClick={() => {
                          onEdit(template);
                        }}
                      >
                        {t('actions.editDataLabel')}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
