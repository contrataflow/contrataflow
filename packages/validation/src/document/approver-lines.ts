import type { FieldErrorCode } from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Política de decisão e linhas ordenadas de aprovadores (US-132 · DEC-193 · entities.md MVP 2
 * §4.6): o value object `ApproverLine` é o mesmo na etapa `APPROVAL` do workflow
 * (`WorkflowStageApprover`, WF-65) e na `approvalPolicy` do tipo de documento (DTY-02/DTY-03). As
 * regras puras daqui (forma da linha, unicidade, limites, espelho da linha 1) valem no front
 * (SCR-034/SCR-108) e na API; a resolubilidade das referências é da API.
 */

export const APPROVER_TYPES = ['USER', 'ROLE', 'DEPARTMENT_HEAD'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export const DEPARTMENT_RESOLUTIONS = [
  'FIXED',
  'REQUESTING_SECRETARIAT',
  'REQUESTING_DEPARTMENT',
] as const;
export type DepartmentResolution = (typeof DEPARTMENT_RESOLUTIONS)[number];

/** `ApprovalDecisionPolicy` (DEC-193): `ANY` é o comportamento do MVP 1. */
export const APPROVAL_DECISION_POLICIES = ['ANY', 'ALL', 'SEQUENTIAL'] as const;
export type ApprovalDecisionPolicy = (typeof APPROVAL_DECISION_POLICIES)[number];

/** RN-APV-14: rótulos pt-BR (terminology.md). */
export const DECISION_POLICY_LABELS: Readonly<Record<ApprovalDecisionPolicy, string>> = {
  ANY: 'Qualquer um aprova',
  ALL: 'Todos aprovam',
  SEQUENTIAL: 'Aprovam em sequência',
};

/** RN-APV-03: limites da lista. */
export const APPROVER_LINES_LIMITS = Object.freeze({
  max: 20,
  /** Mínimo de linhas em `ALL`/`SEQUENTIAL` (validação/publicação e tipo de documento). */
  minForMultiple: 2,
  labelLength: 120,
});

export const DECISION_POLICY_MESSAGE = 'Selecione como a decisão será tomada.';
export const APPROVERS_TOO_MANY_MESSAGE = 'Informe no máximo 20 aprovadores.';
export const APPROVER_DUPLICATED_MESSAGE = 'O mesmo aprovador não pode aparecer duas vezes.';
export const APPROVER_LABEL_MESSAGE = 'O rótulo deve ter até 120 caracteres.';
export const APPROVERS_MIN_MESSAGE = 'Informe ao menos dois aprovadores para esta política.';

/** Linha de aprovador gravada (sem `sequence`, que é a posição na lista). */
export interface ApproverLineFields {
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentResolution: DepartmentResolution | null;
  readonly approverFixedDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly label: string | null;
}

/** Problema de campo de uma linha (`field` relativo à linha: `approverUserId`…). */
export interface ApproverLineIssue {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

/** Linha como chega (corpo ou formulário): referências opcionais. */
export type LineInput = Pick<ApproverLineFields, 'approverType'> & {
  readonly [K in Exclude<keyof ApproverLineFields, 'approverType'>]?:
    ApproverLineFields[K] | undefined;
};

/**
 * RN-APV-04 (V-04): referência obrigatória e compatível com o tipo, como no aprovador único. A
 * posição (`index`, base 0) entra na mensagem: "Informe o aprovador da linha 2.".
 */
export function approverLineIssues(line: LineInput, index: number): ApproverLineIssue[] {
  const issues: ApproverLineIssue[] = [];
  const missing = `Informe o aprovador da linha ${index + 1}.`;
  const required = (field: string, message = missing) =>
    issues.push({ field, code: 'CONDITIONAL_REQUIRED', message });
  const notAllowed = (field: string, message: string) =>
    issues.push({ field, code: 'NOT_ALLOWED', message });
  const user = line.approverType === 'USER';
  const role = line.approverType === 'ROLE';
  const head = line.approverType === 'DEPARTMENT_HEAD';
  if (user && !line.approverUserId) required('approverUserId');
  if (!user && line.approverUserId) {
    notAllowed('approverUserId', 'O usuário só vale para aprovador USER.');
  }
  if (role && !line.approverRoleId) required('approverRoleId');
  if (!role && line.approverRoleId) {
    notAllowed('approverRoleId', 'O perfil só vale para aprovador ROLE.');
  }
  if (head && !line.approverDepartmentResolution) required('approverDepartmentResolution');
  if (!head && line.approverDepartmentResolution) {
    notAllowed('approverDepartmentResolution', 'A unidade só vale para aprovador titular.');
  }
  const fixed = head && line.approverDepartmentResolution === 'FIXED';
  if (fixed && !line.approverFixedDepartmentId) required('approverFixedDepartmentId');
  if (!fixed && line.approverFixedDepartmentId) {
    notAllowed('approverFixedDepartmentId', 'A unidade fixa só vale para a resolução FIXED.');
  }
  return issues;
}

/**
 * Identidade da linha para a unicidade (RN-APV-05): mesmo usuário, mesmo perfil ou mesma
 * resolução + unidade. A coincidência de pessoas resolvidas é da solicitação (US-133).
 */
export function approverLineIdentity(line: LineInput): string {
  switch (line.approverType) {
    case 'USER':
      return `USER:${line.approverUserId ?? ''}`;
    case 'ROLE':
      return `ROLE:${line.approverRoleId ?? ''}`;
    default:
      return `DEPARTMENT_HEAD:${line.approverDepartmentResolution ?? ''}:${
        line.approverDepartmentResolution === 'FIXED' ? (line.approverFixedDepartmentId ?? '') : ''
      }`;
  }
}

/** Posições (base 0) que repetem uma linha anterior (RN-APV-05). */
export function duplicateApproverIndexes(lines: readonly LineInput[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  lines.forEach((line, index) => {
    const identity = approverLineIdentity(line);
    if (seen.has(identity)) duplicates.push(index);
    else seen.add(identity);
  });
  return duplicates;
}

/** RN-APV-03: `ALL`/`SEQUENTIAL` com menos de duas linhas (só na validação/publicação e no tipo). */
export function approversBelowMinimum(policy: ApprovalDecisionPolicy, count: number): boolean {
  return policy !== 'ANY' && count < APPROVER_LINES_LIMITS.minForMultiple;
}

/**
 * Linha gravada: só as referências do tipo escolhido, `allowDeputy` padrão `true` e rótulo vazio
 * como `null` (como `normalizeApprovalPolicy` do aprovador único).
 */
export function normalizeApproverLine(line: LineInput): ApproverLineFields {
  const head = line.approverType === 'DEPARTMENT_HEAD';
  const label = line.label?.trim() ?? '';
  return {
    approverType: line.approverType,
    approverUserId: line.approverType === 'USER' ? (line.approverUserId ?? null) : null,
    approverRoleId: line.approverType === 'ROLE' ? (line.approverRoleId ?? null) : null,
    approverDepartmentResolution: head ? (line.approverDepartmentResolution ?? null) : null,
    approverFixedDepartmentId:
      head && line.approverDepartmentResolution === 'FIXED'
        ? (line.approverFixedDepartmentId ?? null)
        : null,
    allowDeputy: line.allowDeputy ?? true,
    label: label === '' ? null : label,
  };
}

/** Linha de aprovador na entrada (WF-65 e `approvalPolicy.approvers[]`): sem `sequence` (V-08). */
export const approverLineInputSchema = z.strictObject({
  approverType: z.enum(APPROVER_TYPES, { error: 'Selecione o tipo de aprovador.' }),
  approverUserId: uuidV7Schema.nullish(),
  approverRoleId: uuidV7Schema.nullish(),
  approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).nullish(),
  approverFixedDepartmentId: uuidV7Schema.nullish(),
  allowDeputy: z.boolean().optional(),
  label: z
    .string()
    .trim()
    .max(APPROVER_LINES_LIMITS.labelLength, { error: APPROVER_LABEL_MESSAGE })
    .nullish(),
});
export type ApproverLineInput = z.infer<typeof approverLineInputSchema>;

/**
 * Lista de linhas com as regras locais: até 20 (V-03 → `TOO_LONG` em `approvers`), forma de cada
 * linha (V-04, `approvers[n].campo`) e unicidade (V-05 → `DUPLICATE_IN_LIST` na linha repetida).
 */
export const approverLinesSchema = z
  .array(approverLineInputSchema)
  .max(APPROVER_LINES_LIMITS.max, { error: APPROVERS_TOO_MANY_MESSAGE })
  .superRefine((lines, ctx) => {
    lines.forEach((line, index) => {
      for (const issue of approverLineIssues(line, index)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, issue.field],
          message: issue.message,
          params: { code: issue.code },
        });
      }
    });
    for (const index of duplicateApproverIndexes(lines)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: APPROVER_DUPLICATED_MESSAGE,
        params: { code: 'DUPLICATE_IN_LIST' },
      });
    }
  });

/** Estado da referência da linha na resposta (só leitura — US-132 · Campos). */
export const APPROVER_REFERENCE_STATUSES = ['OK', 'INACTIVE', 'NO_HEAD'] as const;
export type ApproverReferenceStatus = (typeof APPROVER_REFERENCE_STATUSES)[number];

/** Linha de aprovador na resposta (`sequence` 1..n calculada pelo servidor). */
export const approverLineDtoSchema = z
  .object({
    /** Ausente na leitura do snapshot publicado (as linhas valem pela ordem). */
    id: z.uuid().optional(),
    sequence: z.number().int().min(1),
    approverType: z.enum(APPROVER_TYPES),
    approverUserId: z.uuid().nullable(),
    approverRoleId: z.uuid().nullable(),
    approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).nullable(),
    approverFixedDepartmentId: z.uuid().nullable(),
    allowDeputy: z.boolean(),
    label: z.string().nullable(),
    /** Só no WF-65: rótulo exibido (`label` ou nome resolvido) e estado da referência. */
    resolved: z
      .object({ label: z.string(), status: z.enum(APPROVER_REFERENCE_STATUSES) })
      .optional(),
  })
  .meta({ id: 'ApproverLine' });
export type ApproverLineDto = z.infer<typeof approverLineDtoSchema>;
