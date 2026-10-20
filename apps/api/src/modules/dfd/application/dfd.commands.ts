import { localDateOf } from '@contrataflow/types';
import type { DfdDto, DfdMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DfdDocumentCreator } from './dfd-document.creator.js';
import { toDfdDto, toDfdMeta } from './dfd.presenter.js';
import { DFD_CLOCK, DFD_REPOSITORY, DFD_TRANSACTIONS } from './ports.js';
import type { DfdClock, DfdRepository, DfdTransactions } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { createDfdFromProcess } from '../domain/dfd.js';

/*
 * DFD-02 — Criar DFD a partir de template (US-014 · fluxo principal 4.1–4.8): UMA transação do
 * tenant com o padrão de documento tipado do `document` (`createStructuredIn`: template publicado,
 * `DFD_CREATE` + POL-01/02, singular — 409 —, número na mesma transação, `document.create`,
 * `DocumentCreated` — `document.created.dfd` — e a timeline `DOCUMENT_CREATED`) seguido do cabeçalho
 * tipado `Dfd` com os valores do processo (RN-DFD-05). Qualquer falha desfaz tudo, inclusive o
 * incremento da sequência (RN-DFD-04). Não notifica (RN-DFD-22). Logs sem textos do DFD.
 */

let createdCounter: Counter | undefined;

/** `dfd_created_total` (DoD da US-014). */
function countCreated(): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('dfd_created_total', { description: 'DFDs criados (DFD-02).' });
  createdCounter.add(1);
}

export interface CreateDfdInput {
  readonly processId: string;
  readonly templateId: string | null;
  readonly idempotencyKey: string | null;
}

export interface CreatedDfd {
  readonly dto: DfdDto;
  readonly meta: DfdMeta;
  readonly templateVersionId: string;
  readonly processId: string;
}

interface Prepared {
  readonly now: Date;
}

@Injectable()
export class CreateDfdCommand extends TransactionalCommandHandler<
  CreateDfdInput,
  Prepared,
  CreatedDfd
> {
  constructor(
    @Inject(DFD_TRANSACTIONS) transactions: DfdTransactions,
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    @Inject(DFD_CLOCK) private readonly clock: DfdClock,
    private readonly documentCreator: DfdDocumentCreator,
    private readonly processes: ProcessFacade,
    private readonly numbering: NumberingFacade,
  ) {
    super('dfd.create', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: CreateDfdInput,
    { now }: Prepared,
  ): Promise<CreatedDfd> {
    const created = await this.documentCreator.create(tx, input);
    const { document, process } = created;
    const defaults = await this.processes.dfdDefaultsIn(tx, process.id);
    if (defaults === null) throw new Error(`Processo ${process.id} sem agregado no tenant.`);
    const { timezone } = await this.numbering.settingsOf(tx);
    const dfd = createDfdFromProcess(
      {
        id: process.id,
        requestingDepartmentId: process.requestingDepartmentId,
        object: process.object,
        ...defaults,
      },
      {
        documentId: document.id,
        tenantId: document.tenantId,
        creatorId: document.createdById,
        today: localDateOf(now, timezone),
        now,
      },
    );
    await this.dfds.insert(tx, dfd);
    return {
      dto: toDfdDto(dfd, document, { masked: false }),
      meta: toDfdMeta(created.template, created.allowedActions),
      templateVersionId: created.template.id,
      processId: process.id,
    };
  }

  protected override committed(result: CreatedDfd, durationMs: number): void {
    countCreated();
    const context = requireRequestContext();
    this.logger.log(
      {
        event: 'dfd.created',
        dfdId: result.dto.id,
        documentId: result.dto.documentId,
        code: result.dto.code,
        templateVersionId: result.templateVersionId,
        processId: result.processId,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'dfd.created',
    );
  }
}
