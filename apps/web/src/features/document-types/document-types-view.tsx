'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
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
 * numeração, aprovação avulsa e template padrão. Quem chega aqui já passou pelo `DTY-01` com
 * `includeInactive` — a API só responde a quem tem `DOCUMENT_TYPE_MANAGE` —, então as ações de
 * gestão aparecem junto com a lista; 403 mostra "Acesso negado" no lugar da tela. Quem tem
 * `TEMPLATE_PUBLISH` escolhe o template padrão de cada tipo (`DefaultTemplateSelect` — US-108).
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
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <AppPageHeader
        section="admin"
        title={t('title')}
        description={t('description')}
        actions={
          types.data ? (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('new')}
            </Button>
          ) : null
        }
      />

      {types.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {types.isError ? (
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
      ) : null}

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
    </div>
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
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-lg font-semibold">
        {t(`groups.${kind}`)}
      </h2>
      <div className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <caption className="sr-only">
            {t('table.caption', { group: t(`groups.${kind}`) })}
          </caption>
          <thead className="bg-muted text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('table.name')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.status')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.numbering')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.approval')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.confidentiality')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.template')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      </div>
    </section>
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
    <tr className="border-t border-border align-top">
      <th scope="row" className="px-3 py-2 font-medium">
        <span>{type.name}</span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">{type.code}</span>
        {type.isSystem ? (
          <span className="ml-2">
            <Badge tone="muted">{t('badges.system')}</Badge>
          </span>
        ) : null}
      </th>
      <td className="px-3 py-2">
        <Badge tone={type.isActive ? 'ok' : 'muted'}>
          {type.isActive ? t('badges.active') : t('badges.inactive')}
        </Badge>
      </td>
      <td className="px-3 py-2">
        {type.nextNumberPreview
          ? t('values.next', { preview: type.nextNumberPreview })
          : t('values.noNumbering')}
      </td>
      <td className="px-3 py-2">{type.requiresApproval ? t('values.yes') : t('values.no')}</td>
      <td className="px-3 py-2">{t(`confidentiality.${type.defaultConfidentiality}`)}</td>
      <td className="px-3 py-2 text-muted-foreground">
        {templates && type.kind !== 'UPLOADED' ? (
          <DefaultTemplateSelect type={type} templates={templates} />
        ) : (
          template
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-label={t('actions.edit', { name: type.name })}
            onClick={() => {
              onEdit(type);
            }}
          >
            {t('actions.editLabel')}
          </Button>
          {canToggle ? (
            type.isActive ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('actions.deactivate', { name: type.name })}
                onClick={() => {
                  onDeactivate(type);
                }}
              >
                {t('actions.deactivateLabel')}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('actions.reactivate', { name: type.name })}
                onClick={() => {
                  onReactivate(type);
                }}
              >
                {t('actions.reactivateLabel')}
              </Button>
            )
          ) : null}
        </div>
      </td>
    </tr>
  );
}
