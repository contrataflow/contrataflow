import { describe, expect, it } from 'vitest';

import {
  approverLineIdentity,
  approverLineIssues,
  approversBelowMinimum,
  DECISION_POLICY_LABELS,
  duplicateApproverIndexes,
  normalizeApproverLine,
} from './approver-lines.js';
import { approvalPolicySchema } from './document-type.js';
import { workflowStageApproversSetSchema } from '../workflow/workflow.js';

/*
 * US-132 — value object `ApproverLine` e a política de decisão (RN-APV-01..05, RN-APV-11): forma da
 * linha por tipo, unicidade, limites, normalização e os schemas do WF-65 e da `approvalPolicy`.
 */

const MARCOS = '0192c132-0000-7000-8000-0000000000a1';
const SECRETARIA = '0192c132-0000-7000-8000-0000000000d1';
const PERFIL = '0192c132-0000-7000-8000-0000000000e1';

const issuesOf = (result: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (result.error?.issues ?? []).map((issue) => {
    const { path, message, params } = issue as {
      path: (string | number)[];
      message: string;
      params?: { code?: string };
    };
    return { path: path.join('.'), message, code: params?.code };
  });

describe('ApproverLine (US-132)', () => {
  it('RN-APV-14: rótulos pt-BR da política', () => {
    expect(DECISION_POLICY_LABELS).toEqual({
      ANY: 'Qualquer um aprova',
      ALL: 'Todos aprovam',
      SEQUENTIAL: 'Aprovam em sequência',
    });
  });

  it('RN-APV-04 (V-04): referência obrigatória e compatível com o tipo, com a linha na mensagem', () => {
    expect(approverLineIssues({ approverType: 'USER' }, 0)).toEqual([
      {
        field: 'approverUserId',
        code: 'CONDITIONAL_REQUIRED',
        message: 'Informe o aprovador da linha 1.',
      },
    ]);
    expect(
      approverLineIssues(
        { approverType: 'ROLE', approverRoleId: PERFIL, approverUserId: MARCOS },
        2,
      ),
    ).toEqual([expect.objectContaining({ field: 'approverUserId', code: 'NOT_ALLOWED' })]);
    expect(
      approverLineIssues(
        { approverType: 'DEPARTMENT_HEAD', approverDepartmentResolution: 'FIXED' },
        1,
      ),
    ).toEqual([
      {
        field: 'approverFixedDepartmentId',
        code: 'CONDITIONAL_REQUIRED',
        message: 'Informe o aprovador da linha 2.',
      },
    ]);
    expect(
      approverLineIssues(
        {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          approverFixedDepartmentId: SECRETARIA,
        },
        0,
      ),
    ).toEqual([
      expect.objectContaining({ field: 'approverFixedDepartmentId', code: 'NOT_ALLOWED' }),
    ]);
  });

  it('RN-APV-05: identidade por usuário, perfil ou resolução + unidade', () => {
    expect(approverLineIdentity({ approverType: 'USER', approverUserId: MARCOS })).toBe(
      `USER:${MARCOS}`,
    );
    expect(
      approverLineIdentity({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: SECRETARIA,
      }),
    ).toBe(`DEPARTMENT_HEAD:FIXED:${SECRETARIA}`);
    expect(
      duplicateApproverIndexes([
        { approverType: 'USER', approverUserId: MARCOS },
        { approverType: 'ROLE', approverRoleId: PERFIL },
        { approverType: 'USER', approverUserId: MARCOS },
      ]),
    ).toEqual([2]);
  });

  it('RN-APV-03: mínimo de duas linhas só em ALL/SEQUENTIAL', () => {
    expect(approversBelowMinimum('ANY', 0)).toBe(false);
    expect(approversBelowMinimum('ANY', 1)).toBe(false);
    expect(approversBelowMinimum('ALL', 1)).toBe(true);
    expect(approversBelowMinimum('SEQUENTIAL', 2)).toBe(false);
  });

  it('normalização: só as referências do tipo, substituto padrão true e rótulo vazio = null', () => {
    expect(
      normalizeApproverLine({
        approverType: 'USER',
        approverUserId: MARCOS,
        approverRoleId: PERFIL,
        label: '  ',
      }),
    ).toEqual({
      approverType: 'USER',
      approverUserId: MARCOS,
      approverRoleId: null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
      allowDeputy: true,
      label: null,
    });
  });
});

describe('WF-65 — workflowStageApproversSetSchema (US-132)', () => {
  it('aceita a política com a lista e aplica o padrão []', () => {
    expect(workflowStageApproversSetSchema.parse({ decisionPolicy: 'ANY' })).toEqual({
      decisionPolicy: 'ANY',
      approvers: [],
    });
    expect(
      workflowStageApproversSetSchema.safeParse({
        decisionPolicy: 'SEQUENTIAL',
        approvers: [
          {
            approverType: 'DEPARTMENT_HEAD',
            approverDepartmentResolution: 'FIXED',
            approverFixedDepartmentId: SECRETARIA,
            label: 'Secretário de Administração',
          },
          { approverType: 'USER', approverUserId: MARCOS },
        ],
      }).success,
    ).toBe(true);
  });

  it('V-01, V-03, V-05, V-07 e V-08', () => {
    expect(
      workflowStageApproversSetSchema.safeParse({ decisionPolicy: 'MAIORIA', approvers: [] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 21 }, (_, index) => ({
      approverType: 'USER',
      approverUserId: `0192c132-0000-7000-8000-${String(index).padStart(12, '0')}`,
    }));
    expect(
      issuesOf(
        workflowStageApproversSetSchema.safeParse({ decisionPolicy: 'ALL', approvers: many }),
      ),
    ).toContainEqual(
      expect.objectContaining({ path: 'approvers', message: 'Informe no máximo 20 aprovadores.' }),
    );
    expect(
      issuesOf(
        workflowStageApproversSetSchema.safeParse({
          decisionPolicy: 'ALL',
          approvers: [
            { approverType: 'USER', approverUserId: MARCOS },
            { approverType: 'USER', approverUserId: MARCOS },
          ],
        }),
      ),
    ).toEqual([
      {
        path: 'approvers.1',
        message: 'O mesmo aprovador não pode aparecer duas vezes.',
        code: 'DUPLICATE_IN_LIST',
      },
    ]);
    expect(
      issuesOf(
        workflowStageApproversSetSchema.safeParse({
          decisionPolicy: 'ALL',
          approvers: [{ approverType: 'USER', approverUserId: MARCOS, label: 'x'.repeat(121) }],
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        path: 'approvers.0.label',
        message: 'O rótulo deve ter até 120 caracteres.',
      }),
    );
    for (const extra of [{ sequence: 1 }, { applicabilityRule: {} }]) {
      expect(
        workflowStageApproversSetSchema.safeParse({
          decisionPolicy: 'ALL',
          approvers: [{ approverType: 'USER', approverUserId: MARCOS, ...extra }],
        }).success,
      ).toBe(false);
    }
    expect(
      workflowStageApproversSetSchema.safeParse({
        decisionPolicy: 'ALL',
        approvers: [],
        decisionPolicyRules: [],
      }).success,
    ).toBe(false);
  });
});

describe('approvalPolicySchema ampliado (US-132 · RN-APV-11)', () => {
  it('a política do MVP 1 continua válida sem os campos novos', () => {
    expect(
      approvalPolicySchema.safeParse({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        allowDeputy: true,
      }).success,
    ).toBe(true);
  });

  it('com linhas, o aprovador único não é conferido (espelho da linha 1 gravado pela API)', () => {
    const result = approvalPolicySchema.safeParse({
      decisionPolicy: 'ALL',
      approvers: [
        { approverType: 'USER', approverUserId: MARCOS },
        { approverType: 'ROLE', approverRoleId: PERFIL },
      ],
      approverType: 'USER',
      allowDeputy: false,
    });
    expect(result.success).toBe(true);
  });

  it('linhas repetidas e referência faltando são recusadas no schema', () => {
    const issues = issuesOf(
      approvalPolicySchema.safeParse({
        decisionPolicy: 'ALL',
        approvers: [{ approverType: 'ROLE' }, { approverType: 'ROLE' }],
        approverType: 'ROLE',
        allowDeputy: false,
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'approvers.0.approverRoleId', code: 'CONDITIONAL_REQUIRED' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'approvers.1', code: 'DUPLICATE_IN_LIST' }),
    );
  });
});
