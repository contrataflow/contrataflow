import { ProcessConfidentialityChanged } from '@contrataflow/validation';
import type { ProcessConflictCurrent, ProcessDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { ConfidentialViewRecorder } from './confidential-view.recorder.js';
import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import { processNotFoundError, processVersionConflict } from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { setBudgetConfidential } from '../domain/process-confidentiality.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

export interface SetProcessConfidentialityInput {
  readonly processId: string;
  readonly isBudgetConfidential: boolean;
  /** `If-Match` (RN-PROC-144 · DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
}

export interface ProcessConfidentialityResult {
  readonly dto: ProcessDto;
  /** `false` = a flag já estava no estado pedido (sem nova versão, evento nem auditoria). */
  readonly changed: boolean;
  /** Documentos de pesquisa de preços cuja confidencialidade mudou (RN-PROC-139). */
  readonly documentsChanged: number;
}

interface Prepared {
  readonly now: Date;
}

/**
 * `SetProcessConfidentialityCommand` — PRC-33 (US-013 · fluxo principal, passo 4): o padrão
 * `TransactionalCommandHandler`. `PROCESS_SET_CONFIDENTIAL_BUDGET` cobrindo o processo é conferida
 * pelo guard (`processParam` — 404/403 + `access.denied`, MFA pela POL-14). Numa transação do
 * tenant, com `SELECT … FOR UPDATE` no processo: visibilidade (404) → `If-Match` (412 com
 * `currentVersion` — RN-PROC-144; vem ANTES do no-op, então o reenvio com versão antiga nunca
 * repete o efeito) → flag igual = 200 sem nova versão → gravação (`version + 1`) → cascata nos
 * documentos de pesquisa de preços (RN-PROC-139) → `process.confidentiality_change` → evento
 * `ProcessConfidentialityChanged` (timeline `CONFIDENTIALITY_CHANGED` projetada no mesmo `tx`).
 * Sem notificação (RN-PROC-145). A resposta já sai com a máscara da POL-09 sobre o NOVO estado.
 */
@Injectable()
export class SetProcessConfidentialityCommand extends TransactionalCommandHandler<
  SetProcessConfidentialityInput,
  Prepared,
  ProcessConfidentialityResult
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly documents: DocumentFacade,
    private readonly identity: IdentityFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly confidentialViews: ConfidentialViewRecorder,
  ) {
    super('process.confidentiality_change', transactions);
  }

  /** RN-PROC-143: valor real entregue na resposta = `process.confidential_view` (1× por sessão). */
  override async execute(
    input: SetProcessConfidentialityInput,
  ): Promise<ProcessConfidentialityResult> {
    const result = await super.execute(input);
    if (result.dto.isBudgetConfidential && !result.dto.estimatedValueMasked) {
      await this.confidentialViews.recordOnce(result.dto, 'PRC-33');
    }
    return result;
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: SetProcessConfidentialityInput,
    { now }: Prepared,
  ): Promise<ProcessConfidentialityResult> {
    const userId = requireRequestContext().actor.userId ?? '';

    // Trava antes de ler: o estado lido é o do vencedor de qualquer corrida (DEC-055).
    if (!(await this.processes.lockForUpdate(tx, input.processId))) throw processNotFoundError();
    const { rows, runtime } = await this.panel.load(tx, input.processId);
    const process = rows.process;

    // RN-PROC-144 · V-03: concorrência otimista, antes do no-op (Gherkin "Duplicidade").
    if (input.expectedVersion !== process.version) {
      throw await this.conflict(tx, rows, input.expectedVersion, runtime);
    }

    const updated = setBudgetConfidential(process, input.isBudgetConfidential, { now, userId });
    if (updated === null) {
      const canSeeBudget = await this.panel.canSeeBudget(rows, runtime);
      return {
        dto: await this.presenter.present(tx, process, canSeeBudget),
        changed: false,
        documentsChanged: 0,
      };
    }

    // A trava garante a versão; o `WHERE version` é a rede.
    if (!(await this.processes.updateProcess(tx, updated, process.version))) {
      throw await this.conflict(tx, rows, input.expectedVersion, runtime);
    }
    const documentsChanged = await this.documents.applyBudgetConfidentialityIn(
      tx,
      process.id,
      updated.isBudgetConfidential,
    );

    await this.audit.record(tx, {
      action: 'process.confidentiality_change',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        {
          path: 'isBudgetConfidential',
          old: process.isBudgetConfidential,
          new: updated.isBudgetConfidential,
        },
      ],
      metadata: { processCode: process.code, version: updated.version, documentsChanged },
    });
    await this.outbox.record(
      tx,
      ProcessConfidentialityChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: { isBudgetConfidential: updated.isBudgetConfidential },
      }),
    );

    // POL-09 sobre o novo estado: quem só tem a permissão de alterar não vê o valor ao ativar.
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process: updated }, runtime);
    return {
      dto: await this.presenter.present(tx, updated, canSeeBudget),
      changed: true,
      documentsChanged,
    };
  }

  protected override committed(result: ProcessConfidentialityResult, durationMs: number): void {
    if (!result.changed) return;
    const context = requireRequestContext();
    // Nunca logar o valor estimado (story · Logs).
    this.logger.log(
      {
        event: 'process.confidentiality_changed',
        processId: result.dto.id,
        isBudgetConfidential: result.dto.isBudgetConfidential,
        version: result.dto.version,
        documentsChanged: result.documentsChanged,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.confidentiality_changed',
    );
  }

  /** 412 com a versão atual e `meta.current` (o processo atual, mascarado, e quem o alterou). */
  private async conflict(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    sentVersion: number,
    runtime: ProcessRuntime,
  ): Promise<ApiError> {
    const process = rows.process;
    const canSeeBudget = await this.panel.canSeeBudget(rows, runtime);
    const dto = await this.presenter.present(tx, process, canSeeBudget);
    const updatedBy =
      process.updatedById === null
        ? null
        : {
            id: process.updatedById,
            name:
              (await this.identity.userDisplayNames(tx, [process.updatedById])).get(
                process.updatedById,
              ) ?? process.updatedById,
          };
    const current: ProcessConflictCurrent = { ...dto, updatedBy };
    this.logger.warn(
      {
        event: 'process.confidentiality_change_conflict',
        processId: process.id,
        sentVersion,
        currentVersion: process.version,
        correlationId: requireRequestContext().correlationId,
      },
      'process.confidentiality_change_conflict',
    );
    return processVersionConflict(sentVersion, current);
  }
}
