import { describe, expect, it } from 'vitest';

import {
  approverCandidateIds,
  approverConfigOfPolicy,
  approverDepartmentId,
  ApproverUnresolvedError,
  documentApprovalTitle,
  resolveApprover,
  stageApprovalTitle,
} from './approval.js';
import type { ApproverConfig, ApproverDepartment, ApproverFacts } from './approval.js';

/*
 * US-051 — resolução do aprovador (RN-TRAM-47/48/49 · DEC-022), a mesma para a etapa `APPROVAL`
 * (US-047) e para a submissão avulsa pela `DocumentType.approvalPolicy` (US-065).
 */

const PROCESS = {
  organizationId: '0192f051-0000-7000-8000-0000000000c0',
  requestingSecretariatId: '0192f051-0000-7000-8000-0000000000c1',
  requestingDepartmentId: '0192f051-0000-7000-8000-0000000000c2',
};
const USER = '0192f051-0000-7000-8000-0000000000a1';
const ROLE = '0192f051-0000-7000-8000-0000000000a2';
const HEAD = '0192f051-0000-7000-8000-0000000000a9';
const HOLDER = '0192f051-0000-7000-8000-0000000000aa';
const FIXED = '0192f051-0000-7000-8000-0000000000c3';

const config = (overrides: Partial<ApproverConfig>): ApproverConfig => ({
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: null,
  approverRoleId: null,
  approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
  approverFixedDepartmentId: null,
  ...overrides,
});
const unit = (overrides: Partial<ApproverDepartment> = {}): ApproverDepartment => ({
  id: PROCESS.requestingSecretariatId,
  isActive: true,
  headUserId: HEAD,
  ...overrides,
});
const facts = (overrides: Partial<ApproverFacts> = {}): ApproverFacts => ({
  department: null,
  activeMemberIds: new Set([USER, HEAD]),
  roleHolderIds: [HOLDER],
  ...overrides,
});
const reasonOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ApproverUnresolvedError) return error.reason;
    throw error;
  }
};

describe('resolveApprover (RN-TRAM-47/48)', () => {
  it('DEPARTMENT_HEAD: a unidade e o titular atual com vínculo ativo, com substituto', () => {
    expect(resolveApprover(config({}), facts({ department: unit() }))).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: HEAD,
      approverRoleId: null,
      approverDepartmentId: PROCESS.requestingSecretariatId,
      allowDeputy: true,
    });
  });

  it('USER: o usuário configurado com vínculo ativo, sem substituto', () => {
    expect(
      resolveApprover(config({ approverType: 'USER', approverUserId: USER }), facts()),
    ).toEqual({
      approverType: 'USER',
      approverUserId: USER,
      approverRoleId: null,
      approverDepartmentId: null,
      allowDeputy: false,
    });
  });

  it('ROLE: grava só o perfil (nenhuma pessoa é escolhida), sem substituto', () => {
    expect(
      resolveApprover(config({ approverType: 'ROLE', approverRoleId: ROLE }), facts()),
    ).toEqual({
      approverType: 'ROLE',
      approverUserId: null,
      approverRoleId: ROLE,
      approverDepartmentId: null,
      allowDeputy: false,
    });
  });
});

describe('resolveApprover — APPROVER_UNRESOLVED (RN-TRAM-49)', () => {
  it.each([
    [
      'unidade sem titular',
      config({}),
      facts({ department: unit({ headUserId: null }) }),
      'NO_HEAD',
    ],
    [
      'titular sem vínculo ativo no tenant (inclusive de outro tenant)',
      config({}),
      facts({ department: unit(), activeMemberIds: new Set() }),
      'HEAD_NOT_ACTIVE',
    ],
    [
      'unidade inativa',
      config({}),
      facts({ department: unit({ isActive: false }) }),
      'DEPARTMENT_UNAVAILABLE',
    ],
    ['unidade inexistente no tenant', config({}), facts(), 'DEPARTMENT_UNAVAILABLE'],
    [
      'unidade não configurada',
      config({ approverDepartmentResolution: null }),
      facts(),
      'NOT_CONFIGURED',
    ],
    [
      'perfil sem detentor no escopo',
      config({ approverType: 'ROLE', approverRoleId: ROLE }),
      facts({ roleHolderIds: [] }),
      'ROLE_SCOPE_EMPTY',
    ],
    [
      'usuário sem vínculo ativo',
      config({ approverType: 'USER', approverUserId: USER }),
      facts({ activeMemberIds: new Set() }),
      'USER_NOT_ACTIVE',
    ],
    ['USER sem pessoa', config({ approverType: 'USER' }), facts(), 'NOT_CONFIGURED'],
    ['ROLE sem perfil', config({ approverType: 'ROLE' }), facts(), 'NOT_CONFIGURED'],
    ['sem aprovador', config({ approverType: null }), facts(), 'NOT_CONFIGURED'],
  ] as const)('%s', (_case, approver, read, reason) => {
    expect(reasonOf(() => resolveApprover(approver, read))).toBe(reason);
  });
});

describe('approverDepartmentId e approverCandidateIds', () => {
  it('a unidade do titular pela resolução; nenhuma para USER/ROLE', () => {
    expect(approverDepartmentId(config({}), PROCESS)).toBe(PROCESS.requestingSecretariatId);
    expect(
      approverDepartmentId(
        config({ approverDepartmentResolution: 'REQUESTING_DEPARTMENT' }),
        PROCESS,
      ),
    ).toBe(PROCESS.requestingDepartmentId);
    expect(
      approverDepartmentId(
        config({ approverDepartmentResolution: 'FIXED', approverFixedDepartmentId: FIXED }),
        PROCESS,
      ),
    ).toBe(FIXED);
    expect(
      approverDepartmentId(config({ approverDepartmentResolution: null }), PROCESS),
    ).toBeNull();
    expect(approverDepartmentId(config({ approverType: 'ROLE' }), PROCESS)).toBeNull();
  });

  it('quem precisa de vínculo conferido: o USER ou o titular', () => {
    expect(
      approverCandidateIds(config({ approverType: 'USER', approverUserId: USER }), null),
    ).toEqual([USER]);
    expect(approverCandidateIds(config({}), unit())).toEqual([HEAD]);
    expect(approverCandidateIds(config({}), unit({ headUserId: null }))).toEqual([]);
    expect(
      approverCandidateIds(config({ approverType: 'ROLE', approverRoleId: ROLE }), null),
    ).toEqual([]);
  });
});

describe('approverConfigOfPolicy (submissão avulsa — entities.md §5.7)', () => {
  it('campos ausentes da política viram null', () => {
    expect(
      approverConfigOfPolicy({ approverType: 'USER', approverUserId: USER, allowDeputy: false }),
    ).toEqual({
      approverType: 'USER',
      approverUserId: USER,
      approverRoleId: null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
    });
    expect(
      approverConfigOfPolicy({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: FIXED,
        allowDeputy: false,
      }),
    ).toMatchObject({ approverDepartmentResolution: 'FIXED', approverFixedDepartmentId: FIXED });
  });

  it('RN-TRAM-48 vale também na avulsa: titular sempre com substituto, mesmo com allowDeputy=false', () => {
    const policy = approverConfigOfPolicy({
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
      allowDeputy: false,
    });
    const department = unit({ id: PROCESS.requestingDepartmentId });
    expect(approverDepartmentId(policy, PROCESS)).toBe(PROCESS.requestingDepartmentId);
    expect(resolveApprover(policy, facts({ department }))).toMatchObject({
      approverUserId: HEAD,
      approverDepartmentId: PROCESS.requestingDepartmentId,
      allowDeputy: true,
    });
  });
});

describe('títulos (RN-TRAM-52)', () => {
  it('"Aprovação de {etapa} — {código}" até 200 caracteres', () => {
    expect(stageApprovalTitle('Aprovação da demanda', 'DFD 0001/2026')).toBe(
      'Aprovação de Aprovação da demanda — DFD 0001/2026',
    );
    expect(stageApprovalTitle('Aprovação da demanda', null)).toBe(
      'Aprovação de Aprovação da demanda',
    );
    expect(stageApprovalTitle('x'.repeat(300), null)).toHaveLength(200);
  });

  it('"Aprovação avulsa — {tipo} {código}" ou, sem número, com o título; até 200 caracteres', () => {
    expect(documentApprovalTitle('Despacho sigiloso', 'DSP 0003/2026', 'x')).toBe(
      'Aprovação avulsa — Despacho sigiloso DSP 0003/2026',
    );
    expect(documentApprovalTitle('Despacho', null, 'Ofício ao TCE')).toBe(
      'Aprovação avulsa — Despacho "Ofício ao TCE"',
    );
    const long = documentApprovalTitle('Despacho', null, 'x'.repeat(300));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
