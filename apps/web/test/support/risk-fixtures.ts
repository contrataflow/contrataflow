import type { RiskTreatmentDto } from '@contrataflow/validation';

import { ID, PROCESS_ID } from './process-fixtures';

/** Ação de tratamento (US-034) como RSK-01/03 a devolvem em `Risk.treatments`. */
export function treatmentFixture(
  sequence: number,
  riskId: string,
  extra: Partial<RiskTreatmentDto> = {},
): RiskTreatmentDto {
  return {
    id: ID(950 + sequence),
    riskId,
    processId: PROCESS_ID,
    type: 'PREVENTIVE',
    description: `Ação de tratamento número ${String(sequence)}`,
    responsibleId: null,
    responsible: null,
    responsibleDepartmentId: null,
    responsibleDepartment: null,
    dueDate: null,
    status: 'PLANNED',
    completedAt: null,
    notes: null,
    sortOrder: sequence - 1,
    version: 1,
    ...extra,
  };
}
