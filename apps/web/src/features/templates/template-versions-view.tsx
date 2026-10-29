'use client';

import {
  Alert,
  Button,
  ChevronDown,
  DetailPage,
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
  Skeleton,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  Tr,
  toast,
} from '@contrataflow/ui';
import type { TemplateDto, TemplateVersionHistoryItem, Violation } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { ApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { SystemTemplateBadge } from './system-template-badge';
import { TemplateFormDialog } from './template-form-dialog';
import { formatDateTime, prePublishProblems, retireBlocked } from './template-versions-model';
import type { PublishProblem } from './template-versions-model';
import {
  createTemplateVersion,
  fetchTemplate,
  fetchTemplateVersion,
  fetchTemplateVersions,
  publishTemplateVersion,
  retireTemplateVersion,
  shortHash,
  templateEditorHref,
  templateKeys,
  TEMPLATES_PATH,
  TEMPLATES_STALE_TIME_MS,
} from './templates.api';

/** Mensagem do erro de ação para o usuário (Casos de erro da US-108). */
function actionErrorMessage(error: unknown, t: ReturnType<typeof useTranslations>): string {
  if (!isApiError(error)) return t('versions.errors.generic');
  if (error.code === 'VERSION_CONFLICT') return t('versions.errors.conflict');
  if (error.code === 'TEMPLATE_VERSION_NOT_DRAFT' || error.code === 'INVALID_STATE') {
    return t('versions.errors.state');
  }
  if (error.code === 'DEPENDENCY_UNAVAILABLE') return t('versions.errors.unavailable');
  return error.message;
}

type Tab = 'versions' | 'config';

/**
 * SCR-033, detalhe do template (`/admin/templates/[id]` · US-108) no modelo `DetailPage` (prd-5):
 * trilha, nome, chips de situação e fatos-chave (tipo, versão publicada, rascunho, atualização).
 * "Iniciar nova versão" (TPL-06, `TEMPLATE_MANAGE`) é a ação primária — só sem rascunho (RN-TPL-13);
 * "Editar dados" fica em "Mais". Abas "Versões" (TPL-05: número, situação, datas, hash resumido e
 * notas, com "Publicar" — TPL-10 — e "Aposentar" — TPL-11 — para quem tem `TEMPLATE_PUBLISH` no
 * menu ⋯ da linha) e "Configuração" (dados do template). Só `TEMPLATE_VIEW` navega em modo leitura
 * (FA-05). A API decide (RN-FND-92).
 */
export function TemplateVersionsView({ templateId }: { readonly templateId: string }) {
  const t = useTranslations('templates');
  const tShell = useTranslations('shell');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const canManage = usePermission('TEMPLATE_MANAGE').allowed;
  const canPublish = usePermission('TEMPLATE_PUBLISH').allowed;
  const [tab, setTab] = useState<Tab>('versions');
  const [publishing, setPublishing] = useState<TemplateVersionHistoryItem | null>(null);
  const [retiring, setRetiring] = useState<TemplateVersionHistoryItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftExists, setDraftExists] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const template = useQuery({
    queryKey: templateKeys.detail(tenantId, templateId),
    queryFn: async ({ signal }) => (await fetchTemplate(templateId, signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
  });
  const history = useQuery({
    queryKey: templateKeys.versions(tenantId, templateId),
    queryFn: async ({ signal }) => (await fetchTemplateVersions(templateId, signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
  };

  const create = useIdempotentMutation({
    mutationFn: (_: undefined, context) => createTemplateVersion(templateId, context),
  });

  const onCreate = async () => {
    setCreateError(null);
    setDraftExists(false);
    try {
      const result = await create.submit(undefined);
      toast({
        title: t('versions.toast.created', { number: result.data.versionNumber }),
        tone: 'success',
      });
      refresh();
      router.push(templateEditorHref(templateId, result.data.id));
    } catch (error) {
      // RN-TPL-13: outra pessoa criou o rascunho primeiro — a tela passa a oferecê-lo.
      if (isApiError(error) && error.code === 'TEMPLATE_DRAFT_EXISTS') {
        setDraftExists(true);
        refresh();
        return;
      }
      setCreateError(actionErrorMessage(error, t));
    }
  };

  const failure = template.error ?? history.error;
  if (failure && isApiError(failure) && failure.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  if (template.isPending) {
    return (
      <div role="status" className="flex w-full flex-col gap-5">
        <span className="sr-only">{t('versions.loading')}</span>
        <Skeleton className="h-4 w-48 max-w-full" />
        <Skeleton className="h-8 w-96 max-w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (template.isError) {
    return (
      <Alert tone="error" title={t('versions.loadFailed')}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void template.refetch();
            void history.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  }

  const data = template.data;
  const items = history.data ?? [];
  const draft = data.draftVersion;
  const published = data.currentPublishedVersion;

  return (
    <DetailPage
      breadcrumbs={[
        { label: tShell('admin.title'), href: '/admin' },
        { label: t('title'), href: TEMPLATES_PATH },
        { label: data.name },
      ]}
      breadcrumbLabel={t('detail.breadcrumbLabel')}
      linkComponent={Link}
      title={data.name}
      status={
        <>
          <StatusChip tone={data.isActive ? 'success' : 'warning'}>
            {data.isActive ? t('badges.active') : t('badges.inactive')}
          </StatusChip>
          {data.isDefault ? <StatusChip tone="info">{t('badges.default')}</StatusChip> : null}
          {data.isSystem ? <SystemTemplateBadge /> : null}
        </>
      }
      subtitle={t('versions.subtitle', { type: data.documentType.name })}
      actions={
        canManage ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" iconRight={<ChevronDown />}>
                  {t('actions.more')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  {t('actions.editDataLabel')}
                </DropdownMenuItem>
                {draft ? (
                  <DropdownMenuItem asChild>
                    <Link href={templateEditorHref(templateId, draft.id)}>
                      {t('versions.openDraft')}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            {draft === null ? (
              <Button
                disabled={create.isPending}
                aria-busy={create.isPending}
                onClick={() => void onCreate()}
              >
                {create.isPending ? t('versions.creating') : t('versions.newVersion')}
              </Button>
            ) : null}
          </>
        ) : null
      }
      facts={[
        { id: 'type', label: t('detail.facts.type'), value: data.documentType.name },
        {
          id: 'published',
          label: t('detail.facts.published'),
          value: published
            ? t('values.version', { number: published.versionNumber })
            : t('values.noVersion'),
        },
        {
          id: 'draft',
          label: t('detail.facts.draft'),
          value: draft
            ? t('values.draft', { number: draft.versionNumber, sections: draft.sectionCount })
            : t('values.noVersion'),
        },
        {
          id: 'updated',
          label: t('detail.facts.updated'),
          value: formatDateTime(data.updatedAt) ?? t('versions.noValue'),
        },
      ]}
      notices={
        <div className="flex flex-col gap-2 empty:hidden">
          {draftExists ? (
            <Alert tone="info" title={t('versions.draftExists')}>
              {draft ? (
                <Button asChild variant="secondary" size="sm" className="mt-2">
                  <Link href={templateEditorHref(templateId, draft.id)}>
                    {t('versions.openDraft')}
                  </Link>
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {createError ? <Alert tone="error" title={createError} /> : null}
        </div>
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value === 'config' ? 'config' : 'versions');
        }}
        className="min-w-0"
      >
        <TabsList aria-label={t('detail.tabs.label')}>
          <TabsTrigger value="versions">{t('detail.tabs.versions')}</TabsTrigger>
          <TabsTrigger value="config">{t('detail.tabs.config')}</TabsTrigger>
        </TabsList>
        <TabsContent value="versions" className="min-w-0">
          {history.isPending ? (
            <div role="status" className="flex flex-col gap-2">
              <span className="sr-only">{t('versions.loading')}</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : null}
          {history.isError ? (
            <Alert tone="error" title={t('versions.loadFailed')}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void history.refetch();
                }}
              >
                {t('retry')}
              </Button>
            </Alert>
          ) : null}
          {history.data ? (
            items.length === 0 ? (
              <EmptyState icon={<FileText />} title={t('versions.empty')} />
            ) : (
              <TableContainer
                label={t('versions.caption')}
                footer={<TableFooter summary={t('versions.count', { count: items.length })} />}
              >
                <VersionHistoryTable
                  template={data}
                  items={items}
                  canPublish={canPublish}
                  onPublish={setPublishing}
                  onRetire={setRetiring}
                />
              </TableContainer>
            )
          ) : null}
        </TabsContent>
        <TabsContent value="config" className="min-w-0">
          <ConfigPanel template={data} />
        </TabsContent>
      </Tabs>

      <TemplateFormDialog open={editing} template={data} existing={[]} onOpenChange={setEditing} />
      <PublishConfirmDialog
        templateId={templateId}
        item={publishing}
        onClose={() => {
          setPublishing(null);
        }}
        onDone={refresh}
      />
      <RetireConfirmDialog
        template={data}
        item={retiring}
        blocked={retiring !== null && retireBlocked(retiring, items, data.isDefault)}
        onClose={() => {
          setRetiring(null);
        }}
        onDone={refresh}
      />
    </DetailPage>
  );
}

/** Aba "Configuração": os dados do template (edição em "Mais › Editar dados"). */
function ConfigPanel({ template }: { readonly template: TemplateDto }) {
  const t = useTranslations('templates');
  const rows: readonly (readonly [string, string])[] = [
    [t('detail.config.name'), template.name],
    [t('detail.config.description'), template.description ?? t('detail.config.noDescription')],
    [t('detail.config.type'), template.documentType.name],
    [t('detail.config.status'), template.isActive ? t('badges.active') : t('badges.inactive')],
    [
      t('detail.config.default'),
      template.isDefault ? t('detail.config.yes') : t('detail.config.no'),
    ],
    [
      t('detail.config.origin'),
      template.isSystem ? t('detail.config.origins.system') : t('detail.config.origins.custom'),
    ],
    [t('detail.config.createdAt'), formatDateTime(template.createdAt) ?? t('versions.noValue')],
  ];
  return (
    <section
      aria-labelledby="template-config-title"
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-card"
    >
      <h2 id="template-config-title" className="text-section-title text-brand-ink">
        {t('detail.config.title')}
      </h2>
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-label font-semibold text-muted-foreground uppercase">{label}</dt>
            <dd className="text-sm font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** `VersionHistoryTable`: situação, datas, hash resumido, notas e ações por linha (menu ⋯). */
function VersionHistoryTable({
  template,
  items,
  canPublish,
  onPublish,
  onRetire,
}: {
  readonly template: TemplateDto;
  readonly items: readonly TemplateVersionHistoryItem[];
  readonly canPublish: boolean;
  readonly onPublish: (item: TemplateVersionHistoryItem) => void;
  readonly onRetire: (item: TemplateVersionHistoryItem) => void;
}) {
  const t = useTranslations('templates');
  return (
    <Table>
      <caption className="sr-only">{t('versions.caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('versions.table.number')}</Th>
          <Th>{t('versions.table.status')}</Th>
          <Th className="hidden md:table-cell">{t('versions.table.publishedAt')}</Th>
          <Th className="hidden lg:table-cell">{t('versions.table.hash')}</Th>
          <Th className="hidden lg:table-cell">{t('versions.table.notes')}</Th>
          <Th className="w-12">
            <span className="sr-only">{t('versions.table.actions')}</span>
          </Th>
        </Tr>
      </TableHead>
      <TableBody>
        {items.map((item) => {
          const hash = shortHash(item.contentHash);
          const retiredAt = formatDateTime(item.retiredAt);
          return (
            <Tr key={item.id}>
              <th scope="row" className="px-3.5 py-3 text-left font-bold">
                {t('versions.number', { number: item.versionNumber })}
              </th>
              <Td>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusChip
                    tone={
                      item.status === 'PUBLISHED'
                        ? 'success'
                        : item.status === 'DRAFT'
                          ? 'info'
                          : 'neutral'
                    }
                  >
                    {t(`versions.status.${item.status}`)}
                  </StatusChip>
                  {item.isCurrent ? (
                    <StatusChip tone="info">{t('versions.current')}</StatusChip>
                  ) : null}
                </div>
                {retiredAt ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t('versions.retiredOn', { date: retiredAt })}
                  </span>
                ) : null}
              </Td>
              <Td className="hidden whitespace-nowrap md:table-cell">
                {formatDateTime(item.publishedAt) ?? t('versions.noValue')}
              </Td>
              <Td className="hidden font-mono text-xs lg:table-cell">
                {hash ? (
                  <span title={item.contentHash ?? undefined}>{hash}</span>
                ) : (
                  t('versions.noValue')
                )}
              </Td>
              <Td className="hidden max-w-xs text-muted-foreground lg:table-cell">
                {item.changeNotes ?? t('versions.noValue')}
              </Td>
              <Td className="w-12 py-1.5 text-right">
                <VersionRowMenu
                  template={template}
                  item={item}
                  blocked={retireBlocked(item, items, template.isDefault)}
                  canPublish={canPublish}
                  onPublish={onPublish}
                  onRetire={onRetire}
                />
              </Td>
            </Tr>
          );
        })}
      </TableBody>
    </Table>
  );
}

function VersionRowMenu({
  template,
  item,
  blocked,
  canPublish,
  onPublish,
  onRetire,
}: {
  readonly template: TemplateDto;
  readonly item: TemplateVersionHistoryItem;
  readonly blocked: boolean;
  readonly canPublish: boolean;
  readonly onPublish: (item: TemplateVersionHistoryItem) => void;
  readonly onRetire: (item: TemplateVersionHistoryItem) => void;
}) {
  const t = useTranslations('templates');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('versions.actions.menu', { number: item.versionNumber })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={templateEditorHref(template.id, item.id)}>
            {item.status === 'DRAFT'
              ? t('versions.actions.editLabel')
              : t('versions.actions.viewLabel')}
          </Link>
        </DropdownMenuItem>
        {canPublish && item.status === 'DRAFT' ? (
          <DropdownMenuItem
            onSelect={() => {
              onPublish(item);
            }}
          >
            {t('versions.actions.publishLabel')}
          </DropdownMenuItem>
        ) : null}
        {canPublish && item.status === 'PUBLISHED' ? (
          <>
            <DropdownMenuItem
              disabled={blocked}
              onSelect={() => {
                onRetire(item);
              }}
            >
              {t('versions.actions.retireLabel')}
            </DropdownMenuItem>
            {blocked ? (
              <p className="max-w-56 px-3 pb-2 text-xs text-muted-foreground">
                {t('versions.retireBlocked')}
              </p>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Lista de pendências (locais ou do 422), referenciada pelo `aria-describedby` do diálogo. */
function ProblemList({
  id,
  problems,
}: {
  readonly id: string;
  readonly problems: readonly PublishProblem[];
}) {
  return (
    <ul id={id} className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {problems.map((problem, index) => (
        <li key={`${problem.sectionKey ?? 'geral'}-${String(index)}`}>
          {problem.sectionKey ? <span className="font-mono">{problem.sectionKey}: </span> : null}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

const fromViolations = (violations: readonly Violation[]): PublishProblem[] =>
  violations.map((violation) => ({ sectionKey: violation.sectionKey, message: violation.message }));

/**
 * `PublishConfirmDialog` (passos 2–4): confere o rascunho com a validação do editor antes de
 * enviar (desabilita "Publicar" havendo pendências) e mostra as violações do 422 por seção.
 */
export function PublishConfirmDialog({
  templateId,
  item,
  onClose,
  onDone,
}: {
  readonly templateId: string;
  readonly item: TemplateVersionHistoryItem | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <PublishBody
          key={item.id}
          templateId={templateId}
          item={item}
          onClose={onClose}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  );
}

function PublishBody({
  templateId,
  item,
  onClose,
  onDone,
}: {
  readonly templateId: string;
  readonly item: TemplateVersionHistoryItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const ids = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [serverProblems, setServerProblems] = useState<PublishProblem[]>([]);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const draft = useQuery({
    queryKey: templateKeys.version(tenantId, item.id),
    queryFn: async ({ signal }) => (await fetchTemplateVersion(item.id, signal)).data,
    staleTime: 0,
  });
  const localProblems = draft.data ? prePublishProblems(draft.data) : [];
  const problems = serverProblems.length > 0 ? serverProblems : localProblems;

  const publish = useIdempotentMutation({
    mutationFn: (_: undefined, context) => publishTemplateVersion(item.id, item.version, context),
  });

  const onConfirm = async () => {
    setError(null);
    setServerProblems([]);
    try {
      const result = await publish.submit(undefined);
      toast({
        title: t('versions.toast.published', {
          number: result.data.versionNumber,
          hash: shortHash(result.data.contentHash) ?? '',
        }),
        tone: 'success',
      });
      onDone();
      onClose();
    } catch (failure) {
      if (isApiError(failure) && failure.code === 'TEMPLATE_INVALID') {
        setServerProblems(fromViolations(failure.violations));
        return;
      }
      setError(failure instanceof Error ? failure : new Error(String(failure)));
      if (isApiError(failure) && failure.code !== 'DEPENDENCY_UNAVAILABLE') onDone();
    }
  };

  const blocked = problems.length > 0 || draft.isPending || draft.isError;
  const unavailable = isApiError(error) && error.code === 'DEPENDENCY_UNAVAILABLE';
  // Foco inicial na ação primária assim que o rascunho conferido a habilita.
  useEffect(() => {
    if (!blocked) confirmRef.current?.focus();
  }, [blocked]);
  return (
    <DialogContent
      aria-describedby={problems.length > 0 ? `${ids}-problems` : `${ids}-description`}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        confirmRef.current?.focus();
      }}
    >
      <DialogTitle>{t('versions.publish.title', { number: item.versionNumber })}</DialogTitle>
      <DialogDescription id={`${ids}-description`}>
        {t('versions.publish.description')}
      </DialogDescription>
      {draft.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('versions.publish.checking')}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <Alert tone="error" title={t('versions.publish.violationsTitle')}>
          <ProblemList id={`${ids}-problems`} problems={problems} />
          <Button asChild variant="secondary" size="sm" className="mt-2">
            <Link href={templateEditorHref(templateId, item.id)}>
              {t('versions.publish.openEditor')}
            </Link>
          </Button>
        </Alert>
      ) : null}
      {error ? <Alert tone="error" title={actionErrorMessage(error, t)} /> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('versions.publish.cancel')}
        </Button>
        <Button
          ref={confirmRef}
          disabled={blocked || publish.isPending || (error !== null && !unavailable)}
          aria-busy={publish.isPending}
          title={problems.length > 0 ? t('versions.publishBlocked') : undefined}
          onClick={() => void onConfirm()}
        >
          {publish.isPending
            ? t('versions.publish.publishing')
            : unavailable
              ? t('versions.errors.retry')
              : t('versions.publish.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * `RetireConfirmDialog` (passo 6 · FA-03): bloqueia com explicação quando é a única versão
 * publicada de um template padrão (`TEMPLATE_IN_USE`) e sugere iniciar uma nova versão.
 */
function RetireConfirmDialog({
  template,
  item,
  blocked,
  onClose,
  onDone,
}: {
  readonly template: TemplateDto | null;
  readonly item: TemplateVersionHistoryItem | null;
  readonly blocked: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('templates');
  const ids = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const retire = useMutation({
    mutationFn: (target: TemplateVersionHistoryItem) =>
      retireTemplateVersion(target.id, target.version),
    onSuccess: (result) => {
      toast({
        title: t('versions.toast.retired', { number: result.data.versionNumber }),
        tone: 'success',
      });
      onDone();
      onClose();
    },
    onError: (error) => {
      setMessage(
        isApiError(error) && error.code === 'TEMPLATE_IN_USE'
          ? error.message
          : actionErrorMessage(error, t),
      );
      onDone();
    },
  });

  const inUse = blocked
    ? t('versions.retire.inUse', { type: template?.documentType.name ?? '' })
    : null;
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          setMessage(null);
          onClose();
        }
      }}
    >
      {item ? (
        <DialogContent
          aria-describedby={`${ids}-description`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <DialogTitle>{t('versions.retire.title', { number: item.versionNumber })}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>
            {inUse ?? t('versions.retire.description')}
          </DialogDescription>
          {message ? <Alert tone="error" title={message} /> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setMessage(null);
                onClose();
              }}
            >
              {t('versions.retire.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="destructive"
              disabled={inUse !== null || message !== null || retire.isPending}
              aria-busy={retire.isPending}
              onClick={() => {
                retire.mutate(item);
              }}
            >
              {retire.isPending ? t('versions.retire.retiring') : t('versions.retire.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
