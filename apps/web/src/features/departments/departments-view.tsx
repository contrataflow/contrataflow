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
import type { DepartmentDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { DepartmentFormDialog } from './department-form-dialog';
import type { DepartmentFormTarget } from './department-form-dialog';
import { DepartmentTree } from './department-tree';
import type { DepartmentAction } from './department-tree';
import { idsWithChildren, labelsFrom } from './department-tree-model';
import {
  DEPARTMENTS_STALE_TIME_MS,
  createDepartment,
  deleteDepartment,
  departmentKeys,
  fetchDepartmentTree,
  moveDepartment,
  setDepartmentActive,
} from './departments.api';
import { MoveDepartmentDialog } from './move-department-dialog';
import { ImplementationAssistant } from '../implementation-assistant/implementation-assistant';
import { shouldShowImplementationAssistant } from '../implementation-assistant/suggested-structure';
import {
  ORGANIZATIONS_STALE_TIME_MS,
  fetchOrganizations,
  organizationKeys,
} from '../organizations/organizations.api';
import { fetchPublicSettings, settingsKeys } from '../settings/settings.api';

/**
 * Aba "Secretarias" do SCR-032 (`/admin/estrutura` — US-102): escolhe o órgão, carrega a árvore
 * (DEP-01) e permite criar (DEP-03), editar (DEP-05), mover por arrastar ou "Mover para…"
 * (DEP-06), desativar/ativar (DEP-07/08) e excluir unidade sem uso (DEP-09; em uso → oferece
 * "Desativar"). Leitura é implícita; as ações só aparecem com `DEPARTMENT_MANAGE`. Órgão sem
 * unidades e quem gerencia → assistente de implantação (US-099 · FA-09). Rótulos conforme
 * `labels.*` (FA-06).
 */
export function DepartmentsView() {
  const t = useTranslations('departments');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const selectId = useId();
  const canManage = usePermission('DEPARTMENT_MANAGE').allowed;

  const organizations = useQuery({
    queryKey: organizationKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchOrganizations(signal)).data,
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
  });
  const publicSettings = useQuery({
    queryKey: settingsKeys.public(tenantId),
    queryFn: async ({ signal }) => (await fetchPublicSettings(signal)).data,
    staleTime: DEPARTMENTS_STALE_TIME_MS,
    throwOnError: false,
  });
  const labels = useMemo(() => labelsFrom(publicSettings.data), [publicSettings.data]);

  const activeOrganizations = useMemo(
    () => (organizations.data ?? []).filter((organization) => organization.isActive),
    [organizations.data],
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const organization =
    activeOrganizations.find((item) => item.id === chosenId) ??
    activeOrganizations.find((item) => item.isPrimary) ??
    activeOrganizations[0];
  const organizationId = organization?.id ?? '';

  const departments = useQuery({
    queryKey: departmentKeys.tree(tenantId, organizationId),
    queryFn: ({ signal }) => fetchDepartmentTree(organizationId, signal),
    enabled: organizationId !== '',
    staleTime: DEPARTMENTS_STALE_TIME_MS,
  });

  // Expansão por órgão; antes do primeiro clique, a árvore abre toda expandida.
  const [expandedByOrganization, setExpandedByOrganization] = useState<
    Readonly<Record<string, ReadonlySet<string>>>
  >({});
  const expanded =
    expandedByOrganization[organizationId] ?? idsWithChildren(departments.data ?? []);
  const setExpanded = (update: (current: ReadonlySet<string>) => Set<string>) => {
    setExpandedByOrganization((all) => ({
      ...all,
      [organizationId]: update(all[organizationId] ?? expanded),
    }));
  };

  const [form, setForm] = useState<DepartmentFormTarget | null>(null);
  const [moving, setMoving] = useState<DepartmentDto | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<DepartmentDto | null>(null);
  const [deleting, setDeleting] = useState<DepartmentDto | null>(null);
  const [deleteInUse, setDeleteInUse] = useState(false);
  const [assistantDismissed, setAssistantDismissed] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: departmentKeys.all(tenantId) });
  };
  const messageOf = (error: unknown): string => {
    if (!isApiError(error)) return t('errors.generic');
    if (error.code === 'DEPARTMENT_CYCLE') return t('errors.cycle');
    if (error.status === 412) return t('errors.conflict');
    if (error.status === 403) return t('errors.permission');
    if (error.status === 503) return t('errors.unavailable');
    return error.errors[0]?.message ?? (error.message || t('errors.generic'));
  };

  const move = useMutation({
    mutationFn: (input: { department: DepartmentDto; parentId: string | null }) =>
      moveDepartment(input.department.id, input.parentId, input.department.version),
    onSuccess: (result, { parentId }) => {
      toast({ title: t('toast.moved', { name: result.data.name }), tone: 'success' });
      setMoving(null);
      setMoveError(null);
      if (parentId) setExpanded((current) => new Set(current).add(parentId));
      refresh();
    },
    onError: (error) => {
      const message = messageOf(error);
      // Arrastar: o diálogo não está aberto — o erro aparece como aviso e a árvore é relida.
      if (moving) setMoveError(message);
      else toast({ title: message, tone: 'error' });
      refresh();
    },
  });
  const toggleActive = useMutation({
    mutationFn: (input: { department: DepartmentDto; isActive: boolean }) =>
      setDepartmentActive(input.department.id, input.isActive, input.department.version),
    onSuccess: (result, { isActive }) => {
      toast({
        title: t(isActive ? 'toast.activated' : 'toast.deactivated', { name: result.data.name }),
        tone: 'success',
      });
      setDeactivating(null);
      setDeleting(null);
      refresh();
    },
    onError: (error) => {
      toast({ title: messageOf(error), tone: 'error' });
      refresh();
    },
  });
  const remove = useMutation({
    // Unidade em uso (409 `DEPARTMENT_HAS_REFERENCES`) é desfecho esperado, tratado no próprio
    // diálogo ("Desativar" no lugar de excluir): não vira erro da mutação, para não abrir o diálogo
    // global de conflito (architecture.md §8.12). Os demais erros seguem a política transversal.
    mutationFn: async (department: DepartmentDto): Promise<'deleted' | 'in-use'> => {
      try {
        await deleteDepartment(department.id, department.version);
        return 'deleted';
      } catch (error) {
        if (isApiError(error) && error.code === 'DEPARTMENT_HAS_REFERENCES') return 'in-use';
        throw error;
      }
    },
    onSuccess: (outcome, department) => {
      if (outcome === 'in-use') {
        setDeleteInUse(true);
      } else {
        toast({ title: t('toast.deleted', { name: department.name }), tone: 'success' });
        setDeleting(null);
      }
      refresh();
    },
    onError: (error) => {
      toast({ title: messageOf(error), tone: 'error' });
      refresh();
    },
  });

  const onAction = (action: DepartmentAction, department: DepartmentDto) => {
    switch (action) {
      case 'addChild':
        setForm({ mode: 'create', parent: department });
        break;
      case 'edit':
        setForm({ mode: 'edit', department });
        break;
      case 'move':
        setMoveError(null);
        setMoving(department);
        break;
      case 'deactivate':
        setDeactivating(department);
        break;
      case 'activate':
        toggleActive.mutate({ department, isActive: true });
        break;
      case 'delete':
        setDeleteInUse(false);
        setDeleting(department);
        break;
    }
  };

  if (organizations.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('organizationsLoading')}</span>
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (!organization) {
    return <p className="text-sm text-muted-foreground">{t('noOrganizations')}</p>;
  }

  const showAssistant =
    !assistantDismissed &&
    departments.data !== undefined &&
    shouldShowImplementationAssistant({
      canManageDepartments: canManage,
      departmentCount: departments.data.length,
    });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          {activeOrganizations.length > 1 ? (
            <>
              <label htmlFor={selectId} className="text-sm font-medium">
                {t('organization')}
              </label>
              <select
                id={selectId}
                className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
                value={organizationId}
                onChange={(event) => {
                  setChosenId(event.target.value);
                }}
              >
                {activeOrganizations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{organization.name}</p>
          )}
        </div>
        {departments.data && !showAssistant ? (
          <Can permission="DEPARTMENT_MANAGE">
            <Button
              onClick={() => {
                setForm({ mode: 'create', parent: null });
              }}
            >
              {t('new')}
            </Button>
          </Can>
        ) : null}
      </header>

      {departments.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-11/12" />
          <Skeleton className="h-8 w-10/12" />
        </div>
      ) : null}

      {departments.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void departments.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {showAssistant ? (
        <ImplementationAssistant
          organizationName={organization.name}
          createDepartment={async (input, idempotencyKey) =>
            (
              await createDepartment(
                {
                  organizationId,
                  type: input.type,
                  name: input.name,
                  ...(input.parentId === null ? {} : { parentId: input.parentId }),
                },
                idempotencyKey,
              )
            ).data
          }
          onDismiss={() => {
            setAssistantDismissed(true);
            refresh();
          }}
        />
      ) : null}

      {departments.data?.length === 0 && !showAssistant ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t('empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : null}

      {departments.data && departments.data.length > 0 ? (
        <DepartmentTree
          departments={departments.data}
          organizationName={organization.name}
          labels={labels}
          canManage={canManage}
          movingId={move.isPending ? move.variables.department.id : null}
          expanded={expanded}
          onToggle={(id) => {
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onAction={onAction}
          onMove={(department, target) => {
            move.mutate({ department, parentId: target?.id ?? null });
          }}
        />
      ) : null}

      <DepartmentFormDialog
        target={form}
        organizationId={organizationId}
        labels={labels}
        onClose={() => {
          setForm(null);
        }}
      />
      <MoveDepartmentDialog
        department={moving}
        departments={departments.data ?? []}
        pending={move.isPending}
        error={moveError}
        onCancel={() => {
          setMoving(null);
        }}
        onConfirm={(department, parentId) => {
          move.mutate({ department, parentId });
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
              disabled={toggleActive.isPending}
              aria-busy={toggleActive.isPending}
              onClick={() => {
                if (deactivating)
                  toggleActive.mutate({ department: deactivating, isActive: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('delete.title', { name: deleting?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
          {deleteInUse ? <Alert tone="warning" title={t('delete.inUse')} /> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {t('delete.cancel')}
            </Button>
            {deleteInUse && deleting?.isActive ? (
              <Button
                variant="destructive"
                disabled={toggleActive.isPending}
                onClick={() => {
                  toggleActive.mutate({ department: deleting, isActive: false });
                }}
              >
                {t('delete.deactivateInstead')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={remove.isPending || deleteInUse}
                aria-busy={remove.isPending}
                onClick={() => {
                  if (deleting) remove.mutate(deleting);
                }}
              >
                {t('delete.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
