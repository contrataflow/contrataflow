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
import type { OrganizationDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { OrganizationFormDialog } from './organization-form-dialog';
import { OrganizationList } from './organization-list';
import {
  ORGANIZATIONS_STALE_TIME_MS,
  fetchOrganizations,
  organizationKeys,
  updateOrganization,
} from './organizations.api';

/**
 * Aba "Órgãos" do SCR-032 (`/admin/estrutura` — US-101): lista os órgãos do tenant (ORG-01),
 * cria (ORG-02) e edita/inativa/reativa (ORG-04, com `If-Match`). Leitura é capacidade implícita;
 * as ações de escrita só aparecem com `ORGANIZATION_MANAGE`. Estados: skeleton, vazio, erro com
 * "Tentar novamente" e conflito de versão.
 */
export function OrganizationsView() {
  const t = useTranslations('organizations');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OrganizationDto | null>(null);
  const [deactivating, setDeactivating] = useState<OrganizationDto | null>(null);
  const [deactivationError, setDeactivationError] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: organizationKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchOrganizations(signal)).data,
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
  });

  const setActive = useMutation({
    mutationFn: ({
      organization,
      isActive,
    }: {
      organization: OrganizationDto;
      isActive: boolean;
    }) => updateOrganization(organization.id, { isActive }, organization.version),
    onSuccess: (result, { isActive }) => {
      toast({
        title: t(isActive ? 'toast.reactivated' : 'toast.deactivated', { name: result.data.name }),
        tone: 'success',
      });
      setDeactivating(null);
      setDeactivationError(null);
      void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
    },
    onError: (error) => {
      setDeactivationError(isApiError(error) ? error.message : t('errors.generic'));
      // Versão desatualizada ou regra do órgão principal: a lista é relida (FA-04/FA-05).
      void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
    },
  });

  if (
    organizations.error &&
    isApiError(organizations.error) &&
    organizations.error.status === 403
  ) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{t('organizations.title')}</h2>
        {organizations.data ? (
          <Can permission="ORGANIZATION_MANAGE">
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('organizations.new')}
            </Button>
          </Can>
        ) : null}
      </header>

      {organizations.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('organizations.loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {organizations.isError ? (
        <Alert tone="error" title={t('organizations.loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void organizations.refetch();
            }}
          >
            {t('organizations.retry')}
          </Button>
        </Alert>
      ) : null}

      {organizations.data?.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t('organizations.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('organizations.emptyHint')}</p>
        </div>
      ) : null}

      {organizations.data && organizations.data.length > 0 ? (
        <OrganizationList
          organizations={organizations.data}
          onEdit={setEditing}
          onDeactivate={(organization) => {
            setDeactivationError(null);
            setDeactivating(organization);
          }}
          onReactivate={(organization) => {
            setActive.mutate({ organization, isActive: true });
          }}
        />
      ) : null}

      <OrganizationFormDialog open={creating} onOpenChange={setCreating} />
      <OrganizationFormDialog
        open={editing !== null}
        organization={editing ?? undefined}
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
          {deactivationError ? (
            <Alert tone="error" title={deactivationError}>
              {t('deactivate.blockedHint')}
            </Alert>
          ) : null}
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
                if (deactivating) setActive.mutate({ organization: deactivating, isActive: false });
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
