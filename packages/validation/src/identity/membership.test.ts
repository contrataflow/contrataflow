import { describe, expect, it } from 'vitest';

import {
  isMembershipExpired,
  membershipReasonSchema,
  membershipValidityMessage,
  updateMembershipDepartmentsSchema,
  updateMembershipSchema,
} from './membership.js';

const D1 = '0192a000-0000-7000-8000-000000000d01';
const D2 = '0192a000-0000-7000-8000-000000000d02';

function issueCodes(result: { success: boolean; error?: { issues: readonly unknown[] } }) {
  return (result.error?.issues ?? []).map((issue) => {
    const { path, params } = issue as { path: PropertyKey[]; params?: { code?: string } };
    return `${path.join('.')}:${params?.code ?? ''}`;
  });
}

describe('Gestão de vínculos — schemas (US-092)', () => {
  it('USR-08: limites de cargo e matrícula; vazio e null limpam', () => {
    expect(
      updateMembershipSchema.parse({ jobTitle: '  Coordenador ', registrationNumber: null }),
    ).toEqual({ jobTitle: 'Coordenador', registrationNumber: null });
    const tooLong = updateMembershipSchema.safeParse({
      jobTitle: 'x'.repeat(151),
      registrationNumber: 'x'.repeat(41),
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues.map((issue) => issue.message)).toEqual([
      'O cargo deve ter no máximo 150 caracteres.',
      'A matrícula deve ter no máximo 40 caracteres.',
    ]);
    expect(updateMembershipSchema.safeParse({ type: 'EXTERNAL' }).success).toBe(false);
  });

  it('USR-09: ≥ 1 unidade (REQUIRED), sem repetição e a principal entre elas (INVALID_ENUM)', () => {
    expect(
      updateMembershipDepartmentsSchema.parse({ departmentIds: [D1, D2], primaryDepartmentId: D2 }),
    ).toEqual({ departmentIds: [D1, D2], primaryDepartmentId: D2 });
    expect(
      issueCodes(
        updateMembershipDepartmentsSchema.safeParse({ departmentIds: [], primaryDepartmentId: D1 }),
      ),
    ).toEqual(['departmentIds:REQUIRED']);
    expect(
      issueCodes(
        updateMembershipDepartmentsSchema.safeParse({
          departmentIds: [D1, D1],
          primaryDepartmentId: D2,
        }),
      ),
    ).toEqual(['departmentIds:DUPLICATE_IN_LIST', 'primaryDepartmentId:INVALID_ENUM']);
  });

  it('USR-10/12: motivo opcional até 500 caracteres', () => {
    expect(membershipReasonSchema.parse({})).toEqual({});
    expect(membershipReasonSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('mensagem de validade e "Expirado" (RN-IAM-64)', () => {
    expect(membershipValidityMessage(180)).toBe('Informe uma validade entre hoje e 180 dias.');
    const now = new Date('2026-10-15T12:00:00.000Z');
    const external = { type: 'EXTERNAL', status: 'ACTIVE', expiresAt: '2026-10-01T00:00:00.000Z' };
    expect(isMembershipExpired(external, now)).toBe(true);
    expect(isMembershipExpired({ ...external, expiresAt: '2026-12-01T00:00:00.000Z' }, now)).toBe(
      false,
    );
    expect(isMembershipExpired({ ...external, type: 'INTERNAL' }, now)).toBe(false);
    expect(isMembershipExpired({ ...external, status: 'REVOKED' }, now)).toBe(false);
    expect(isMembershipExpired({ ...external, status: 'EXPIRED', expiresAt: null }, now)).toBe(
      true,
    );
  });
});
