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
import type { WorkflowDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import {
  canBecomeDefault,
  describeApplicability,
  fetchWorkflows,
  setDefaultWorkflow,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

/**
 * SCR-034 (`/admin/workflows` — US-042): `WorkflowList` com os workflows do tenant na ordem em que a
 * aplicabilidade é avaliada, o `DefaultBadge` e o `SetDefaultButton` (com confirmação) para quem
 * tem `WORKFLOW_PUBLISH` — oculto sem a permissão e desabilitado, com o motivo, para workflow
 * inativo ou sem versão publicada (RN-WF-41). A API decide (RN-FND-92).
 */
export function WorkflowsView() {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const canPublish = usePermission('WORKFLOW_PUBLISH').allowed;
  const [confirming, setConfirming] = useState<WorkflowDto | null>(null);

  const workflows = useQuery({
    queryKey: workflowKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchWorkflows(signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
  });

  if (workflows.error && isApiError(workflows.error) && workflows.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const current = workflows.data?.find((workflow) => workflow.isDefault) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

      {workflows.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {workflows.isError ? (
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
      ) : null}

      {workflows.data ? (
        workflows.data.length === 0 ? (
          <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <WorkflowList
            workflows={workflows.data}
            canPublish={canPublish}
            onSetDefault={setConfirming}
          />
        )
      ) : null}

      <SetDefaultDialog
        workflow={confirming}
        current={current}
        onClose={() => {
          setConfirming(null);
        }}
      />
    </div>
  );
}

/** `DefaultBadge`: ícone + texto (não só cor). */
function DefaultBadge() {
  const t = useTranslations('workflows');
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-success-soft px-2 py-0.5 text-xs font-medium text-foreground">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
        <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
      </svg>
      {t('badges.default')}
    </span>
  );
}

function StatusBadge({ active }: { readonly active: boolean }) {
  const t = useTranslations('workflows');
  return (
    <span
      className={`inline-flex rounded-control bg-muted px-2 py-0.5 text-xs font-medium ${
        active ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      {active ? t('badges.active') : t('badges.inactive')}
    </span>
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

/** `WorkflowList`: cartões empilhados abaixo de 768 px e em linha a partir de `md`. */
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
  const ids = useId();
  return (
    <section aria-labelledby={`${ids}-caption`} className="flex flex-col gap-2">
      <h2 id={`${ids}-caption`} className="sr-only">
        {t('caption')}
      </h2>
      <ul className="flex flex-col gap-3">
        {workflows.map((workflow) => {
          const reasonId = `${ids}-${workflow.id}-reason`;
          const eligible = canBecomeDefault(workflow);
          return (
            <li
              key={workflow.id}
              className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card md:flex-row md:items-center md:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{workflow.name}</h3>
                  {workflow.isDefault ? <DefaultBadge /> : null}
                  <StatusBadge active={workflow.isActive} />
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-3">
                  <div>
                    <dt className="sr-only">{t('columns.applicability')}</dt>
                    <dd>
                      <ApplicabilityText rule={workflow.applicabilityRule} />
                    </dd>
                  </div>
                  <div>
                    <dt className="sr-only">{t('columns.priority')}</dt>
                    <dd>{t('values.priority', { value: workflow.applicabilityPriority })}</dd>
                  </div>
                  <div>
                    <dt className="sr-only">{t('columns.version')}</dt>
                    <dd>
                      {workflow.currentPublishedVersion
                        ? t('values.published', {
                            number: workflow.currentPublishedVersion.versionNumber,
                          })
                        : t('values.noPublished')}
                    </dd>
                  </div>
                </dl>
              </div>
              {canPublish && !workflow.isDefault ? (
                <div className="flex flex-col items-start gap-1 md:items-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!eligible}
                    aria-label={t('setDefault.actionFor', { name: workflow.name })}
                    aria-describedby={eligible ? undefined : reasonId}
                    onClick={() => {
                      onSetDefault(workflow);
                    }}
                  >
                    {t('setDefault.action')}
                  </Button>
                  {eligible ? null : (
                    <p id={reasonId} className="max-w-xs text-xs text-muted-foreground">
                      {t('setDefault.ineligible')}
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
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
