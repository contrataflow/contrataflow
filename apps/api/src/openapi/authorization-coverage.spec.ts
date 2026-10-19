import { PERMISSIONS } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import { Controller, Delete, Get, Module, Patch, Post, Put } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { decide } from '#modules/access/domain/authorization-decision.js';
import { DEFAULT_ROLE_GRANTS, DEFAULT_ROLES } from '#modules/access/domain/default-roles.js';
import { EffectivePermissionSet } from '#modules/access/domain/effective-permissions.js';
import { API_MODULES } from '#modules/index.js';
import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import type { PermissionScopeType } from '#shared/auth/effective-permissions.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';

import {
  authorizationCoverageViolations,
  declaredPolicies,
  routeAuthorizations,
} from './authorization-coverage.js';
import { collectControllers } from './openapi-document.js';

/*
 * US-097 — meta-teste de decorators (RN-IAM-101 · V-07 · FA-04) e matriz gerada (permissions.md
 * §10): rotas com `@RequirePermission` × 15 perfis padrão × 4 escopos, decididas pela mesma fórmula
 * do `AuthorizationService` e comparadas com a matriz de permissions.md §3.2 (`DEFAULT_ROLE_GRANTS`,
 * conferida campo a campo com o documento em `default-roles.spec.ts`).
 */

const CONTROLLERS = collectControllers(API_MODULES);
const GRANTS: Readonly<Record<string, readonly PermissionCode[]>> = DEFAULT_ROLE_GRANTS;
const SCOPES: readonly PermissionScopeType[] = [
  'TENANT',
  'ORGANIZATION',
  'DEPARTMENT',
  'OWN_DEPARTMENTS',
];

/** Vínculo com um único perfil padrão no escopo informado. */
function holder(roleKey: string, type: PermissionScopeType): EffectivePermissionSet {
  return new EffectivePermissionSet({
    membershipId: 'm',
    userId: 'u',
    grants: [
      {
        scope: {
          type,
          organizationId: type === 'ORGANIZATION' ? 'org' : null,
          departmentId: type === 'DEPARTMENT' ? 'dep' : null,
          includeSubtree: false,
          departmentIds: type === 'DEPARTMENT' || type === 'OWN_DEPARTMENTS' ? ['dep'] : [],
        },
        permissions: GRANTS[roleKey] ?? [],
      },
    ],
    ownDepartmentIds: ['dep'],
    headOfDepartmentIds: [],
    computedAt: '2026-10-16T00:00:00.000Z',
  });
}

describe('meta-teste de autorização das rotas (US-097 · RN-IAM-101)', () => {
  it('toda rota mutável da API declara @RequirePermission ou @ImplicitAccess', () => {
    expect(authorizationCoverageViolations(CONTROLLERS)).toEqual([]);
  });

  it('as permissões declaradas existem no catálogo e as políticas, em POL-01..18', () => {
    const codes = new Set<string>(PERMISSIONS.map((permission) => permission.code));
    const declared = routeAuthorizations(CONTROLLERS).flatMap((entry) =>
      entry.requirement ? [entry.requirement.permission] : [],
    );
    expect(declared.length).toBeGreaterThan(60);
    expect(declared.filter((code) => !codes.has(code))).toEqual([]);
    expect([...declaredPolicies(CONTROLLERS).keys()].sort()).toEqual([
      // US-065: custódia (cancelar), edição de documento e reabertura — aplicadas pelo caso de uso.
      'POL-01',
      'POL-02',
      // US-052: decisão de aprovação (designação e segregação — aplicadas pelo caso de uso).
      'POL-03',
      // US-012: participantes (elegibilidade e autoinclusão — aplicadas pelo caso de uso).
      'POL-10',
      'POL-11',
      'POL-12',
      'POL-13',
      'POL-15',
      'POL-16',
      // US-115: gerar com IA (AI_GENERATE + edição do tipo + POL-02 + portão do órgão).
      'POL-18',
    ]);
  });

  it('[Validação] rota mutável nova sem decorator reprova o build apontando a rota', () => {
    @Controller('meta')
    @TenantScope('TENANT')
    class MetaController {
      @Post('ok')
      @RequirePermission('PROCESS_CREATE')
      ok() {
        return 'ok';
      }

      @Put('missing')
      missing() {
        return 'missing';
      }

      @Patch('implicit')
      @ImplicitAccess('Capacidade implícita de teste com motivo suficiente.')
      implicit() {
        return 'implicit';
      }

      @Delete('lazy')
      @ImplicitAccess('curto')
      lazy() {
        return 'lazy';
      }

      @Post('both')
      @RequirePermission('PROCESS_CREATE')
      @ImplicitAccess('Capacidade implícita de teste com motivo suficiente.')
      both() {
        return 'both';
      }

      @Post('unknown-policy')
      @RequirePermission('PROCESS_CREATE')
      @Policy('POL-99' as 'POL-01')
      unknownPolicy() {
        return 'unknown';
      }

      @Get('read')
      read() {
        return 'read';
      }

      @Post('platform')
      @TenantScope('PLATFORM')
      platform() {
        return 'platform';
      }

      @Post('lookup')
      @TenantScope('CROSS_TENANT_LOOKUP')
      @RequirePermission('PROCESS_CREATE')
      lookup() {
        return 'lookup';
      }
    }
    @Module({ controllers: [MetaController] })
    class MetaModule {}

    expect(authorizationCoverageViolations(collectControllers([MetaModule]))).toEqual([
      'MetaController.both (POST both): declara @RequirePermission e @ImplicitAccess ao mesmo tempo',
      'MetaController.lazy (DELETE lazy): @ImplicitAccess sem motivo (≥ 20 caracteres)',
      "MetaController.lookup (POST lookup): @RequirePermission só se aplica a rota @TenantScope('TENANT')",
      'MetaController.missing (PUT missing): rota mutável sem @RequirePermission nem @ImplicitAccess',
      'MetaController.unknownPolicy (POST unknown-policy): política fora do catálogo POL-01..17: POL-99',
    ]);
  });

  describe('matriz gerada: rotas × perfis padrão × escopos (permissions.md §10)', () => {
    const routes = routeAuthorizations(CONTROLLERS).filter((entry) => entry.requirement);
    const cases = routes.flatMap((route) =>
      DEFAULT_ROLES.flatMap((role) => SCOPES.map((scope) => ({ route, role: role.key, scope }))),
    );

    it('cobre todas as rotas com permissão, os 15 perfis e os 4 escopos', () => {
      expect(DEFAULT_ROLES).toHaveLength(15);
      expect(cases.length).toBe(routes.length * 15 * 4);
    });

    it('a decisão de cada combinação é a da matriz perfil × permissão (§3.2)', () => {
      const mismatches = cases.filter(({ route, role, scope }) => {
        const permission: PermissionCode = route.requirement?.permission ?? 'PROCESS_VIEW';
        const expected = (GRANTS[role] ?? []).includes(permission);
        const decision = decide({
          authenticated: true,
          tenantActive: true,
          membershipActive: true,
          riskLevel: 'LOW',
          grantedByRole: holder(role, scope).has(permission),
          grantedByParticipation: false,
          mfaPolicy: 'NONE',
          hasSecondFactor: true,
        });
        return decision.allowed !== expected;
      });
      expect(mismatches.map(({ route, role, scope }) => `${route.label} ${role} ${scope}`)).toEqual(
        [],
      );
    });
  });
});
