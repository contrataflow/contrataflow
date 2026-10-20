import type { PermissionCode } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ProcessViewerResolver, assignCoversProcess, engineViewerFor } from './process-viewer.js';
import type { AccessFacade } from '../../access/application/access.facade.js';

/*
 * US-050 — POL-05 (RN-TRAM-36): `PROCESS_ASSIGN` vale para atribuir com escopo `TENANT` ou
 * `ORGANIZATION` do órgão do processo; escopo de unidade não basta (a chefia é a outra via).
 */

const ORG_A = '0192d050-0000-7000-8000-0000000001a0';
const ORG_B = '0192d050-0000-7000-8000-0000000001b0';
const COMPRAS = '0192d050-0000-7000-8000-0000000001a7';
const USER = '0192d050-0000-7000-8000-0000000001c1';

interface Scope {
  type: string;
  organizationId: string | null;
  departmentIds: string[];
}

/** `AccessFacade` com as permissões efetivas de um conjunto de escopos de `PROCESS_ASSIGN`. */
function accessWith(scopes: readonly Scope[]): AccessFacade {
  const permissions = {
    snapshot: { ownDepartmentIds: [COMPRAS], headOfDepartmentIds: [] },
    has: (permission: PermissionCode) => permission === 'PROCESS_ASSIGN' && scopes.length > 0,
    scopesOf: (permission: PermissionCode) => (permission === 'PROCESS_ASSIGN' ? scopes : []),
    coversTenantWide: (permission: PermissionCode) =>
      permission === 'PROCESS_ASSIGN' && scopes.some((scope) => scope.type === 'TENANT'),
    visibilityScope: () => ({}),
  };
  return { effectivePermissions: () => Promise.resolve(permissions) } as unknown as AccessFacade;
}

function resolve(scopes: readonly Scope[]) {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId: '0192d050-0000-7000-8000-00000000000a',
      actor: { type: 'USER', userId: USER, membershipId: null },
    });
    return new ProcessViewerResolver(accessWith(scopes)).resolve({} as TenantTx);
  });
}

describe('POL-05 — escopo de PROCESS_ASSIGN para atribuir (US-050)', () => {
  it('TENANT cobre qualquer processo', async () => {
    const viewer = await resolve([{ type: 'TENANT', organizationId: null, departmentIds: [] }]);
    expect(assignCoversProcess(viewer, ORG_A)).toBe(true);
    expect(assignCoversProcess(viewer, null)).toBe(true);
  });

  it('ORGANIZATION cobre só os processos do órgão', async () => {
    const viewer = await resolve([
      { type: 'ORGANIZATION', organizationId: ORG_A, departmentIds: [] },
    ]);
    expect(viewer.assignOrganizationIds).toEqual([ORG_A]);
    expect(assignCoversProcess(viewer, ORG_A)).toBe(true);
    expect(assignCoversProcess(viewer, ORG_B)).toBe(false);
    expect(assignCoversProcess(viewer, null)).toBe(false);
    expect(engineViewerFor(viewer, ORG_A).canAssignAnywhere).toBe(true);
    expect(engineViewerFor(viewer, ORG_B).canAssignAnywhere).toBe(false);
  });

  it('escopo de unidade não basta', async () => {
    const viewer = await resolve([
      { type: 'DEPARTMENT', organizationId: null, departmentIds: [COMPRAS] },
    ]);
    expect(viewer.engine.permissions.has('PROCESS_ASSIGN')).toBe(true);
    expect(viewer.assignOrganizationIds).toEqual([]);
    expect(assignCoversProcess(viewer, ORG_A)).toBe(false);
  });
});
