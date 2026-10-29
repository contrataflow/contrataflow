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
  Field,
  FilterToolbar,
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
  Workflow,
  toast,
} from '@contrataflow/ui';
import type { WorkflowDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { WorkflowFormDialog } from './workflow-form-dialog';
import {
  canBecomeDefault,
  describeApplicability,
  fetchWorkflows,
  setDefaultWorkflow,
  workflowEditorHref,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';

type StatusFilter = typeof ALL | 'active' | 'inactive';

/** Texto sem acento nem maiúsculas, para a busca local. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Busca local em nome, chave e descrição. */
function matchesSearch(workflow: WorkflowDto, search: string): boolean {
  const term = fold(search.trim());
  if (term === '') return true;
  return [workflow.name, workflow.key, workflow.description ?? ''].some((value) =>
    fold(value).includes(term),
  );
}

/**
 * SCR-034 (`/admin/workflows` — US-042): `WorkflowList` no modelo `ListPage` com os workflows do
 * tenant na ordem em que a aplicabilidade é avaliada, o selo "Padrão" e "Tornar padrão" (com
 * confirmação) no menu ⋯ para quem tem `WORKFLOW_PUBLISH` — oculto sem a permissão e desabilitado,
 * com o motivo, para workflow inativo ou sem versão publicada (RN-WF-41). Com `WORKFLOW_MANAGE`,
 * "Novo workflow" (US-043 · WF-02) abre o painel lateral; cada workflow abre o editor. A API
 * decide (RN-FND-92).
 */
export function WorkflowsView() {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const canPublish = usePermission('WORKFLOW_PUBLISH').allowed;
  const canManage = usePermission('WORKFLOW_MANAGE').allowed;
  const [confirming, setConfirming] = useState<WorkflowDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(ALL);

  const workflows = useQuery({
    queryKey: workflowKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchWorkflows(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
  });

  const items = useMemo(
    () =>
      (workflows.data ?? []).filter(
        (workflow) =>
          matchesSearch(workflow, search) &&
          (status === ALL || workflow.isActive === (status === 'active')),
      ),
    [workflows.data, search, status],
  );

  if (workflows.error && isApiError(workflows.error) && workflows.error.status === 403) {
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

  const current = workflows.data?.find((workflow) => workflow.isDefault) ?? null;
  const activeCount = status === ALL ? 0 : 1;
  const filtered = search.trim() !== '' || activeCount > 0;
  const statusLabel = (value: StatusFilter) =>
    value === 'active' ? t('filters.active') : t('filters.inactive');
  const chips =
    status === ALL
      ? []
      : [
          {
            id: 'status',
            label: t('filters.chip', { label: t('filters.status'), value: statusLabel(status) }),
            removeLabel: t('filters.removeChip', {
              label: t('filters.status'),
              value: statusLabel(status),
            }),
            onRemove: () => {
              setStatus(ALL);
            },
          },
        ];
  const newWorkflow = canManage ? (
    <Button
      iconLeft={<Plus />}
      onClick={() => {
        setCreating(true);
      }}
    >
      {t('form.open')}
    </Button>
  ) : null;

  return (
    <ListPage
      header={
        <AppPageHeader
          section="admin"
          title={t('title')}
          description={t('description')}
          actions={workflows.data ? newWorkflow : null}
        />
      }
      toolbar={
        workflows.data && workflows.data.length > 0 ? (
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
            }
            chips={chips}
            onClearAll={() => {
              setStatus(ALL);
            }}
          />
        ) : null
      }
      loading={workflows.isPending}
      loadingLabel={t('loading')}
      error={
        workflows.isError ? (
          <Alert tone="error" title={t('loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void workflows.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        ) : null
      }
      empty={
        workflows.data && items.length === 0 ? (
          <EmptyState
            icon={<Workflow />}
            title={filtered ? t('emptyFiltered') : t('empty')}
            description={filtered ? t('emptyFilteredHint') : t('emptyHint')}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setStatus(ALL);
                  }}
                >
                  {t('filters.clear')}
                </Button>
              ) : undefined
            }
          />
        ) : null
      }
    >
      {items.length > 0 ? (
        <TableContainer
          label={t('caption')}
          footer={<TableFooter summary={t('count', { count: items.length })} />}
        >
          <WorkflowList workflows={items} canPublish={canPublish} onSetDefault={setConfirming} />
        </TableContainer>
      ) : null}

      <WorkflowFormDialog open={creating} onOpenChange={setCreating} />

      <SetDefaultDialog
        workflow={confirming}
        current={current}
        onClose={() => {
          setConfirming(null);
        }}
      />
    </ListPage>
  );
}

function ApplicabilityText({ rule }: { readonly rule: unknown }) {
  const t = useTranslations('workflows');
  const applicability = describeApplicability(rule);
  if (applicability.kind === 'ANY') return <>{t('values.anyProcess')}</>;
  if (applicability.kind === 'MODALITIES') {
    return <>{t('values.modalities', { modalities: applicability.codes.join(', ') })}</>;
  }
  return <>{t('values.customRule')}</>;
}

/**
 * `WorkflowList`: nome em negrito (link para o editor) com a chave na linha secundária,
 * aplicabilidade com a prioridade, versão publicada, versão em edição e situação (selo "Padrão"
 * com texto, não só cor); "Abrir editor" e "Tornar padrão" no menu ⋯ da linha.
 */
function WorkflowList({
  workflows,
  canPublish,
  onSetDefault,
}: {
  readonly workflows: readonly WorkflowDto[];
  readonly canPublish: boolean;
  readonly onSetDefault: (workflow: WorkflowDto) => void;
}) {
  const t = useTranslations('workflows');
  const router = useRouter();
  const ids = useId();
  return (
    <Table>
      <caption className="sr-only">{t('caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('columns.name')}</Th>
          <Th>{t('columns.applicability')}</Th>
          <Th>{t('columns.version')}</Th>
          <Th>{t('columns.draft')}</Th>
          <Th>{t('columns.status')}</Th>
          <Th className="w-12">
            <span className="sr-only">{t('columns.actions')}</span>
          </Th>
        </Tr>
      </TableHead>
      <TableBody>
        {workflows.map((workflow) => {
          const reasonId = `${ids}-${workflow.id}-reason`;
          const eligible = canBecomeDefault(workflow);
          const offersDefault = canPublish && !workflow.isDefault;
          return (
            <Tr key={workflow.id}>
              <th scope="row" className="px-3.5 py-3 text-left font-normal">
                <Link
                  href={workflowEditorHref(workflow.id)}
                  className="block font-bold text-foreground underline-offset-2 hover:underline"
                >
                  {workflow.name}
                </Link>
                <span className="font-mono text-xs text-muted-foreground">{workflow.key}</span>
              </th>
              <Td>
                <span className="block">
                  <ApplicabilityText rule={workflow.applicabilityRule} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('values.priority', { value: workflow.applicabilityPriority })}
                </span>
              </Td>
              <Td className="whitespace-nowrap">
                {workflow.currentPublishedVersion
                  ? t('values.published', {
                      number: workflow.currentPublishedVersion.versionNumber,
                    })
                  : t('values.noPublished')}
              </Td>
              <Td className="whitespace-nowrap">
                {workflow.draftVersion
                  ? t('values.draft', { number: workflow.draftVersion.versionNumber })
                  : workflow.currentPublishedVersion
                    ? t('values.noDraft')
                    : t('values.noEditableVersion')}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  {workflow.isDefault ? (
                    <StatusChip tone="success">{t('badges.default')}</StatusChip>
                  ) : null}
                  <StatusChip tone={workflow.isActive ? 'info' : 'neutral'}>
                    {workflow.isActive ? t('badges.active') : t('badges.inactive')}
                  </StatusChip>
                </div>
              </Td>
              <Td className="w-12 py-1.5 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('rowMenu.label', { name: workflow.name })}
                      className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                    >
                      <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        router.push(workflowEditorHref(workflow.id));
                      }}
                    >
                      {t('rowMenu.open')}
                    </DropdownMenuItem>
                    {offersDefault ? (
                      <DropdownMenuItem
                        disabled={!eligible}
                        aria-describedby={eligible ? undefined : reasonId}
                        onSelect={() => {
                          onSetDefault(workflow);
                        }}
                      >
                        {t('setDefault.action')}
                      </DropdownMenuItem>
                    ) : null}
                    {offersDefault && !eligible ? (
                      <p
                        id={reasonId}
                        className="max-w-60 px-2.5 py-1.5 text-xs text-muted-foreground"
                      >
                        {t('setDefault.ineligible')}
                      </p>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Td>
            </Tr>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** `SetDefaultButton` (confirmação): WF-05 com o `If-Match` da versão lida. */
function SetDefaultDialog({
  workflow,
  current,
  onClose,
}: {
  readonly workflow: WorkflowDto | null;
  readonly current: WorkflowDto | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={workflow !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {workflow ? (
          <SetDefaultBody
            key={workflow.id}
            workflow={workflow}
            current={current}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SetDefaultBody({
  workflow,
  current,
  onClose,
}: {
  readonly workflow: WorkflowDto;
  readonly current: WorkflowDto | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => setDefaultWorkflow(workflow.id, workflow.version),
    onSuccess: (result) => {
      toast({ title: t('setDefault.success', { name: result.data.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.all(tenantId) });
      onClose();
    },
    onError: (failure) => {
      if (!isApiError(failure)) setError(t('errors.generic'));
      else if (failure.status === 412 || failure.status === 428) setError(t('errors.conflict'));
      else if (failure.code === 'MFA_REQUIRED') setError(t('errors.mfa'));
      else if (failure.status === 403) setError(t('errors.permission'));
      else if (failure.code === 'BUSINESS_RULE_VIOLATION') setError(t('errors.ineligible'));
      else if (failure.status === 503) setError(t('errors.unavailable'));
      else setError(failure.message || t('errors.generic'));
      // Recarrega a lista (o ETag pode ter mudado).
      void queryClient.invalidateQueries({ queryKey: workflowKeys.all(tenantId) });
    },
  });

  return (
    <>
      <DialogTitle>{t('setDefault.title', { name: workflow.name })}</DialogTitle>
      <DialogDescription>{t('setDefault.description')}</DialogDescription>
      {current ? (
        <p className="text-sm">{t('setDefault.current', { name: current.name })}</p>
      ) : null}
      <div aria-live="assertive">{error ? <Alert tone="error" title={error} /> : null}</div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('setDefault.cancel')}
        </Button>
        <Button
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {t('setDefault.confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
