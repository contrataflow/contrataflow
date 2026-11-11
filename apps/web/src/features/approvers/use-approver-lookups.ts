'use client';

import { useQuery } from '@tanstack/react-query';

import { useTenantId } from '@/lib/session/session-context';

import {
  fetchActiveDepartments,
  fetchApproverRoles,
  fetchApproverUsers,
  workflowKeys,
  WORKFLOWS_STALE_TIME_MS,
} from '../workflows/workflows.api';

export interface ApproverOption {
  readonly value: string;
  readonly label: string;
}

export interface ApproverLookups {
  readonly users: readonly ApproverOption[] | undefined;
  readonly roles: readonly ApproverOption[] | undefined;
  readonly departments: readonly ApproverOption[] | undefined;
  readonly usersFailed: boolean;
  readonly rolesFailed: boolean;
  readonly departmentsFailed: boolean;
}

/**
 * Listas de apoio das linhas de aprovadores (USR-02, ROL-02, DEP-02 — US-132), com o mesmo cache
 * do painel da etapa (US-043). Só carrega o que as linhas pedem.
 */
export function useApproverLookups(needs: {
  readonly users: boolean;
  readonly roles: boolean;
  readonly departments: boolean;
}): ApproverLookups {
  const tenantId = useTenantId();
  const common = {
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  } as const;
  const users = useQuery({
    ...common,
    queryKey: workflowKeys.lookups(tenantId, 'users'),
    queryFn: async ({ signal }) => (await fetchApproverUsers(signal)).data,
    enabled: needs.users,
  });
  const roles = useQuery({
    ...common,
    queryKey: workflowKeys.lookups(tenantId, 'roles'),
    queryFn: async ({ signal }) => (await fetchApproverRoles(signal)).data,
    enabled: needs.roles,
  });
  const departments = useQuery({
    ...common,
    queryKey: workflowKeys.lookups(tenantId, 'departments'),
    queryFn: async ({ signal }) => (await fetchActiveDepartments(signal)).data,
    enabled: needs.departments,
  });
  return {
    users: users.data?.map((item) => ({ value: item.userId, label: item.socialName ?? item.name })),
    roles: roles.data?.map((item) => ({ value: item.id, label: item.name })),
    departments: departments.data?.map((item) => ({
      value: item.id,
      label: item.path || item.name,
    })),
    usersFailed: users.isError,
    rolesFailed: roles.isError,
    departmentsFailed: departments.isError,
  };
}
