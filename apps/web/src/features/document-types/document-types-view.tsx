'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  FileText,
  ListPage,
  Lock,
  Plus,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Tr,
  toast,
} from '@contrataflow/ui';
import type { DocumentKind, DocumentTypeDto, TemplateDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { DefaultTemplateSelect } from '@/features/templates/default-template-select';
import {
  fetchTemplates,
  templateKeys,
  TEMPLATES_STALE_TIME_MS,
} from '@/features/templates/templates.api';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { DocumentTypeForm } from './document-type-form';
import {
  DOCUMENT_TYPES_STALE_TIME_MS,
  documentTypeKeys,
  fetchDocumentTypes,
  updateDocumentType,
} from './document-types.api';

const GROUP_ORDER: readonly DocumentKind[] = ['STRUCTURED', 'FREE_TEXT', 'UPLOADED'];

/**
 * SCR-108 (`/admin/tipos-documento` — US-061): tipos do tenant agrupados por natureza, com situação,
 * numeração, aprovação avulsa e template padrão. Modelo `ListPage` (prd-5): "Novo tipo" no
 * cabeçalho e, em cada linha, o menu ⋯ com "Editar" e "Desativar/Reativar". Quem chega aqui já
 * passou pelo `DTY-01` com `includeInactive` — a API só responde a quem tem
 * `DOCUMENT_TYPE_MANAGE` —, então as ações de gestão aparecem junto com a lista; 403 mostra
 * "Acesso negado" no lugar da tela. Quem tem `TEMPLATE_PUBLISH` escolhe o template padrão de cada
 * tipo (`DefaultTemplateSelect` — US-108).
 */
export function DocumentTypesView() {
  const t = useTranslations('documentTypes');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DocumentTypeDto | null>(null);
  const [deactivating, setDeactivating] = useState<DocumentTypeDto | null>(null);
  const [deactivationError, setDeactivationError] = useState<string | null>(null);

  const types = useQuery({
    queryKey: documentTypeKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchDocumentTypes(signal)).data,
    staleTime: DOCUMENT_TYPES_STALE_TIME_MS,
  });
  const canPublish = usePermission('TEMPLATE_PUBLISH').allowed;
  const templates = useQuery({
    queryKey: templateKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchTemplates(signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
    enabled: canPublish,
    throwOnError: false,
  });

  const setActive = useMutation({
    mutationFn: ({ type, isActive }: { type: DocumentTypeDto; isActive: boolean }) =>
      updateDocumentType(type.id, { isActive }, type.version),
    onSuccess: (result, { isActive }) => {
      toast({
        title: t(isActive ? 'toast.reactivated' : 'toast.deactivated', { name: result.data.name }),
        tone: 'success',
      });
      setDeactivating(null);
      setDeactivationError(null);
      void queryClient.invalidateQueries({ queryKey: documentTypeKeys.all(tenantId) });
    },
    onError: (error) => {
      setDeactivationError(isApiError(error) ? error.message : t('errors.generic'));
      // Versão desatualizada ou regra de fluxo: a lista é relida para refletir o estado atual.
      void queryClient.invalidateQueries({ queryKey: documentTypeKeys.all(tenantId) });
    },
  });

  if (types.error && isApiError(types.error) && types.error.status === 403) {
    return (
      <ListPage
        header={<AppPageHeader section="admin" title={t('title')} description={t('description')} />}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  return (
    <ListPage
      header={
        <AppPageHeader
          section="admin"
          title={t('title')}
          description={t('description')}
          actions={
            types.data ? (
              <Button
                iconLeft={<Plus />}
                onClick={() => {
                  setCreating(true);
                }}
              >
                {t('new')}
              </Button>
            ) : null
          }
        />
      }
      loading={types.isPending}
      loadingLabel={t('loading')}
      error={
        types.isError ? (
          <Alert tone="error" title={t('loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void types.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        ) : null
      }
      empty={
        types.data?.length === 0 ? (
          <EmptyState icon={<FileText />} title={t('empty.title')} description={t('empty.hint')} />
        ) : null
      }
    >
      {types.data
        ? GROUP_ORDER.map((kind) => {
            const group = types.data.filter((type) => type.kind === kind);
            if (group.length === 0) return null;
            return (
              <TypeGroup
                key={kind}
                kind={kind}
                types={group}
                templates={canPublish ? (templates.data ?? null) : null}
                onEdit={setEditing}
                onDeactivate={(type) => {
                  setDeactivationError(null);
                  setDeactivating(type);
                }}
                onReactivate={(type) => {
                  setActive.mutate({ type, isActive: true });
                }}
              />
            );
          })
        : null}

      <DocumentTypeForm open={creating} onOpenChange={setCreating} />
      <DocumentTypeForm
        open={editing !== null}
        type={editing ?? undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <Dialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('deactivate.title', { name: deactivating?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('deactivate.description')}</DialogDescription>
          {deactivationError ? <Alert tone="error" title={deactivationError} /> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeactivating(null);
              }}
            >
              {t('deactivate.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={setActive.isPending}
              aria-busy={setActive.isPending}
              onClick={() => {
                if (deactivating) setActive.mutate({ type: deactivating, isActive: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ListPage>
  );
}

function TypeGroup({
  kind,
  types,
  templates,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  readonly kind: DocumentKind;
  readonly types: readonly DocumentTypeDto[];
  /** Templates do tenant para o `DefaultTemplateSelect`; `null` = sem `TEMPLATE_PUBLISH`. */
  readonly templates: readonly TemplateDto[] | null;
  readonly onEdit: (type: DocumentTypeDto) => void;
  readonly onDeactivate: (type: DocumentTypeDto) => void;
  readonly onReactivate: (type: DocumentTypeDto) => void;
}) {
  const t = useTranslations('documentTypes');
  const headingId = `document-types-${kind}`;
  const caption = t('table.caption', { group: t(`groups.${kind}`) });
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <h2 id={headingId} className="text-lg font-bold text-brand-ink">
        {t(`groups.${kind}`)}
      </h2>
      <TableContainer
        label={caption}
        footer={<TableFooter summary={t('count', { count: types.length })} />}
      >
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHead>
            <Tr>
              <Th>{t('table.name')}</Th>
              <Th>{t('table.status')}</Th>
              <Th>{t('table.numbering')}</Th>
              <Th>{t('table.approval')}</Th>
              <Th>{t('table.template')}</Th>
              <Th className="w-12">
                <span className="sr-only">{t('table.actions')}</span>
              </Th>
            </Tr>
          </TableHead>
          <TableBody>
            {types.map((type) => (
              <TypeRow
                key={type.id}
                type={type}
                templates={templates}
                onEdit={onEdit}
                onDeactivate={onDeactivate}
                onReactivate={onReactivate}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </section>
  );
}

function TypeRow({
  type,
  templates,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  readonly type: DocumentTypeDto;
  readonly templates: readonly TemplateDto[] | null;
  readonly onEdit: (type: DocumentTypeDto) => void;
  readonly onDeactivate: (type: DocumentTypeDto) => void;
  readonly onReactivate: (type: DocumentTypeDto) => void;
}) {
  const t = useTranslations('documentTypes');
  const canToggle = type.editableFields.includes('isActive');
  const template =
    type.defaultTemplate?.name ??
    (type.kind === 'FREE_TEXT' ? t('values.noTemplate') : t('values.noTemplateNeeded'));
  return (
    <Tr>
      <th scope="row" className="px-3.5 py-3 text-left font-normal">
        <span className={type.isActive ? 'font-bold' : 'font-bold text-muted-foreground'}>
          {type.name}
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{type.code}</span>
          <span>{t(`confidentiality.${type.defaultConfidentiality}`)}</span>
        </span>
      </th>
      <Td>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip tone={type.isActive ? 'success' : 'neutral'}>
            {type.isActive ? t('badges.active') : t('badges.inactive')}
          </StatusChip>
          {type.isSystem ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('system.tooltipLabel', { name: type.name })}
                  className="rounded-full"
                >
                  <StatusChip tone="info" icon={<Lock />}>
                    {t('badges.system')}
                  </StatusChip>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('system.tooltip')}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </Td>
      <Td>
        {type.nextNumberPreview
          ? t('values.next', { preview: type.nextNumberPreview })
          : t('values.noNumbering')}
      </Td>
      <Td>{type.requiresApproval ? t('values.yes') : t('values.no')}</Td>
      <Td className="text-muted-foreground">
        {templates && type.kind !== 'UPLOADED' ? (
          <DefaultTemplateSelect type={type} templates={templates} />
        ) : (
          template
        )}
      </Td>
      <Td className="w-12 py-1.5 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('actions.menu', { name: type.name })}
              className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
            >
              <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                onEdit(type);
              }}
            >
              {t('actions.editLabel')}
            </DropdownMenuItem>
            {canToggle ? (
              type.isActive ? (
                <DropdownMenuItem
                  onSelect={() => {
                    onDeactivate(type);
                  }}
                >
                  {t('actions.deactivateLabel')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() => {
                    onReactivate(type);
                  }}
                >
                  {t('actions.reactivateLabel')}
                </DropdownMenuItem>
              )
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </Td>
    </Tr>
  );
}
