import type { DocumentTypeDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  approverListProblems,
  draftsOf,
  hasProblems,
  lineIndexOf,
  linesBody,
  moveLine,
  newLineDraft,
  sameLines,
  withType,
} from './approver-lines-model';
import type { ApproverLineDraft } from './approver-lines-model';
import {
  buildPatch,
  EMPTY_VALUES,
  formFieldOf,
  initialValues,
  isEditablePolicy,
  policyOf,
} from '../document-types/document-type-form-model';

/*
 * US-132 — modelo do editor de aprovadores (SCR-034/SCR-108) e a política do tipo de documento:
 * corpo sem `sequence`, reordenação, regras locais (V-03/V-04/V-05, mínimo só no tipo), erros da API
 * por linha e o espelho da linha 1 na `approvalPolicy`.
 */

const MARCOS = '0192a000-0000-7000-8000-0000000000a1';
const PERFIL = '0192a000-0000-7000-8000-0000000000e1';

const user = (id = MARCOS, label = ''): ApproverLineDraft => ({
  ...withType(newLineDraft(), 'USER'),
  approverUserId: id,
  label,
});
const role = (): ApproverLineDraft => ({
  ...withType(newLineDraft(), 'ROLE'),
  approverRoleId: PERFIL,
});

describe('approver-lines-model (US-132)', () => {
  it('corpo: só as referências do tipo, sem sequence, rótulo vazio omitido', () => {
    const head = newLineDraft();
    expect(linesBody([user(MARCOS, ' Procurador-Geral '), head])).toEqual([
      {
        approverType: 'USER',
        approverUserId: MARCOS,
        allowDeputy: true,
        label: 'Procurador-Geral',
      },
      {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        allowDeputy: true,
      },
    ]);
    // Trocar o tipo limpa as referências antigas.
    expect(withType(user(), 'ROLE')).toMatchObject({ approverUserId: '', approverRoleId: '' });
  });

  it('ida e volta com as linhas gravadas', () => {
    const drafts = draftsOf([
      {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: PERFIL,
        label: 'Secretário',
      },
    ]);
    expect(linesBody(drafts)).toEqual([
      {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: PERFIL,
        allowDeputy: true,
        label: 'Secretário',
      },
    ]);
    expect(sameLines(drafts, draftsOf([...linesBody(drafts)]))).toBe(true);
  });

  it('Subir/Descer: move dentro dos limites', () => {
    const [a, b, c] = [user(), role(), newLineDraft()];
    expect(moveLine([a, b, c], 0, 1).map((line) => line.key)).toEqual([b.key, a.key, c.key]);
    expect(moveLine([a, b, c], 0, -1).map((line) => line.key)).toEqual([a.key, b.key, c.key]);
    expect(moveLine([a, b, c], 2, 1).map((line) => line.key)).toEqual([a.key, b.key, c.key]);
  });

  it('regras locais: referência, repetição, 20 linhas e mínimo só quando exigido', () => {
    const missing = withType(newLineDraft(), 'ROLE');
    const repeated = user();
    const found = approverListProblems('ALL', [user(), missing, repeated], {
      requireMinimum: true,
    });
    expect(found.lines[missing.key]).toEqual({
      field: 'approverRoleId',
      code: 'REQUIRED',
      line: 2,
    });
    expect(found.lines[repeated.key]).toMatchObject({ code: 'DUPLICATE', line: 3 });
    expect(hasProblems(found)).toBe(true);

    expect(approverListProblems('ALL', [user()], { requireMinimum: false }).belowMinimum).toBe(
      false,
    );
    expect(approverListProblems('ALL', [user()], { requireMinimum: true }).belowMinimum).toBe(true);
    expect(approverListProblems('ANY', [user()], { requireMinimum: true }).belowMinimum).toBe(
      false,
    );
    const many = Array.from({ length: 21 }, (_, index) =>
      user(`0192a000-0000-7000-8000-${String(index).padStart(12, '0')}`),
    );
    expect(approverListProblems('ALL', many, { requireMinimum: false }).tooMany).toBe(true);
  });

  it('erros da API por linha', () => {
    expect(lineIndexOf('approvers[1].approverUserId')).toBe(1);
    expect(lineIndexOf('approvalPolicy.approvers[0]')).toBe(0);
    expect(lineIndexOf('approvalPolicy.approvers')).toBeNull();
  });
});

describe('approvalPolicy do SCR-108 com a lista (US-132 · RN-APV-11)', () => {
  const base = {
    id: '0192a000-0000-7000-8000-000000000061',
    code: 'NOTA_TECNICA',
    approvalPolicy: null,
    editableFields: ['requiresApproval', 'approvalPolicy'],
    version: 1,
  } as unknown as DocumentTypeDto;

  it('ALL com usuário e perfil: lista e aprovador único espelhando a linha 1', () => {
    expect(
      policyOf({ ...EMPTY_VALUES, decisionPolicy: 'ALL', slaDays: '3' }, [user(), role()]),
    ).toEqual({
      decisionPolicy: 'ALL',
      approvers: [
        { approverType: 'USER', approverUserId: MARCOS, allowDeputy: true },
        { approverType: 'ROLE', approverRoleId: PERFIL, allowDeputy: true },
      ],
      approverType: 'USER',
      approverUserId: MARCOS,
      allowDeputy: true,
      slaDays: 3,
      slaType: 'BUSINESS',
    });
    // `ANY` continua o aprovador único do MVP 1, sem as chaves novas.
    expect(policyOf(EMPTY_VALUES, [user()])).not.toHaveProperty('decisionPolicy');
  });

  it('PATCH leva a política quando a lista muda; política com lista é editável', () => {
    const values = {
      ...EMPTY_VALUES,
      requiresApproval: true,
      decisionPolicy: 'SEQUENTIAL' as const,
    };
    const patch = buildPatch(values, {}, base, { lines: [user(), role()], dirty: true });
    expect(patch.approvalPolicy).toMatchObject({ decisionPolicy: 'SEQUENTIAL' });
    expect(buildPatch(values, {}, base, { lines: [user(), role()], dirty: false })).toEqual({});

    const stored = policyOf(values, [user(), role()]);
    expect(isEditablePolicy(stored)).toBe(true);
    const typed = { ...base, approvalPolicy: stored } as DocumentTypeDto;
    expect(initialValues(typed).decisionPolicy).toBe('SEQUENTIAL');
    expect(formFieldOf('approvalPolicy.approvers')).toBe('decisionPolicy');
    expect(formFieldOf('approvalPolicy.decisionPolicy')).toBe('decisionPolicy');
  });
});
