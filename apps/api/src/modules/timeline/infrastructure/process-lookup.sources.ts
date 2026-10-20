import { Injectable } from '@nestjs/common';

import { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import { OrganizationFacade } from '#modules/organization/application/organization.facade.js';
import { ProcessFacade } from '#modules/process/application/process.facade.js';
import { RiskFacade } from '#modules/risk/application/risk.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/*
 * Fontes de nomes congelados (RN-TML-04) das referências de `ProcessCreated` (US-001): a unidade
 * solicitante (`organization`), o processo de origem de uma duplicação e as etapas do processo
 * (`process`). Sempre pela fachada do módulo dono, no `tx` do caso de uso (RLS do tenant).
 */

/** Fonte `DEPARTMENT`: nome da unidade do tenant da transação. */
@Injectable()
export class DepartmentLookupSource implements TimelineLookupSource<'DEPARTMENT'> {
  readonly kind = 'DEPARTMENT';

  constructor(private readonly organization: OrganizationFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['DEPARTMENT']>> {
    const names = await this.organization.departmentNames(tx, ids);
    return new Map([...names].map(([id, name]) => [id, { name }]));
  }
}

/** Fonte `PROCESS`: código (nulo em rascunho sem número) e sigilo do orçamento (POL-09). */
@Injectable()
export class ProcessLookupSource implements TimelineLookupSource<'PROCESS'> {
  readonly kind = 'PROCESS';

  constructor(private readonly processes: ProcessFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['PROCESS']>> {
    return this.processes.processReferences(tx, ids);
  }
}

/** Fonte `PROCESS_STAGE`: nome da etapa da passagem, na versão de workflow fixada no processo. */
@Injectable()
export class ProcessStageLookupSource implements TimelineLookupSource<'PROCESS_STAGE'> {
  readonly kind = 'PROCESS_STAGE';

  constructor(private readonly processes: ProcessFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['PROCESS_STAGE']>> {
    const names = await this.processes.stageNames(tx, ids);
    return new Map([...names].map(([id, name]) => [id, { name }]));
  }
}

/**
 * Fonte `PROCESS_PARTICIPANT` (US-012): nome do usuário (`identity`) ou da unidade
 * (`organization`) e o papel do participante — revogado inclusive (`PARTICIPANT_REMOVED`).
 */
@Injectable()
export class ProcessParticipantLookupSource implements TimelineLookupSource<'PROCESS_PARTICIPANT'> {
  readonly kind = 'PROCESS_PARTICIPANT';

  constructor(
    private readonly processes: ProcessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['PROCESS_PARTICIPANT']>> {
    const refs = await this.processes.participantReferences(tx, ids);
    const userNames = await this.identity.userDisplayNames(tx, [
      ...new Set([...refs.values()].flatMap((ref) => ref.userId ?? [])),
    ]);
    const departmentNames = await this.organization.departmentNames(tx, [
      ...new Set([...refs.values()].flatMap((ref) => ref.departmentId ?? [])),
    ]);
    const records = new Map<string, TimelineLookupRecords['PROCESS_PARTICIPANT']>();
    for (const [id, ref] of refs) {
      const name =
        ref.userId !== null
          ? userNames.get(ref.userId)
          : departmentNames.get(ref.departmentId ?? '');
      if (name !== undefined) records.set(id, { name, role: ref.role });
    }
    return records;
  }
}

/** Fonte `RISK` (US-033): código e título do risco (inclusive excluído — `RISK_REMOVED`). */
@Injectable()
export class RiskLookupSource implements TimelineLookupSource<'RISK'> {
  readonly kind = 'RISK';

  constructor(private readonly risks: RiskFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['RISK']>> {
    return this.risks.riskLabels(tx, ids);
  }
}
