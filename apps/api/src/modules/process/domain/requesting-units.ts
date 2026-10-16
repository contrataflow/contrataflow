import { PROCESS_MESSAGES, SECRETARIAT_TYPES } from '@contrataflow/validation';
import type { DepartmentType } from '@contrataflow/validation';

import type { ProcessIssue } from './process.js';

/*
 * Secretaria e setor solicitantes (US-001 · RN-PROC-02 · V-04/V-05): ambas as unidades existem no
 * tenant, estão ativas e são do órgão do processo; a secretaria é uma unidade `SECRETARIAT`/`BOARD`
 * ou uma raiz do órgão; o setor é a própria secretaria ou uma unidade da subárvore dela (caminho
 * materializado prefixado — RN-TEN-45). Puro: as unidades chegam lidas pela `OrganizationFacade`.
 */

export interface RequestingUnit {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly type: DepartmentType;
  readonly path: string;
  readonly isActive: boolean;
}

/** RN-PROC-02: opções de "Secretaria" = `SECRETARIAT`/`BOARD` do órgão, mais as raízes. */
export function isSecretariatOption(unit: Pick<RequestingUnit, 'type' | 'parentId'>): boolean {
  return unit.parentId === null || SECRETARIAT_TYPES.includes(unit.type);
}

/** O setor é a própria secretaria ou está na subárvore dela. */
export function isInSubtree(
  secretariat: Pick<RequestingUnit, 'id' | 'path'>,
  department: Pick<RequestingUnit, 'id' | 'path'>,
): boolean {
  return department.id === secretariat.id || department.path.startsWith(secretariat.path);
}

function unitIssue(
  field: 'requestingSecretariatId' | 'requestingDepartmentId',
  unit: RequestingUnit | undefined,
  organizationId: string,
): ProcessIssue | null {
  // Inexistente, de outro tenant ou de outro órgão: indistinguíveis (não revela outro tenant).
  if (unit?.organizationId !== organizationId) {
    return { field, code: 'REFERENCE_NOT_FOUND', message: PROCESS_MESSAGES.invalidUnit };
  }
  if (!unit.isActive) {
    return { field, code: 'REFERENCE_INACTIVE', message: PROCESS_MESSAGES.invalidUnit };
  }
  return null;
}

/** V-04/V-05 de RN-PROC-02: problemas de secretaria e setor (vazio = válidos). */
export function requestingUnitIssues(input: {
  readonly organizationId: string;
  readonly secretariat: RequestingUnit | undefined;
  readonly department: RequestingUnit | undefined;
}): ProcessIssue[] {
  const issues: ProcessIssue[] = [];
  const secretariatIssue = unitIssue(
    'requestingSecretariatId',
    input.secretariat,
    input.organizationId,
  );
  const departmentIssue = unitIssue(
    'requestingDepartmentId',
    input.department,
    input.organizationId,
  );
  if (secretariatIssue) issues.push(secretariatIssue);
  else if (input.secretariat && !isSecretariatOption(input.secretariat)) {
    issues.push({
      field: 'requestingSecretariatId',
      code: 'NOT_ALLOWED',
      message: PROCESS_MESSAGES.secretariatNotAllowed,
    });
  }
  if (departmentIssue) issues.push(departmentIssue);
  if (
    issues.length === 0 &&
    input.secretariat &&
    input.department &&
    !isInSubtree(input.secretariat, input.department)
  ) {
    issues.push({
      field: 'requestingDepartmentId',
      code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
      message: PROCESS_MESSAGES.departmentNotInSecretariat,
    });
  }
  return issues;
}
