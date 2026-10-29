'use client';

import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Field,
  FilterToolbar,
  LayoutTemplate,
  ListPage,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contrataflow/ui';
import type { TemplateDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { SystemTemplateBadge } from './system-template-badge';
import { TemplateFormDialog } from './template-form-dialog';
import {
  fetchTemplates,
  templateEditorHref,
  templateKeys,
  TEMPLATES_STALE_TIME_MS,
  templateVersionsHref,
} from './templates.api';

/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';

type StatusFilter = typeof ALL | 'active' | 'inactive';

/** Minúsculas e sem acentos (busca local por nome). */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * SCR-033 (`/admin/templates` — US-107): templates do tenant com tipo, versões e situação.
 * Modelo `ListPage` (prd-5): "Novo template" (`TEMPLATE_MANAGE`) é a ação primária do cabeçalho;
 * busca inline por nome e, no popover "Filtros", tipo de documento e situação, com chips.
 * "Editar dados" e o acesso ao editor (SCR-114 — em modo leitura para quem só tem `TEMPLATE_VIEW`)
 * ficam no menu ⋯ da linha. A API decide (RN-FND-92).
 */
export function TemplatesView() {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const canManage = usePermission('TEMPLATE_MANAGE').allowed;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TemplateDto | null>(null);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>(ALL);
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

  const visible = useMemo(
    () =>
      (templates.data ?? []).filter(
        (template) =>
          (typeFilter === ALL || template.documentTypeId === typeFilter) &&
          (status === ALL || template.isActive === (status === 'active')) &&
          (search.trim() === '' || fold(template.name).includes(fold(search.trim()))),
      ),
    [templates.data, typeFilter, status, search],
  );

  const header = (
    <AppPageHeader section="admin" title={t('title')} description={t('description')} />
  );

  if (templates.error && isApiError(templates.error) && templates.error.status === 403) {
    return (
      <ListPage
        header={header}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const typeName = types.find(([id]) => id === typeFilter)?.[1] ?? '';
  const statusLabel = status === 'active' ? t('filters.active') : t('filters.inactive');
  const activeCount = (typeFilter === ALL ? 0 : 1) + (status === ALL ? 0 : 1);
  const filtered = search.trim() !== '' || activeCount > 0;
  const chips = [
    ...(typeFilter === ALL
      ? []
      : [
          {
            id: 'type',
            label: t('filters.chip', { label: t('filters.type'), value: typeName }),
            removeLabel: t('filters.removeChip', { label: t('filters.type'), value: typeName }),
            onRemove: () => {
              setTypeFilter(ALL);
            },
          },
        ]),
    ...(status === ALL
      ? []
      : [
          {
            id: 'status',
            label: t('filters.chip', { label: t('filters.status'), value: statusLabel }),
            removeLabel: t('filters.removeChip', {
              label: t('filters.status'),
              value: statusLabel,
            }),
            onRemove: () => {
              setStatus(ALL);
            },
          },
        ]),
  ];
  const newTemplate = canManage ? (
    <Button
      iconLeft={<Plus />}
      onClick={() => {
        setCreating(true);
      }}
    >
      {t('new')}
    </Button>
  ) : null;

  return (
    <ListPage
      header={
        <AppPageHeader
          section="admin"
          title={t('title')}
          description={t('description')}
          actions={templates.data ? newTemplate : null}
        />
      }
      toolbar={
        templates.data && templates.data.length > 0 ? (
          <FilterToolbar
            search={{
              value: search,
              onChange: setSearch,
              label: t('filters.search'),
              placeholder: t('filters.searchPlaceholder'),
              description: t('filters.searchHint'),
            }}
            activeCount={activeCount}
            filters={
              <div className="flex flex-col gap-4">
                <Field label={t('filters.type')}>
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('filters.allTypes')}</SelectItem>
                      {types.map(([id, name]) => (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('filters.status')}>
                  <Select
                    value={status}
                    onValueChange={(value) => {
                      setStatus(value === 'active' || value === 'inactive' ? value : ALL);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('filters.all')}</SelectItem>
                      <SelectItem value="active">{t('filters.active')}</SelectItem>
                      <SelectItem value="inactive">{t('filters.inactive')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            }
            chips={chips}
            onClearAll={() => {
              setTypeFilter(ALL);
              setStatus(ALL);
            }}
          />
        ) : null
      }
      loading={templates.isPending}
      loadingLabel={t('loading')}
      error={
        templates.isError ? (
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
        ) : null
      }
      empty={
        templates.data && visible.length === 0 ? (
          <EmptyState
            icon={<LayoutTemplate />}
            title={filtered ? t('list.noResults') : t('list.emptyTitle')}
            description={filtered ? t('list.noResultsHint') : t('list.emptyHint')}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setTypeFilter(ALL);
                    setStatus(ALL);
                  }}
                >
                  {t('filters.clear')}
                </Button>
              ) : (
                newTemplate
              )
            }
          />
        ) : null
      }
    >
      {visible.length > 0 ? (
        <TableContainer
          label={t('table.caption')}
          footer={<TableFooter summary={t('list.count', { count: visible.length })} />}
        >
          <TemplateTable templates={visible} canManage={canManage} onEdit={setEditing} />
        </TableContainer>
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
    </ListPage>
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
  return (
    <Table>
      <caption className="sr-only">{t('table.caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('table.name')}</Th>
          <Th className="hidden md:table-cell">{t('table.type')}</Th>
          <Th className="hidden lg:table-cell">{t('table.published')}</Th>
          <Th className="hidden lg:table-cell">{t('table.draft')}</Th>
          <Th>{t('table.status')}</Th>
          <Th className="w-12">
            <span className="sr-only">{t('table.actions')}</span>
          </Th>
        </Tr>
      </TableHead>
      <TableBody>
        {templates.map((template) => (
          <Tr key={template.id}>
            <th scope="row" className="px-3.5 py-3 text-left font-normal">
              <Link
                href={templateVersionsHref(template.id)}
                className="block font-bold text-foreground underline-offset-2 hover:underline"
              >
                {template.name}
              </Link>
              {template.description ? (
                <span className="block text-xs text-muted-foreground">{template.description}</span>
              ) : null}
            </th>
            <Td className="hidden md:table-cell">{template.documentType.name}</Td>
            <Td className="hidden whitespace-nowrap lg:table-cell">
              {template.currentPublishedVersion
                ? t('values.version', { number: template.currentPublishedVersion.versionNumber })
                : t('values.noVersion')}
            </Td>
            <Td className="hidden whitespace-nowrap lg:table-cell">
              {template.draftVersion
                ? t('values.draft', {
                    number: template.draftVersion.versionNumber,
                    sections: template.draftVersion.sectionCount,
                  })
                : t('values.noVersion')}
            </Td>
            <Td>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusChip tone={template.isActive ? 'success' : 'warning'}>
                  {template.isActive ? t('badges.active') : t('badges.inactive')}
                </StatusChip>
                {template.isDefault ? (
                  <StatusChip tone="info">{t('badges.default')}</StatusChip>
                ) : null}
                {template.isSystem ? <SystemTemplateBadge /> : null}
              </div>
            </Td>
            <Td className="w-12 py-1.5 text-right">
              <RowMenu template={template} canManage={canManage} onEdit={onEdit} />
            </Td>
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}

function RowMenu({
  template,
  canManage,
  onEdit,
}: {
  readonly template: TemplateDto;
  readonly canManage: boolean;
  readonly onEdit: (template: TemplateDto) => void;
}) {
  const t = useTranslations('templates');
  const target = template.draftVersion ?? template.currentPublishedVersion;
  const editable = canManage && template.draftVersion !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('actions.menu', { name: template.name })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={templateVersionsHref(template.id)}>{t('actions.versionsLabel')}</Link>
        </DropdownMenuItem>
        {target ? (
          <DropdownMenuItem asChild>
            <Link href={templateEditorHref(template.id, target.id)}>
              {editable ? t('actions.editContentLabel') : t('actions.viewContentLabel')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canManage ? (
          <DropdownMenuItem
            onSelect={() => {
              onEdit(template);
            }}
          >
            {t('actions.editDataLabel')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
