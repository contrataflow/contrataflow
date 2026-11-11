import { PERMISSIONS } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ROLES } from '#modules/access/domain/default-roles.js';
import { API_MODULES } from '#modules/index.js';
import type { PermissionScopeType } from '#shared/auth/effective-permissions.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';

import { AuthorizationHarness, grant, PROCESS_ID } from './support/authorization-harness.js';
import type { Outcome, Viewer } from './support/authorization-harness.js';
import { KNOWN_DIVERGENCES } from './support/divergences.js';
import {
  documentedParticipationPermissions,
  documentedRoleMatrix,
} from './support/permissions-doc.js';
import { routeAuthorizations } from '../../src/openapi/authorization-coverage.js';
import { collectControllers } from '../../src/openapi/openapi-document.js';

/*
 * Matriz gerada (permissions.md §10 · US-097 · RN-IAM-100/103/104): TODA rota com
 * `@RequirePermission` × os 15 perfis padrão × os 4 escopos × a situação do processo, decidida pelo
 * `AuthorizationService` real e comparada com o oráculo escrito a partir do DOCUMENTO — matriz
 * §3.2, cobertura de escopo §1.1, visibilidade §5 (não visível = 404) e participação §4. As
 * políticas contextuais (`@Policy`) ficam fora daqui: cada POL tem a sua bateria
 * (`policy-coverage.spec.ts`).
 */

const ROLE_MATRIX = documentedRoleMatrix();
const PARTICIPATION = documentedParticipationPermissions();
const SCOPABLE: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((permission) => permission.scopable).map((permission) => permission.code),
);
const SCOPES: readonly PermissionScopeType[] = [
  'TENANT',
  'ORGANIZATION',
  'DEPARTMENT',
  'OWN_DEPARTMENTS',
];

const USER = '0192f000-0000-7000-8000-0000000a06a1';
const ORG = '0192f000-0000-7000-8000-0000000a06b1';
const DEPT = '0192f000-0000-7000-8000-0000000a06c1';
const OTHER_ORG = '0192f000-0000-7000-8000-0000000a06b2';
const OTHER_DEPT = '0192f000-0000-7000-8000-0000000a06c2';

/**
 * Situações do processo do parâmetro de rota:
 * - `IN_SCOPE`: no órgão e na unidade cobertos pela atribuição (REQUESTING/CURRENT);
 * - `OUT_OF_SCOPE`: noutro órgão e noutra unidade, sem concessão ao usuário;
 * - `OWN_GRANT`: fora do escopo, mas com concessão `USER` ao usuário (criador, aprovador);
 * - `COLLABORATOR`: fora do escopo, com o usuário participante `COLLABORATOR` (§4).
 */
type Situation = 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'OWN_GRANT' | 'COLLABORATOR';
const SITUATIONS: readonly Situation[] = ['IN_SCOPE', 'OUT_OF_SCOPE', 'OWN_GRANT', 'COLLABORATOR'];

function target(situation: Situation): ProcessAccessTarget {
  const inScope = situation === 'IN_SCOPE';
  return {
    processId: PROCESS_ID,
    organizationId: inScope ? ORG : OTHER_ORG,
    departmentIds: [inScope ? DEPT : OTHER_DEPT],
    userIds: situation === 'OWN_GRANT' || situation === 'COLLABORATOR' ? [USER] : [],
    participations:
      situation === 'COLLABORATOR'
        ? [{ userId: USER, departmentId: null, role: 'COLLABORATOR', expiresAt: null }]
        : [],
    participantDepartmentIds: [],
  };
}

function viewer(role: string, scope: PermissionScopeType): Viewer {
  const permissions = [...(ROLE_MATRIX.get(role) ?? [])] as PermissionCode[];
  return {
    userId: USER,
    ownDepartmentIds: [DEPT],
    grants: [grant(scope, permissions, { organizationId: ORG, departmentIds: [DEPT] })],
  };
}

/** O que o documento diz que acontece (§1.1, §3.2, §4, §5). */
function expected(
  role: string,
  scope: PermissionScopeType,
  permission: PermissionCode,
  situation: Situation | null,
): Outcome {
  const granted = ROLE_MATRIX.get(role) ?? new Set<string>();
  if (situation === null) return granted.has(permission) ? 'ALLOW' : 'PERMISSION_DENIED';
  // O escopo da atribuição cobre o processo (§1.1)?
  const covers = situation === 'IN_SCOPE' || scope === 'TENANT';
  // Visível (§5): PROCESS_VIEW cobrindo o processo, ou concessão USER ao próprio usuário.
  const ownGrant = situation === 'OWN_GRANT' || situation === 'COLLABORATOR';
  const visible = (granted.has('PROCESS_VIEW') && covers) || ownGrant;
  if (!visible) return 'PROCESS_NOT_FOUND';
  // §7: ver o processo com concessão USER não depende de perfil.
  if (permission === 'PROCESS_VIEW' && ownGrant) return 'ALLOW';
  const byRole = granted.has(permission) && (covers || !SCOPABLE.has(permission));
  const byParticipation =
    situation === 'COLLABORATOR' && (PARTICIPATION.get('COLLABORATOR')?.has(permission) ?? false);
  return byRole || byParticipation ? 'ALLOW' : 'PERMISSION_DENIED';
}

const routes = routeAuthorizations(collectControllers(API_MODULES)).filter(
  (entry) => entry.tenantScope === 'TENANT' && entry.requirement,
);

describe('matriz gerada: rotas × perfis padrão × escopos × situação do processo (permissions.md §10)', () => {
  const harness = new AuthorizationHarness();

  beforeAll(() => {
    // `access.denied` e o log de decisão não interessam aqui.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('o oráculo lê do documento os 15 perfis (§3.2) e os 3 papéis de participação (§4)', () => {
    expect([...ROLE_MATRIX.keys()]).toEqual(DEFAULT_ROLES.map((role) => role.key));
    expect([...PARTICIPATION.keys()]).toEqual(['OBSERVER', 'COLLABORATOR', 'CONSULTANT']);
    expect([...(PARTICIPATION.get('OBSERVER') ?? [])]).toEqual([
      'PROCESS_VIEW',
      'PROCESS_FOLLOW',
      'COMMENT_CREATE',
      'APPROVAL_VIEW',
    ]);
    expect(PARTICIPATION.get('CONSULTANT')).toEqual(PARTICIPATION.get('COLLABORATOR'));
    expect(routes.length).toBeGreaterThan(100);
  });

  it('a decisão de cada combinação é a do documento (exceções nomeadas em support/divergences.ts)', async () => {
    const divergences: string[] = [];
    const accepted = new Map<string, number>(KNOWN_DIVERGENCES.map((rule) => [rule.id, 0]));
    let cases = 0;
    for (const route of routes) {
      const requirement = route.requirement;
      if (!requirement) continue;
      const situations: readonly (Situation | null)[] =
        requirement.scope === 'ANY' ? [null] : SITUATIONS;
      for (const role of ROLE_MATRIX.keys()) {
        for (const scope of SCOPES) {
          for (const situation of situations) {
            cases += 1;
            const actual = await harness.decide(
              viewer(role, scope),
              requirement,
              situation === null ? null : target(situation),
            );
            const wanted = expected(role, scope, requirement.permission, situation);
            if (actual === wanted) continue;
            const testCase = {
              route: route.label,
              permission: requirement.permission,
              role,
              scope,
              situation,
            };
            const rule = KNOWN_DIVERGENCES.find(
              (known) =>
                known.matches(testCase) && known.documented === wanted && known.current === actual,
            );
            if (rule) accepted.set(rule.id, (accepted.get(rule.id) ?? 0) + 1);
            else {
              divergences.push(
                `${route.label} | ${role} | ${scope} | ${situation ?? '-'}: esperado ${wanted}, obtido ${actual}`,
              );
            }
          }
        }
      }
    }
    expect(divergences).toEqual([]);
    // Regra que não casa mais nada está obsoleta: a decisão foi tomada, tirá-la de divergences.ts.
    expect([...accepted].filter(([, count]) => count === 0).map(([id]) => id)).toEqual([]);
    expect(cases).toBeGreaterThan(routes.length * 15 * 4 - 1);
  });
});
