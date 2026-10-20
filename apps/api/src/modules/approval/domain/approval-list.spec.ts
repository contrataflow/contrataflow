import { describe, expect, it } from 'vitest';

import {
  compareApprovalRows,
  isApprovalOverdue,
  isDesignatedApprover,
  isInApprovalList,
  matchesCriteria,
  normalizeSearch,
} from './approval-list.js';
import type { ApprovalListCriteria, ApprovalListRow, ApproverCoverage } from './approval-list.js';

/* US-057 — cobertura POL-03 como filtro (RN-INBOX-14), filtros (RN-INBOX-15), atraso e ordenação. */

const T = '0192e057-0000-7000-8000-000000000001';
const BEATRIZ = '0192e057-0000-7000-8000-0000000000b1';
const OUTRA = '0192e057-0000-7000-8000-0000000000b2';
const ORG = '0192e057-0000-7000-8000-0000000000a0';
const OBRAS = '0192e057-0000-7000-8000-0000000000a1';
const SAUDE = '0192e057-0000-7000-8000-0000000000a2';
const SETOR = '0192e057-0000-7000-8000-0000000000a3';
const ROLE = '0192e057-0000-7000-8000-0000000000c1';
const id = (n: number) => `0192e057-0000-7000-8000-${String(n).padStart(12, '0')}`;

function row(
  patch: Partial<ApprovalListRow> = {},
  process: Partial<ApprovalListRow['process']> = {},
): ApprovalListRow {
  return {
    tenantId: T,
    id: id(1),
    processId: id(100),
    subjectType: 'PROCESS_STAGE',
    title: 'Aprovação do DFD',
    documentId: null,
    status: 'PENDING',
    requestedById: OUTRA,
    requestedAt: new Date('2026-10-10T15:00:00.000Z'),
    dueAt: null,
    approverType: 'DEPARTMENT_HEAD',
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentId: OBRAS,
    allowDeputy: false,
    decidedById: null,
    process: {
      code: '0001/2026',
      number: 1,
      year: 2026,
      title: 'Reforma da praça',
      organizationId: ORG,
      requestingSecretariatId: OBRAS,
      requestingDepartmentId: SETOR,
      isBudgetConfidential: false,
      ...process,
    },
    ...patch,
  };
}

const coverage = (patch: Partial<ApproverCoverage> = {}): ApproverCoverage => ({
  userId: BEATRIZ,
  headOf: [],
  deputyOf: [],
  roles: [],
  ...patch,
});

const role = (patch: Partial<ApproverCoverage['roles'][number]> = {}) => ({
  roleId: ROLE,
  tenantWide: false,
  organizationId: null,
  departmentIds: [],
  ...patch,
});

describe('isDesignatedApprover (POL-03)', () => {
  it('USER: só o próprio aprovador', () => {
    const direct = row({
      approverType: 'USER',
      approverUserId: BEATRIZ,
      approverDepartmentId: null,
    });
    expect(isDesignatedApprover(direct, coverage())).toBe(true);
    expect(isDesignatedApprover({ ...direct, approverUserId: OUTRA }, coverage())).toBe(false);
  });

  it('DEPARTMENT_HEAD: titular; substituto só com allowDeputy; outra secretaria nunca', () => {
    expect(isDesignatedApprover(row(), coverage({ headOf: [OBRAS] }))).toBe(true);
    expect(isDesignatedApprover(row(), coverage({ deputyOf: [OBRAS] }))).toBe(false);
    expect(isDesignatedApprover(row({ allowDeputy: true }), coverage({ deputyOf: [OBRAS] }))).toBe(
      true,
    );
    expect(
      isDesignatedApprover(row({ approverDepartmentId: SAUDE }), coverage({ headOf: [OBRAS] })),
    ).toBe(false);
    expect(
      isDesignatedApprover(row({ approverDepartmentId: null }), coverage({ headOf: [OBRAS] })),
    ).toBe(false);
  });

  it('ROLE: perfil com escopo do tenant, do órgão ou da secretaria/setor solicitante', () => {
    const byRole = row({ approverType: 'ROLE', approverRoleId: ROLE, approverDepartmentId: null });
    expect(isDesignatedApprover(byRole, coverage({ roles: [role({ tenantWide: true })] }))).toBe(
      true,
    );
    expect(isDesignatedApprover(byRole, coverage({ roles: [role({ organizationId: ORG })] }))).toBe(
      true,
    );
    expect(
      isDesignatedApprover(byRole, coverage({ roles: [role({ departmentIds: [OBRAS] })] })),
    ).toBe(true);
    expect(
      isDesignatedApprover(byRole, coverage({ roles: [role({ departmentIds: [SETOR] })] })),
    ).toBe(true);
    // Escopo sobre outra unidade, ou outro perfil: fora da cobertura.
    expect(
      isDesignatedApprover(byRole, coverage({ roles: [role({ departmentIds: [SAUDE] })] })),
    ).toBe(false);
    expect(
      isDesignatedApprover(
        byRole,
        coverage({ roles: [role({ roleId: id(9), tenantWide: true })] }),
      ),
    ).toBe(false);
    expect(isDesignatedApprover(byRole, coverage())).toBe(false);
  });
});

describe('isInApprovalList (RN-INBOX-14)', () => {
  it('designado agora ou quem decidiu (histórico mesmo após trocar a titularidade)', () => {
    expect(isInApprovalList(row(), coverage({ headOf: [OBRAS] }))).toBe(true);
    const decided = row({ status: 'APPROVED', decidedById: BEATRIZ });
    expect(isInApprovalList(decided, coverage())).toBe(true);
    expect(isInApprovalList({ ...decided, decidedById: OUTRA }, coverage())).toBe(false);
  });
});

describe('matchesCriteria (RN-INBOX-15)', () => {
  const criteria = (patch: Partial<ApprovalListCriteria> = {}): ApprovalListCriteria => ({
    statuses: ['PENDING'],
    subjectType: null,
    requestingDepartmentId: null,
    requestedFrom: null,
    requestedTo: null,
    q: null,
    timezone: 'America/Sao_Paulo',
    ...patch,
  });

  it('status (OU) e tipo de assunto', () => {
    expect(matchesCriteria(row(), criteria())).toBe(true);
    expect(matchesCriteria(row({ status: 'CANCELED' }), criteria())).toBe(false);
    expect(
      matchesCriteria(
        row({ status: 'RETURNED' }),
        criteria({ statuses: ['APPROVED', 'RETURNED'] }),
      ),
    ).toBe(true);
    expect(matchesCriteria(row(), criteria({ subjectType: 'DOCUMENT' }))).toBe(false);
  });

  it('unidade solicitante: secretaria OU setor', () => {
    expect(matchesCriteria(row(), criteria({ requestingDepartmentId: OBRAS }))).toBe(true);
    expect(matchesCriteria(row(), criteria({ requestingDepartmentId: SETOR }))).toBe(true);
    expect(matchesCriteria(row(), criteria({ requestingDepartmentId: SAUDE }))).toBe(false);
  });

  it('período em datas locais do tenant (inclusive nas duas pontas)', () => {
    // 2026-10-11T01:00Z = 10/10 22h em São Paulo.
    const late = row({ requestedAt: new Date('2026-10-11T01:00:00.000Z') });
    expect(
      matchesCriteria(late, criteria({ requestedFrom: '2026-10-10', requestedTo: '2026-10-10' })),
    ).toBe(true);
    expect(matchesCriteria(late, criteria({ requestedFrom: '2026-10-11' }))).toBe(false);
    expect(matchesCriteria(late, criteria({ requestedTo: '2026-10-09' }))).toBe(false);
  });

  it('busca por código ou título, sem acento nem caixa', () => {
    expect(matchesCriteria(row(), criteria({ q: 'PRACA' }))).toBe(true);
    expect(matchesCriteria(row(), criteria({ q: '0001' }))).toBe(true);
    expect(matchesCriteria(row(), criteria({ q: 'dfd' }))).toBe(true);
    expect(matchesCriteria(row(), criteria({ q: 'escola' }))).toBe(false);
    expect(normalizeSearch('Ação')).toBe('acao');
  });
});

describe('isApprovalOverdue (RN-INBOX-16) e ordenação (RN-INBOX-18)', () => {
  const now = new Date('2026-10-19T15:00:00.000Z');

  it('dueAt vencido enquanto pendente; sem prazo ou decidida, nunca', () => {
    expect(
      isApprovalOverdue({ status: 'PENDING', dueAt: new Date('2026-10-18T00:00:00Z') }, now),
    ).toBe(true);
    expect(
      isApprovalOverdue({ status: 'PENDING', dueAt: new Date('2026-10-20T00:00:00Z') }, now),
    ).toBe(false);
    expect(isApprovalOverdue({ status: 'PENDING', dueAt: null }, now)).toBe(false);
    expect(
      isApprovalOverdue({ status: 'APPROVED', dueAt: new Date('2026-10-18T00:00:00Z') }, now),
    ).toBe(false);
  });

  it('nulos por último nas duas direções; código por ano e número; desempate por id', () => {
    const a = row(
      { id: id(1), dueAt: new Date('2026-10-20T00:00:00Z') },
      { number: 2, year: 2026 },
    );
    const b = row({ id: id(2), dueAt: null }, { number: null, code: null });
    const c = row(
      { id: id(3), dueAt: new Date('2026-10-25T00:00:00Z') },
      { number: 1, year: 2026 },
    );
    const ids = (rows: ApprovalListRow[]) => rows.map((item) => item.id);
    expect(ids([a, b, c].sort(compareApprovalRows({ field: 'dueAt', direction: 'asc' })))).toEqual([
      id(1),
      id(3),
      id(2),
    ]);
    expect(ids([a, b, c].sort(compareApprovalRows({ field: 'dueAt', direction: 'desc' })))).toEqual(
      [id(3), id(1), id(2)],
    );
    expect(ids([a, b, c].sort(compareApprovalRows({ field: 'code', direction: 'asc' })))).toEqual([
      id(3),
      id(1),
      id(2),
    ]);
    expect(
      ids([a, b, c].sort(compareApprovalRows({ field: 'requestedAt', direction: 'desc' }))),
    ).toEqual([id(3), id(2), id(1)]);
  });
});
