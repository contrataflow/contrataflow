import { localDateOf } from '@contrataflow/types';
import { DFD_MESSAGES, dfdDocumentTitle } from '@contrataflow/validation';
import type { DfdDto, DfdMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { toDfdDto, toDfdMeta } from './dfd.presenter.js';
import { DFD_CLOCK, DFD_REPOSITORY, DFD_TRANSACTIONS } from './ports.js';
import type { DfdClock, DfdRepository, DfdTransactions } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
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
    private readonly documents: DocumentFacade,
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
    const created = await this.createDocument(tx, input);
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

  /** O documento tipado; 409 com a mensagem e o DFD existente (FA-02 · V-02). */
  private async createDocument(tx: TenantTx, input: CreateDfdInput) {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'DFD',
        templateId: input.templateId,
        titleOf: (process) => dfdDocumentTitle(process.title),
        messages: {
          templateInvalid: DFD_MESSAGES.templateInvalid,
          notCustodian: DFD_MESSAGES.notCustodian,
        },
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') throw await this.alreadyExists(tx, error);
      if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        throw new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: DFD_MESSAGES.typeNotAllowedInStage,
        });
      }
      throw error;
    }
  }

  /**
   * O DFD que já ocupa a vaga (verificação prévia — com o código para o "Abrir DFD"); na corrida
   * decidida pelo índice único o `tx` já falhou no banco e o 409 vai sem o código.
   */
  private async alreadyExists(tx: TenantTx, error: ApiError): Promise<ApiError> {
    const meta = (error.extensions.meta ?? {}) as { existingDocumentId?: string };
    const existingId = meta.existingDocumentId ?? null;
    const existing =
      existingId === null
        ? undefined
        : (await this.documents.documentStatesIn(tx, [existingId])).get(existingId);
    return new ApiError('DOCUMENT_ALREADY_EXISTS', {
      detail: DFD_MESSAGES.alreadyExists(existing?.code ?? null),
      extensions:
        existing === undefined
          ? {}
          : {
              meta: {
                existingDocumentId: existing.id,
                existingDfdId: existing.id,
                code: existing.code,
              },
            },
    });
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
