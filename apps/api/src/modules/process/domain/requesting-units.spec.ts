import { describe, expect, it } from 'vitest';

import { isInSubtree, isSecretariatOption, requestingUnitIssues } from './requesting-units.js';
import type { RequestingUnit } from './requesting-units.js';

const ORG = '0192f000-0000-7000-8000-0000000000b1';
const OTHER_ORG = '0192f000-0000-7000-8000-0000000000b2';
const OBRAS = '0192f000-0000-7000-8000-0000000000d1';
const MANUTENCAO = '0192f000-0000-7000-8000-0000000000d2';
const SAUDE = '0192f000-0000-7000-8000-0000000000d3';
const POSTO = '0192f000-0000-7000-8000-0000000000d4';
const DIVISAO = '0192f000-0000-7000-8000-0000000000d5';

function unit(
  id: string,
  parent: RequestingUnit | null,
  overrides: Partial<RequestingUnit> = {},
): RequestingUnit {
  return {
    id,
    organizationId: ORG,
    parentId: parent?.id ?? null,
    type: parent === null ? 'SECRETARIAT' : 'SECTOR',
    path: `${parent?.path ?? '/'}${id}/`,
    isActive: true,
    ...overrides,
  };
}

const obras = unit(OBRAS, null);
const manutencao = unit(MANUTENCAO, obras);
const saude = unit(SAUDE, null);
const posto = unit(POSTO, saude);

describe('Secretaria e setor solicitantes (US-001 · RN-PROC-02)', () => {
  it('opções de secretaria: SECRETARIAT/BOARD ou raiz do órgão', () => {
    expect(isSecretariatOption(obras)).toBe(true);
    expect(isSecretariatOption({ type: 'BOARD', parentId: OBRAS })).toBe(true);
    expect(isSecretariatOption({ type: 'DEPARTMENT', parentId: null })).toBe(true);
    expect(isSecretariatOption(manutencao)).toBe(false);
  });

  it('setor = a própria secretaria ou unidade da subárvore (caminho prefixado)', () => {
    expect(isInSubtree(obras, obras)).toBe(true);
    expect(isInSubtree(obras, manutencao)).toBe(true);
    expect(isInSubtree(obras, posto)).toBe(false);
  });

  it('[Sucesso] Secretaria de Obras + Setor de Manutenção', () => {
    expect(
      requestingUnitIssues({ organizationId: ORG, secretariat: obras, department: manutencao }),
    ).toEqual([]);
  });

  it('[Validação] setor da Secretaria de Saúde → DEPARTMENT_NOT_IN_SECRETARIAT', () => {
    expect(
      requestingUnitIssues({ organizationId: ORG, secretariat: obras, department: posto }),
    ).toEqual([
      {
        field: 'requestingDepartmentId',
        code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
        message: 'O setor deve pertencer à secretaria selecionada.',
      },
    ]);
  });

  it('[Tenant incorreto] unidade inexistente no tenant ou de outro órgão → REFERENCE_NOT_FOUND', () => {
    expect(
      requestingUnitIssues({ organizationId: ORG, secretariat: obras, department: undefined }),
    ).toEqual([
      {
        field: 'requestingDepartmentId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma unidade válida.',
      },
    ]);
    expect(
      requestingUnitIssues({
        organizationId: ORG,
        secretariat: { ...obras, organizationId: OTHER_ORG },
        department: manutencao,
      }).map((issue) => [issue.field, issue.code]),
    ).toEqual([['requestingSecretariatId', 'REFERENCE_NOT_FOUND']]);
  });

  it('[Validação] unidade inativa → REFERENCE_INACTIVE; setor como secretaria → NOT_ALLOWED', () => {
    expect(
      requestingUnitIssues({
        organizationId: ORG,
        secretariat: obras,
        department: { ...manutencao, isActive: false },
      }).map((issue) => issue.code),
    ).toEqual(['REFERENCE_INACTIVE']);
    const divisao = unit(DIVISAO, manutencao);
    expect(
      requestingUnitIssues({ organizationId: ORG, secretariat: manutencao, department: divisao }),
    ).toEqual([
      {
        field: 'requestingSecretariatId',
        code: 'NOT_ALLOWED',
        message: 'Selecione uma secretaria válida.',
      },
    ]);
  });
});
