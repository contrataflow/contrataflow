import type { DuplicateCandidate } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DUPLICATE_CANDIDATES_LIMIT } from '../domain/duplicate-detection.js';

export interface DuplicateLookup {
  readonly title: string;
  readonly object: string;
  readonly requestingDepartmentId: string;
  readonly createdById: string;
  readonly since: Date;
}

/**
 * Candidatos a duplicidade (US-001 · FA-02 · RN-PROC-13) — a mesma busca no PRC-03 (aviso no
 * passo 3 do wizard) e no PRC-02 (salvaguarda): processos do tenant, VISÍVEIS ao usuário (DEC-024 —
 * nunca revela título de processo que ele não vê), com título ou objeto semelhante, do mesmo
 * criador ou setor solicitante e dentro da janela; com o nome de quem criou.
 */
@Injectable()
export class DuplicateCandidatesFinder {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async find(tx: TenantTx, lookup: DuplicateLookup): Promise<DuplicateCandidate[]> {
    const rows = await this.processes.findDuplicateCandidates(tx, {
      ...lookup,
      visibility: await this.access.processVisibilityScope(),
      limit: DUPLICATE_CANDIDATES_LIMIT,
    });
    if (rows.length === 0) return [];
    const names = await this.identity.userDisplayNames(
      tx,
      rows.map((row) => row.createdById),
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      createdBy: { id: row.createdById, name: names.get(row.createdById) ?? '' },
    }));
  }
}
