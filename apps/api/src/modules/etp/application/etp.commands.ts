import { ETP_MESSAGES, etpDocumentTitle } from '@contrataflow/validation';
import type { EtpDto, EtpMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { toEtpDto, toEtpMeta } from './etp.presenter.js';
import { ETP_CLOCK, ETP_REPOSITORY, ETP_TRANSACTIONS } from './ports.js';
import type { EtpClock, EtpRepository, EtpTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  CreatedStructuredDocument,
  ImportableDfdSource,
} from '../../document/application/document.facade.js';
import { createEtp, planDfdImport } from '../domain/etp.js';
import type { DfdImportPlan } from '../domain/etp.js';

/*
 * ETP-02 — Criar ETP a partir de template com importação opcional do DFD (US-019 · fluxo principal
 * 5.1–5.7): UMA transação do tenant (RN-ETP-09) com o padrão de documento tipado do `document`
 * (`createStructuredIn`: template publicado, `ETP_CREATE` + POL-02 com custódia OU participação —
 * RN-ETP-07 —, processo editável, tipo na etapa, singular — 409 —, número, `document.create`,
 * `DocumentCreated` — `document.created.etp` = `ETPCreated` — e a timeline `DOCUMENT_CREATED`), as
 * seções importadas do DFD (RN-ETP-05), as linhas de item do DFD (RN-ETP-06) e o cabeçalho `Etp`.
 * Qualquer falha desfaz tudo, inclusive o número. Não notifica. Logs sem objeto, seções nem valores.
 */

let createdCounter: Counter | undefined;

function countCreated(): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('etp_created_total', { description: 'ETPs criados (ETP-02).' });
  createdCounter.add(1);
}

export interface CreateEtpInput {
  readonly processId: string;
  readonly importFromDfd: boolean;
  readonly idempotencyKey: string | null;
}

export interface CreatedEtp {
  readonly dto: EtpDto;
  readonly meta: EtpMeta;
}

interface Prepared {
  readonly now: Date;
}

/** V-04: `importFromDfd = true` sem DFD elegível (RN-ETP-04). */
function noEligibleDfd(): ApiError {
  return validationError([
    { field: 'importFromDfd', code: 'NOT_ALLOWED', message: ETP_MESSAGES.noEligibleDfd },
  ]);
}

@Injectable()
export class CreateEtpCommand extends TransactionalCommandHandler<
  CreateEtpInput,
  Prepared,
  CreatedEtp
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    @Inject(ETP_CLOCK) private readonly clock: EtpClock,
    private readonly documents: DocumentFacade,
  ) {
    // O nome do comando dá o span e o log `document.create_failed` ("Logs" da US-019).
    super('document.create', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: CreateEtpInput,
    { now }: Prepared,
  ): Promise<CreatedEtp> {
    // 5.5 (leitura): o DFD elegível e o plano da importação. A recusa (V-04) só sai depois da
    // autorização (`beforeCreate`): quem não pode criar recebe o 403/404, nunca o 422.
    const source = input.importFromDfd
      ? await this.documents.importableDfdIn(tx, input.processId)
      : null;
    const plan = source === null ? null : planDfdImport(source.snapshot);

    const created = await this.createDocument(tx, input, source, plan);
    const { document } = created;
    const itemsCount =
      plan === null || plan.items.length === 0
        ? 0
        : await this.documents.copyItemsIn(
            tx,
            document,
            plan.items.map((item) => ({ ...item, notes: null })),
          );
    const etp = createEtp({
      documentId: document.id,
      tenantId: document.tenantId,
      processId: document.processId,
      importedFromDfdVersionId: source?.versionId ?? null,
      creatorId: document.createdById,
      now,
    });
    await this.etps.insert(tx, etp);
    return {
      dto: toEtpDto(etp, document, itemsCount),
      meta: toEtpMeta(created.allowedActions),
    };
  }

  /** 5.1–5.4 e 5.6 pelo `document`, com as mensagens e os códigos da US-019. */
  private async createDocument(
    tx: TenantTx,
    input: CreateEtpInput,
    source: ImportableDfdSource | null,
    plan: DfdImportPlan | null,
  ): Promise<CreatedStructuredDocument> {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'ETP',
        titleOf: (process) => etpDocumentTitle(process.code),
        messages: {
          templateInvalid: ETP_MESSAGES.templateInvalid,
          notCustodian: ETP_MESSAGES.notCustodian,
        },
        idempotencyKey: input.idempotencyKey,
        allowCollaborators: true,
        beforeCreate: () => {
          if (input.importFromDfd && source === null) throw noEligibleDfd();
        },
        ...(plan === null ? {} : { sectionContents: plan.sections }),
        auditChanges: [
          { path: 'documentTypeCode', old: null, new: 'ETP' },
          { path: 'importedFromDfdVersionId', old: null, new: source?.versionId ?? null },
        ],
        auditMetadata: {
          importedFromDfd: source !== null,
          importedItemsCount: plan?.items.length ?? 0,
        },
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') throw await this.alreadyExists(tx, error);
      if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        throw new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: ETP_MESSAGES.typeNotAllowedInStage,
        });
      }
      // V-03: o processo fora de DRAFT/IN_PROGRESS/RETURNED (api/06-etp.md ETP-02).
      if (error.code === 'INVALID_PROCESS_STATUS') {
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: ETP_MESSAGES.processNotEditable,
          extensions: error.extensions,
        });
      }
      throw error;
    }
  }

  /**
   * O ETP que já ocupa a vaga (verificação prévia — com o id para o "Abrir ETP"); na corrida decidida
   * pelo índice único o `tx` já falhou no banco e o 409 vai sem o id.
   */
  private async alreadyExists(tx: TenantTx, error: ApiError): Promise<ApiError> {
    const meta = (error.extensions.meta ?? {}) as { existingDocumentId?: string };
    const existingId = meta.existingDocumentId ?? null;
    const existing =
      existingId === null
        ? undefined
        : (await this.documents.documentStatesIn(tx, [existingId])).get(existingId);
    return new ApiError('DOCUMENT_ALREADY_EXISTS', {
      detail: ETP_MESSAGES.alreadyExists,
      extensions:
        existing === undefined
          ? {}
          : {
              meta: {
                existingDocumentId: existing.id,
                existingEtpId: existing.id,
                code: existing.code,
              },
            },
    });
  }

  protected override committed(result: CreatedEtp, durationMs: number): void {
    countCreated();
    const context = requireRequestContext();
    this.logger.log(
      {
        event: 'document.created',
        documentId: result.dto.documentId,
        documentTypeCode: 'ETP',
        importedFromDfd: result.dto.importedFromDfdVersionId !== null,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'document.created',
    );
  }
}
