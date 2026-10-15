import { describe, expect, it } from 'vitest';

import { positionUnder } from './department-tree.js';
import {
  DepartmentFieldNotAllowedError,
  HeadEqualsDeputyError,
  createDepartment,
  isSecretariat,
  moveDepartment,
  setDepartmentActive,
  updateDepartment,
} from './department.js';
import type { Department } from './department.js';

const TENANT = '0192a000-0000-7000-8000-00000000000a';
const ORG = '0192a000-0000-7000-8000-0000000100a1';
const SEC = '0192a000-0000-7000-8000-0000000200a1';
const SETOR = '0192a000-0000-7000-8000-0000000200a2';
const HEAD = '0192a000-0000-7000-8000-0000000000a4';
const DEPUTY = '0192a000-0000-7000-8000-0000000000a5';
const T0 = new Date('2026-10-15T12:00:00.000Z');
const T1 = new Date('2026-10-15T13:00:00.000Z');

function secretaria(overrides: Partial<Department> = {}): Department {
  return {
    ...createDepartment(
      { organizationId: ORG, type: 'SECRETARIAT', name: 'Secretaria de Obras', acronym: 'SOB' },
      { id: SEC, tenantId: TENANT, parent: null, now: T0, userId: HEAD },
    ),
    ...overrides,
  };
}

describe('Department (US-102 · RN-TEN-44..51)', () => {
  it('create: raiz ativa com depth 0, campos opcionais nulos e versão 1', () => {
    const department = secretaria();
    expect(department).toMatchObject({
      id: SEC,
      tenantId: TENANT,
      organizationId: ORG,
      parentId: null,
      path: `/${SEC}/`,
      depth: 0,
      isActive: true,
      sortOrder: 0,
      acronym: 'SOB',
      code: null,
      email: null,
      headUserId: null,
      deputyUserId: null,
      createdById: HEAD,
      version: 1,
    });
  });

  it('create: sob o pai herda o caminho; titular e substituto iguais → erro', () => {
    const parent = secretaria();
    const setor = createDepartment(
      {
        organizationId: ORG,
        type: 'SECTOR',
        name: 'Setor de Compras',
        headUserId: HEAD,
        deputyUserId: DEPUTY,
        sortOrder: 2,
      },
      { id: SETOR, tenantId: TENANT, parent, now: T0, userId: null },
    );
    expect(setor).toMatchObject({
      parentId: SEC,
      path: `/${SEC}/${SETOR}/`,
      depth: 1,
      headUserId: HEAD,
      deputyUserId: DEPUTY,
      sortOrder: 2,
    });
    expect(() =>
      createDepartment(
        {
          organizationId: ORG,
          type: 'SECTOR',
          name: 'Setor',
          headUserId: HEAD,
          deputyUserId: HEAD,
        },
        { id: SETOR, tenantId: TENANT, parent, now: T0, userId: null },
      ),
    ).toThrow(HeadEqualsDeputyError);
  });

  it('isSecretariat (RN-TEN-49): tipo SECRETARIAT/BOARD ou raiz', () => {
    expect(isSecretariat({ type: 'SECTOR', depth: 0 })).toBe(true);
    expect(isSecretariat({ type: 'BOARD', depth: 2 })).toBe(true);
    expect(isSecretariat({ type: 'SECRETARIAT', depth: 1 })).toBe(true);
    expect(isSecretariat({ type: 'SECTOR', depth: 1 })).toBe(false);
  });

  it('update: só o que veio e mudou, com anterior/novo e titular a validar', () => {
    const current = secretaria();
    const result = updateDepartment(
      current,
      { name: 'Secretaria de Obras Públicas', acronym: 'SOB', headUserId: HEAD, code: null },
      { now: T1, userId: DEPUTY },
    );
    expect(result.changedFields).toEqual(['name', 'headUserId']);
    expect(result.changes).toEqual([
      { path: 'name', old: 'Secretaria de Obras', new: 'Secretaria de Obras Públicas' },
      { path: 'headUserId', old: null, new: HEAD },
    ]);
    expect(result.staffToValidate).toEqual(['headUserId']);
    expect(result.next).toMatchObject({ updatedAt: T1, updatedById: DEPUTY, version: 1 });
  });

  it('update: nada mudou → sem campos e sem nova data; limpar titular não exige validação', () => {
    const current = secretaria({ headUserId: HEAD });
    const same = updateDepartment(current, { name: current.name }, { now: T1, userId: null });
    expect(same.changedFields).toEqual([]);
    expect(same.next.updatedAt).toEqual(T0);
    const cleared = updateDepartment(current, { headUserId: null }, { now: T1, userId: null });
    expect(cleared.changedFields).toEqual(['headUserId']);
    expect(cleared.staffToValidate).toEqual([]);
  });

  it('update: titular = substituto resultante → erro; órgão e pai diferentes → não permitido', () => {
    const current = secretaria({ headUserId: HEAD });
    expect(() =>
      updateDepartment(current, { deputyUserId: HEAD }, { now: T1, userId: null }),
    ).toThrow(HeadEqualsDeputyError);
    expect(() =>
      updateDepartment(current, { organizationId: SETOR }, { now: T1, userId: null }),
    ).toThrow(DepartmentFieldNotAllowedError);
    expect(() => updateDepartment(current, { parentId: SETOR }, { now: T1, userId: null })).toThrow(
      DepartmentFieldNotAllowedError,
    );
    // Iguais aos atuais são aceitos (o formulário reenvia tudo).
    expect(
      updateDepartment(current, { organizationId: ORG, parentId: null }, { now: T1, userId: null })
        .changedFields,
    ).toEqual([]);
  });

  it('setActive (RN-TEN-50): troca a situação; já na situação → null', () => {
    const current = secretaria();
    expect(setDepartmentActive(current, true, { now: T1, userId: null })).toBeNull();
    expect(setDepartmentActive(current, false, { now: T1, userId: HEAD })).toMatchObject({
      isActive: false,
      updatedAt: T1,
      updatedById: HEAD,
    });
  });

  it('move: novo pai e posição recalculada; para a raiz volta a depth 0', () => {
    const setor = createDepartment(
      { organizationId: ORG, type: 'SECTOR', name: 'Setor de Compras' },
      { id: SETOR, tenantId: TENANT, parent: secretaria(), now: T0, userId: null },
    );
    const asRoot = moveDepartment(setor, null, { now: T1, userId: HEAD });
    expect(asRoot).toMatchObject({ parentId: null, path: `/${SETOR}/`, depth: 0, updatedAt: T1 });
    const back = moveDepartment(
      asRoot,
      { id: SEC, ...positionUnder(SEC, null) },
      {
        now: T1,
        userId: HEAD,
      },
    );
    expect(back).toMatchObject({ parentId: SEC, path: `/${SEC}/${SETOR}/`, depth: 1 });
  });
});
