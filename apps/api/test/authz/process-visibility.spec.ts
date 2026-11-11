import type { PermissionCode } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ProcessAccessRow,
  ProcessParticipantRow,
} from '#modules/process/application/ports.js';
import { accessGrantsOf } from '#modules/process/application/process-runtime.loader.js';
import type { PermissionRequirement } from '#shared/auth/authorization.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';

import { AuthorizationHarness, grant, NOW, PROCESS_ID } from './support/authorization-harness.js';
import type { Viewer } from './support/authorization-harness.js';
import { OWN_GRANT_PROCESS_VIEW } from './support/divergences.js';

/*
 * Visibilidade (permissions.md §5 · §10 · DEC-024 · RN-IAM-103/104 · RN-PROC-131/135): das linhas
 * de `process_access`/`process_participants` (como o runtime as lê — `accessGrantsOf`) até a
 * decisão do `AuthorizationService`. Não visível = 404 `PROCESS_NOT_FOUND`, igual ao inexistente;
 * visível sem a permissão = 403. O predicado SQL equivalente é conferido no PostgreSQL pela
 * suíte tenant-leak (`test/tenant-leak/authorization.spec.ts`).
 */

const ORG = '0192f000-0000-7000-8000-0000000b06b1';
const SECRETARIA_A = '0192f000-0000-7000-8000-0000000b06c1';
const UNIT_A = '0192f000-0000-7000-8000-0000000b06c2';
const UNIT_B = '0192f000-0000-7000-8000-0000000b06c3';
const UNIT_C = '0192f000-0000-7000-8000-0000000b06c4';
const ANA = '0192f000-0000-7000-8000-0000000b06a1';
const BETO = '0192f000-0000-7000-8000-0000000b06a2';
const CAIO = '0192f000-0000-7000-8000-0000000b06a3';
const DORA = '0192f000-0000-7000-8000-0000000b06a4';

const route = (permission: PermissionCode): PermissionRequirement => ({
  permission,
  scope: { processParam: 'id' },
});

/** Perfil com escopo `OWN_DEPARTMENTS` (lotações expandidas) e as permissões informadas. */
function lotado(
  userId: string,
  departments: readonly string[],
  permissions: readonly PermissionCode[],
): Viewer {
  return {
    userId,
    ownDepartmentIds: departments,
    grants: [grant('OWN_DEPARTMENTS', permissions, { departmentIds: departments })],
  };
}

function process(
  access: readonly ProcessAccessRow[],
  options: { participants?: readonly ProcessParticipantRow[]; historical?: boolean } = {},
): ProcessAccessTarget {
  const grants = accessGrantsOf(
    { access, participants: options.participants ?? [] },
    options.historical ?? true,
    NOW,
  );
  return {
    processId: PROCESS_ID,
    organizationId: ORG,
    departmentIds: grants.departmentIds,
    userIds: grants.userIds,
    participations: grants.participations ?? [],
    participantDepartmentIds: grants.participantDepartmentIds ?? [],
  };
}

const dept = (departmentId: string, reason: string): ProcessAccessRow => ({
  principalType: 'DEPARTMENT',
  departmentId,
  userId: null,
  reason,
});
const user = (userId: string, reason: string): ProcessAccessRow => ({
  principalType: 'USER',
  departmentId: null,
  userId,
  reason,
});

/** Processo criado na unidade A (secretaria e setor solicitantes, etapa inicial em A). */
const CREATED_IN_A = [
  dept(SECRETARIA_A, 'REQUESTING'),
  dept(UNIT_A, 'REQUESTING'),
  dept(UNIT_A, 'CURRENT'),
  user(ANA, 'CREATOR'),
];

const VIEW_AND_EDIT: readonly PermissionCode[] = ['PROCESS_VIEW', 'DFD_UPDATE'];

describe('visibilidade de processos na decisão de autorização (permissions.md §5)', () => {
  const harness = new AuthorizationHarness();

  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('processo na unidade A × usuário lotado em B com OWN_DEPARTMENTS: 404, como o inexistente', async () => {
    const target = process(CREATED_IN_A);
    await expect(
      harness.decide(lotado(BETO, [UNIT_B], VIEW_AND_EDIT), route('PROCESS_VIEW'), target),
    ).resolves.toBe('PROCESS_NOT_FOUND');
    await expect(
      harness.decide(lotado(BETO, [UNIT_B], VIEW_AND_EDIT), route('PROCESS_VIEW'), null),
    ).resolves.toBe('PROCESS_NOT_FOUND');
    // Lotado em A (e na secretaria solicitante): vê e edita.
    await expect(
      harness.decide(lotado(CAIO, [UNIT_A], VIEW_AND_EDIT), route('DFD_UPDATE'), target),
    ).resolves.toBe('ALLOW');
    await expect(
      harness.decide(lotado(CAIO, [SECRETARIA_A], VIEW_AND_EDIT), route('PROCESS_VIEW'), target),
    ).resolves.toBe('ALLOW');
    // A criadora vê pela concessão USER/CREATOR mesmo lotada noutra unidade, mas a permissão de
    // perfil com escopo de unidade não cobre o processo: 403, não 404.
    await expect(
      harness.decide(lotado(ANA, [UNIT_B], VIEW_AND_EDIT), route('DFD_UPDATE'), target),
    ).resolves.toBe('PERMISSION_DENIED');
  });

  it('histórico de tramitação: a unidade por onde passou segue vendo só com access.historicalDepartmentsCanView', async () => {
    // Tramitado de A para C: CURRENT de A virou HISTORICAL.
    const moved = [
      dept(SECRETARIA_A, 'REQUESTING'),
      dept(UNIT_A, 'HISTORICAL'),
      dept(UNIT_C, 'CURRENT'),
      user(ANA, 'CREATOR'),
    ];
    const fromA = lotado(CAIO, [UNIT_A], VIEW_AND_EDIT);
    await expect(
      harness.decide(fromA, route('PROCESS_VIEW'), process(moved, { historical: true })),
    ).resolves.toBe('ALLOW');
    await expect(
      harness.decide(fromA, route('PROCESS_VIEW'), process(moved, { historical: false })),
    ).resolves.toBe('PROCESS_NOT_FOUND');
    // A unidade atual (C) vê com ou sem a configuração.
    await expect(
      harness.decide(
        lotado(DORA, [UNIT_C], VIEW_AND_EDIT),
        route('DFD_UPDATE'),
        process(moved, { historical: false }),
      ),
    ).resolves.toBe('ALLOW');
  });

  it('participação vencida (RN-PROC-135): o consultor perde visibilidade e permissões antes do job', async () => {
    const consultant = (expiresAt: Date): ProcessAccessTarget =>
      process([...CREATED_IN_A, user(DORA, 'PARTICIPANT')], {
        participants: [
          { id: 'pp-1', userId: DORA, departmentId: null, role: 'CONSULTANT', expiresAt },
        ],
      });
    // Externa, sem perfil nenhum: tudo vem da participação (§4).
    const dora: Viewer = { userId: DORA, ownDepartmentIds: [], grants: [] };
    const valid = consultant(new Date(NOW.getTime() + 60_000));
    await expect(harness.decide(dora, route('PROCESS_VIEW'), valid)).resolves.toBe('ALLOW');
    await expect(harness.decide(dora, route('DFD_UPDATE'), valid)).resolves.toBe('ALLOW');
    // Participante nunca encaminha nem decide (§4): visível, 403.
    await expect(harness.decide(dora, route('PROCESS_FORWARD'), valid)).resolves.toBe(
      'PERMISSION_DENIED',
    );
    const expired = consultant(NOW);
    await expect(harness.decide(dora, route('PROCESS_VIEW'), expired)).resolves.toBe(
      'PROCESS_NOT_FOUND',
    );
    await expect(harness.decide(dora, route('DFD_UPDATE'), expired)).resolves.toBe(
      'PROCESS_NOT_FOUND',
    );
  });

  it('participação vencida não tira a concessão USER de outro motivo (a criadora segue vendo)', async () => {
    const target = process([...CREATED_IN_A, user(ANA, 'PARTICIPANT')], {
      participants: [
        { id: 'pp-2', userId: ANA, departmentId: null, role: 'COLLABORATOR', expiresAt: NOW },
      ],
    });
    const ana: Viewer = { userId: ANA, ownDepartmentIds: [UNIT_B], grants: [] };
    // Visível (não 404); o §7 manda ALLOW — hoje 403 (DIV-AUTHZ-01).
    await expect(harness.decide(ana, route('PROCESS_VIEW'), target)).resolves.toBe(
      OWN_GRANT_PROCESS_VIEW.current,
    );
    await expect(harness.decide(ana, route('DFD_UPDATE'), target)).resolves.toBe(
      'PERMISSION_DENIED',
    );
  });

  it('aprovador designado: a concessão USER/APPROVER dá visibilidade fora das lotações', async () => {
    const authority = lotado(BETO, [UNIT_B], ['PROCESS_VIEW', 'APPROVAL_VIEW', 'APPROVAL_DECIDE']);
    await expect(
      harness.decide(authority, route('APPROVAL_VIEW'), process(CREATED_IN_A)),
    ).resolves.toBe('PROCESS_NOT_FOUND');
    const requested = process([...CREATED_IN_A, user(BETO, 'APPROVER')]);
    // Visível pela concessão (não 404); o §7 manda ALLOW — hoje 403 (DIV-AUTHZ-01).
    await expect(harness.decide(authority, route('PROCESS_VIEW'), requested)).resolves.toBe(
      OWN_GRANT_PROCESS_VIEW.current,
    );
    // A competência para decidir é a POL-03 (escopo sobre a unidade solicitante — DEC-022), não o
    // escopo da rota: com escopo de unidade fora do processo, a permissão de perfil não o cobre.
    await expect(harness.decide(authority, route('APPROVAL_DECIDE'), requested)).resolves.toBe(
      'PERMISSION_DENIED',
    );
  });

  it('unidade participante (RN-PROC-131): só visibilidade; as permissões vêm do papel, não do escopo', async () => {
    const observer = process([...CREATED_IN_A, dept(UNIT_B, 'PARTICIPANT')], {
      participants: [
        { id: 'pp-3', userId: null, departmentId: UNIT_B, role: 'OBSERVER', expiresAt: null },
      ],
    });
    const beto = lotado(BETO, [UNIT_B], VIEW_AND_EDIT);
    await expect(harness.decide(beto, route('PROCESS_VIEW'), observer)).resolves.toBe('ALLOW');
    await expect(harness.decide(beto, route('DFD_UPDATE'), observer)).resolves.toBe(
      'PERMISSION_DENIED',
    );
    const collaborator = process([...CREATED_IN_A, dept(UNIT_B, 'PARTICIPANT')], {
      participants: [
        { id: 'pp-4', userId: null, departmentId: UNIT_B, role: 'COLLABORATOR', expiresAt: null },
      ],
    });
    await expect(harness.decide(beto, route('DFD_UPDATE'), collaborator)).resolves.toBe('ALLOW');
  });
});
