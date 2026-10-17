import { describe, expect, it } from 'vitest';

import {
  ApproverUnresolvedError,
  documentApprovalTitle,
  resolveDocumentApprover,
} from './approval.js';

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
