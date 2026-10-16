import type {
  CheckDuplicateProcesses,
  DuplicateCheckResult,
  ProcessDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { validationError } from '#shared/errors/api-error.js';

import { DuplicateCandidatesFinder } from './duplicate-candidates.js';
import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessClock, ProcessRepository, ProcessTransactions } from './ports.js';
import { processNotFoundError } from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { duplicateWindowStart } from '../domain/duplicate-detection.js';

const WINDOW_SETTING = 'process.duplicateDetectionWindowMinutes';

/**
 * `CheckDuplicateProcessesQuery` — PRC-03 (US-001 · FA-02): candidatos a duplicidade para o aviso
 * do passo 3 do wizard. O setor precisa existir no tenant e estar ativo (422 — nunca revela unidade
 * de outro tenant); janela 0 = detecção desativada (lista vazia). Somente leitura.
 */
@Injectable()
export class CheckDuplicateProcessesQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly duplicates: DuplicateCandidatesFinder,
  ) {}

  execute(body: CheckDuplicateProcesses): Promise<DuplicateCheckResult> {
    const userId = requireRequestContext().actor.userId ?? '';
    return this.transactions.read(async (tx) => {
      const unit = (
        await this.organization.departmentReferences(tx, [body.requestingDepartmentId])
      ).get(body.requestingDepartmentId);
      if (!unit?.isActive) {
        throw validationError([
          {
            field: 'requestingDepartmentId',
            code: unit ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
            message: 'Selecione uma unidade válida.',
          },
        ]);
      }
      const window = (await this.tenancy.settingValues(tx, [WINDOW_SETTING])).get(WINDOW_SETTING);
      const since = duplicateWindowStart(this.clock(), typeof window === 'number' ? window : 0);
      if (since === null) return { candidates: [] };
      const candidates = await this.duplicates.find(tx, {
        title: body.title.trim(),
        object: body.object.trim(),
        requestingDepartmentId: body.requestingDepartmentId,
        createdById: userId,
        since,
      });
      return { candidates };
    });
  }
}

/**
 * `GetProcessQuery` — PRC-04 (mínimo da US-001 para o painel SCR-006 após a criação; US-004
 * completa o painel situacional). A visibilidade (DEC-024) já foi conferida pelo guard
 * (`@RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })` → 404
 * `PROCESS_NOT_FOUND`); aqui só se lê e apresenta.
 */
@Injectable()
export class GetProcessQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly presenter: ProcessPresenter,
  ) {}

  execute(processId: string): Promise<ProcessDto> {
    return this.transactions.read(async (tx) => {
      const rows = await this.processes.loadAggregate(tx, processId);
      if (rows === null) throw processNotFoundError();
      return this.presenter.present(tx, rows.process);
    });
  }
}
