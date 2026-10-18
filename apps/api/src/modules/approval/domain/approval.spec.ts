import { describe, expect, it } from 'vitest';

import {
  ApproverUnresolvedError,
  documentApprovalTitle,
  resolveDocumentApprover,
  resolveStageApprover,
  stageApprovalTitle,
  stageApproverDepartmentId,
} from './approval.js';
import type { StageApproverConfig } from './approval.js';

/* US-065 — aprovador da submissão avulsa pela `DocumentType.approvalPolicy` (entities.md §5.7). */

const PROCESS = {
  requestingSecretariatId: '0192f065-0000-7000-8000-0000000000c1',
  requestingDepartmentId: '0192f065-0000-7000-8000-0000000000c2',
};
const USER = '0192f065-0000-7000-8000-0000000000a1';
const ROLE = '0192f065-0000-7000-8000-0000000000a2';
const FIXED = '0192f065-0000-7000-8000-0000000000c3';

describe('resolveDocumentApprover', () => {
  it('USER e ROLE são registrados diretamente', () => {
    expect(
      resolveDocumentApprover(
        { approverType: 'USER', approverUserId: USER, allowDeputy: false },
        PROCESS,
      ),
    ).toEqual({
      approverType: 'USER',
      approverUserId: USER,
      approverRoleId: null,
      approverDepartmentId: null,
      allowDeputy: false,
    });
    expect(
      resolveDocumentApprover(
        { approverType: 'ROLE', approverRoleId: ROLE, allowDeputy: true },
        PROCESS,
      ),
    ).toMatchObject({ approverRoleId: ROLE, approverUserId: null, allowDeputy: true });
  });

  it.each([
    ['FIXED', FIXED],
    ['REQUESTING_SECRETARIAT', PROCESS.requestingSecretariatId],
    ['REQUESTING_DEPARTMENT', PROCESS.requestingDepartmentId],
  ] as const)('DEPARTMENT_HEAD com resolução %s registra a unidade', (resolution, expected) => {
    expect(
      resolveDocumentApprover(
        {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: resolution,
          approverFixedDepartmentId: FIXED,
          allowDeputy: true,
        },
        PROCESS,
      ),
    ).toMatchObject({ approverType: 'DEPARTMENT_HEAD', approverDepartmentId: expected });
  });

  it('política incompleta → ApproverUnresolvedError', () => {
    expect(() =>
      resolveDocumentApprover({ approverType: 'USER', allowDeputy: false }, PROCESS),
    ).toThrow(ApproverUnresolvedError);
    expect(() =>
      resolveDocumentApprover({ approverType: 'ROLE', allowDeputy: false }, PROCESS),
    ).toThrow(ApproverUnresolvedError);
    expect(() =>
      resolveDocumentApprover({ approverType: 'DEPARTMENT_HEAD', allowDeputy: false }, PROCESS),
    ).toThrow(ApproverUnresolvedError);
    expect(() =>
      resolveDocumentApprover(
        {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'FIXED',
          allowDeputy: false,
        },
        PROCESS,
      ),
    ).toThrow(ApproverUnresolvedError);
  });
});

describe('documentApprovalTitle (RN-TRAM-52)', () => {
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

/* US-047 → US-051 — aprovador da etapa `APPROVAL` (RN-TRAM-47/48/49 · DEC-022). */
describe('resolveStageApprover', () => {
  const HEAD = '0192f065-0000-7000-8000-0000000000a9';
  const config = (overrides: Partial<StageApproverConfig>): StageApproverConfig => ({
    approverType: 'DEPARTMENT_HEAD',
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    approverFixedDepartmentId: null,
    ...overrides,
  });

  it('DEPARTMENT_HEAD: unidade pela resolução e o titular atual, com substituto (RN-TRAM-48)', () => {
    const head = config({});
    expect(stageApproverDepartmentId(head, PROCESS)).toBe(PROCESS.requestingSecretariatId);
    expect(
      stageApproverDepartmentId(
        config({ approverDepartmentResolution: 'REQUESTING_DEPARTMENT' }),
        PROCESS,
      ),
    ).toBe(PROCESS.requestingDepartmentId);
    expect(
      stageApproverDepartmentId(
        config({ approverDepartmentResolution: 'FIXED', approverFixedDepartmentId: FIXED }),
        PROCESS,
      ),
    ).toBe(FIXED);
    expect(
      resolveStageApprover(head, {
        id: PROCESS.requestingSecretariatId,
        isActive: true,
        headUserId: HEAD,
      }),
    ).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: HEAD,
      approverRoleId: null,
      approverDepartmentId: PROCESS.requestingSecretariatId,
      allowDeputy: true,
    });
  });

  it('USER e ROLE diretos, sem substituto', () => {
    expect(
      resolveStageApprover(config({ approverType: 'USER', approverUserId: USER }), null),
    ).toEqual({
      approverType: 'USER',
      approverUserId: USER,
      approverRoleId: null,
      approverDepartmentId: null,
      allowDeputy: false,
    });
    expect(
      resolveStageApprover(config({ approverType: 'ROLE', approverRoleId: ROLE }), null),
    ).toMatchObject({ approverType: 'ROLE', approverRoleId: ROLE, allowDeputy: false });
    expect(stageApproverDepartmentId(config({ approverType: 'ROLE' }), PROCESS)).toBeNull();
  });

  it.each([
    ['unidade sem titular', config({}), { id: FIXED, isActive: true, headUserId: null }],
    ['unidade inativa', config({}), { id: FIXED, isActive: false, headUserId: HEAD }],
    ['unidade não resolvida', config({ approverDepartmentResolution: null }), null],
    ['USER sem pessoa', config({ approverType: 'USER' }), null],
    ['ROLE sem perfil', config({ approverType: 'ROLE' }), null],
    ['etapa sem aprovador', config({ approverType: null }), null],
  ])('APPROVER_UNRESOLVED: %s', (_case, stage, department) => {
    expect(() => resolveStageApprover(stage, department)).toThrow(ApproverUnresolvedError);
  });

  it('título "Aprovação de {etapa} — {código}" até 200 caracteres (RN-TRAM-52)', () => {
    expect(stageApprovalTitle('Aprovação da demanda', 'DFD 0001/2026')).toBe(
      'Aprovação de Aprovação da demanda — DFD 0001/2026',
    );
    expect(stageApprovalTitle('Aprovação da demanda', null)).toBe(
      'Aprovação de Aprovação da demanda',
    );
    expect(stageApprovalTitle('x'.repeat(300), null)).toHaveLength(200);
  });
});
