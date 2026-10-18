import type { DfdHeaderValues, DfdWizardStep, PcaStatus, Priority } from '@contrataflow/validation';

/*
 * Cabeçalho tipado do DFD (US-014 · entities.md §4.8 · Decreto 10.947/2022, art. 8º). O DFD nasce
 * dentro do processo, 1:1 com o `Document` do tipo `DFD` (mesmo id — CHECK `dfds_id_is_document`),
 * com os valores iniciais copiados do processo (RN-DFD-05). Puro: sem NestJS, Prisma nem outro
 * módulo.
 */

export interface Dfd {
  /** = `documentId` (o identificador das rotas da SCR-007 e do painel de documentos). */
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  readonly requestingDepartmentId: string;
  readonly responsibleId: string;
  /** `AAAA-MM-DD` no fuso do tenant. */
  readonly requestDate: string;
  readonly objectSummary: string;
  readonly priority: Priority;
  readonly expectedDate: string | null;
  /** Decimal(18,2) como string. */
  readonly estimatedValue: string | null;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
  readonly wizardStep: DfdWizardStep;
  readonly completedSteps: readonly DfdWizardStep[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** O que o DFD copia do processo (RN-DFD-05). */
export interface DfdProcessSource {
  readonly id: string;
  readonly requestingDepartmentId: string;
  readonly object: string;
  readonly priority: Priority;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
}

/**
 * RN-DFD-05: setor = setor solicitante do processo; responsável pela demanda = criador; data = hoje
 * (fuso do tenant); objeto, prioridade e PCA = os do processo; previsão e estimativa vazias; passo
 * `IDENTIFICATION`, nenhum concluído. O objeto do processo já respeita 10–2.000 caracteres
 * (RN-DFD-12). A justificativa de PCA do processo só é copiada quando a situação a exige.
 */
export function createDfdFromProcess(
  process: DfdProcessSource,
  input: {
    readonly documentId: string;
    readonly tenantId: string;
    readonly creatorId: string;
    readonly today: string;
    readonly now: Date;
  },
): Dfd {
  const planned = process.pcaStatus === 'PLANNED';
  const notPlanned = process.pcaStatus === 'NOT_PLANNED';
  return {
    id: input.documentId,
    tenantId: input.tenantId,
    processId: process.id,
    documentId: input.documentId,
    requestingDepartmentId: process.requestingDepartmentId,
    responsibleId: input.creatorId,
    requestDate: input.today,
    objectSummary: process.object.trim(),
    priority: process.priority,
    expectedDate: null,
    estimatedValue: null,
    pcaStatus: process.pcaStatus,
    pcaYear: planned ? process.pcaYear : null,
    pcaItemCode: planned ? process.pcaItemCode : null,
    pcaJustification: notPlanned ? process.pcaJustification : null,
    wizardStep: 'IDENTIFICATION',
    completedSteps: [],
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.creatorId,
    updatedById: input.creatorId,
    version: 1,
  };
}

/** Os valores do cabeçalho para a completude (`evaluateDfdCompleteness`) e o snapshot. */
export function dfdHeaderValues(dfd: Dfd): DfdHeaderValues {
  return {
    requestDate: dfd.requestDate,
    requestingDepartmentId: dfd.requestingDepartmentId,
    responsibleId: dfd.responsibleId,
    objectSummary: dfd.objectSummary,
    priority: dfd.priority,
    expectedDate: dfd.expectedDate,
    estimatedValue: dfd.estimatedValue,
    pcaStatus: dfd.pcaStatus,
    pcaYear: dfd.pcaYear,
    pcaItemCode: dfd.pcaItemCode,
    pcaJustification: dfd.pcaJustification,
  };
}

/**
 * RN-DFD-09: o setor do DFD é unidade da subárvore da secretaria solicitante do processo (`path`
 * materializado `/<raiz>/…/<id>/` contém o id da secretaria) e do mesmo órgão.
 */
export function isInSecretariat(
  department: { readonly path: string; readonly organizationId: string },
  secretariat: { readonly id: string; readonly organizationId: string },
): boolean {
  return (
    department.organizationId === secretariat.organizationId &&
    department.path.includes(`/${secretariat.id}/`)
  );
}
