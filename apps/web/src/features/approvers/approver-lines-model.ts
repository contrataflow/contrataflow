import {
  APPROVER_LINES_LIMITS,
  approverLineIssues,
  approversBelowMinimum,
  duplicateApproverIndexes,
} from '@contrataflow/validation';
import type {
  ApprovalDecisionPolicy,
  ApproverLineDto,
  ApproverLineInput,
  ApproverType,
  DepartmentResolution,
} from '@contrataflow/validation';

/*
 * Modelo do editor de aprovadores ordenados (US-132 · SCR-034 "Quem decide" e SCR-108 "Quem
 * aprova"): linhas como o usuário as edita ⇄ `approvers[]` do WF-65 e da `approvalPolicy`, com as
 * MESMAS regras do pacote de validação (forma da linha, unicidade, limite de 20, mínimo de duas em
 * `ALL`/`SEQUENTIAL`). Funções puras, testáveis sem DOM.
 */

/** Linha em edição; `key` é só do cliente (lista estável ao reordenar). */
export interface ApproverLineDraft {
  readonly key: string;
  readonly approverType: ApproverType;
  readonly approverUserId: string;
  readonly approverRoleId: string;
  readonly approverDepartmentResolution: DepartmentResolution | '';
  readonly approverFixedDepartmentId: string;
  readonly allowDeputy: boolean;
  readonly label: string;
}

let sequence = 0;
function nextKey(): string {
  sequence += 1;
  return `linha-${String(sequence)}`;
}

/** Linha nova (titular da secretaria solicitante — o padrão do aprovador único). */
export function newLineDraft(): ApproverLineDraft {
  return {
    key: nextKey(),
    approverType: 'DEPARTMENT_HEAD',
    approverUserId: '',
    approverRoleId: '',
    approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    approverFixedDepartmentId: '',
    allowDeputy: true,
    label: '',
  };
}

/** Linha gravada (DTO do WF-09/WF-65 ou entrada da `approvalPolicy`). */
type LineSource = Pick<ApproverLineDto, 'approverType'> & {
  readonly approverUserId?: string | null | undefined;
  readonly approverRoleId?: string | null | undefined;
  readonly approverDepartmentResolution?: DepartmentResolution | null | undefined;
  readonly approverFixedDepartmentId?: string | null | undefined;
  readonly allowDeputy?: boolean | undefined;
  readonly label?: string | null | undefined;
};

/** Linhas gravadas (WF-09/WF-65 ou `approvalPolicy.approvers`) → rascunho. */
export function draftsOf(lines: readonly LineSource[]): ApproverLineDraft[] {
  return lines.map((line) => ({
    key: nextKey(),
    approverType: line.approverType,
    approverUserId: line.approverUserId ?? '',
    approverRoleId: line.approverRoleId ?? '',
    approverDepartmentResolution: line.approverDepartmentResolution ?? '',
    approverFixedDepartmentId: line.approverFixedDepartmentId ?? '',
    allowDeputy: line.allowDeputy ?? true,
    label: line.label ?? '',
  }));
}

/** Rascunho → `approvers[]` do corpo (só as referências do tipo; sem `sequence`). */
export function linesBody(drafts: readonly ApproverLineDraft[]): ApproverLineInput[] {
  return drafts.map((draft) => {
    const head = draft.approverType === 'DEPARTMENT_HEAD';
    const label = draft.label.trim();
    return {
      approverType: draft.approverType,
      ...(draft.approverType === 'USER' && draft.approverUserId
        ? { approverUserId: draft.approverUserId }
        : {}),
      ...(draft.approverType === 'ROLE' && draft.approverRoleId
        ? { approverRoleId: draft.approverRoleId }
        : {}),
      ...(head && draft.approverDepartmentResolution
        ? { approverDepartmentResolution: draft.approverDepartmentResolution }
        : {}),
      ...(head && draft.approverDepartmentResolution === 'FIXED' && draft.approverFixedDepartmentId
        ? { approverFixedDepartmentId: draft.approverFixedDepartmentId }
        : {}),
      allowDeputy: draft.allowDeputy,
      ...(label === '' ? {} : { label }),
    };
  });
}

/** Troca de tipo: limpa as referências que não valem mais. */
export function withType(draft: ApproverLineDraft, type: ApproverType): ApproverLineDraft {
  return {
    ...draft,
    approverType: type,
    approverUserId: '',
    approverRoleId: '',
    approverDepartmentResolution: type === 'DEPARTMENT_HEAD' ? 'REQUESTING_SECRETARIAT' : '',
    approverFixedDepartmentId: '',
  };
}

/** "Subir/Descer" (e as setas do teclado): move a linha `index` em `delta`, se couber. */
export function moveLine(
  drafts: readonly ApproverLineDraft[],
  index: number,
  delta: -1 | 1,
): ApproverLineDraft[] {
  const target = index + delta;
  if (index < 0 || index >= drafts.length || target < 0 || target >= drafts.length) {
    return [...drafts];
  }
  const next = [...drafts];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(target, 0, moved);
  return next;
}

export type LineProblemCode = 'REQUIRED' | 'DUPLICATE' | 'LABEL_TOO_LONG';

export interface ApproverListProblems {
  /** Por `key` da linha: o primeiro problema e o campo dele. */
  readonly lines: Readonly<
    Record<
      string,
      { readonly field: string; readonly code: LineProblemCode; readonly line: number }
    >
  >;
  readonly tooMany: boolean;
  /** `ALL`/`SEQUENTIAL` com menos de duas linhas (só quando `requireMinimum`). */
  readonly belowMinimum: boolean;
}

/**
 * Regras locais antes de chamar a API (V-03/V-04/V-05/V-07; V-14 com `requireMinimum`). O rascunho
 * do workflow tolera menos de duas linhas (FA-03); o tipo de documento, não (RN-APV-11).
 */
export function approverListProblems(
  policy: ApprovalDecisionPolicy,
  drafts: readonly ApproverLineDraft[],
  options: { readonly requireMinimum: boolean },
): ApproverListProblems {
  const body = linesBody(drafts);
  const lines: Record<string, { field: string; code: LineProblemCode; line: number }> = {};
  body.forEach((line, index) => {
    const key = drafts[index]?.key ?? '';
    const [issue] = approverLineIssues(line, index);
    if (issue?.code === 'CONDITIONAL_REQUIRED') {
      lines[key] = { field: issue.field, code: 'REQUIRED', line: index + 1 };
    } else if ((line.label?.length ?? 0) > APPROVER_LINES_LIMITS.labelLength) {
      lines[key] = { field: 'label', code: 'LABEL_TOO_LONG', line: index + 1 };
    }
  });
  for (const index of duplicateApproverIndexes(body)) {
    const key = drafts[index]?.key ?? '';
    lines[key] ??= { field: 'approverType', code: 'DUPLICATE', line: index + 1 };
  }
  return {
    lines,
    tooMany: drafts.length > APPROVER_LINES_LIMITS.max,
    belowMinimum: options.requireMinimum && approversBelowMinimum(policy, drafts.length),
  };
}

export function hasProblems(problems: ApproverListProblems): boolean {
  return Object.keys(problems.lines).length > 0 || problems.tooMany || problems.belowMinimum;
}

/** Erro da API (`approvers[1].approverRoleId`, `approvalPolicy.approvers[0]`) → linha (base 0). */
export function lineIndexOf(field: string): number | null {
  const match = /approvers\[(\d+)\]/.exec(field);
  return match ? Number(match[1]) : null;
}

/** Os mesmos campos, mesma ordem? (botão "Salvar" habilitado só com mudança). */
export function sameLines(
  a: readonly ApproverLineDraft[],
  b: readonly ApproverLineDraft[],
): boolean {
  return JSON.stringify(linesBody(a)) === JSON.stringify(linesBody(b));
}
