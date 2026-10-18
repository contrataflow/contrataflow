import { RISK_MAP_MESSAGES, RISK_MAP_TITLE } from '@contrataflow/validation';
import type { DocumentDto, DocumentMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { RISK_CLOCK, RISK_REPOSITORY, RISK_TRANSACTIONS } from './ports.js';
import type { RiskClock, RiskRepository, RiskTransactions } from './ports.js';
import { RiskCommand, logContext } from './risk.commands.js';
import { DocumentFacade, toDocumentDto } from '../../document/application/document.facade.js';
import type { CreatedStructuredDocument } from '../../document/application/document.facade.js';
import { riskMapViolations } from '../domain/risk-map.js';

/*
 * RSK-10 — Emitir o Mapa de Riscos (US-035 · RN-RISK-19): UMA transação do tenant com o padrão de
 * documento tipado do `document` (`createStructuredIn`: template padrão publicado do `RISK_MAP` —
 * US-110 —, `RISK_MANAGE` + POL-02 com custódia OU participação — a mesma condição de RN-RISK-09
 * —, processo editável, tipo na etapa, singular — 409 —, número, `document.create`,
 * `DocumentCreated` — `document.created.risk_map` — e a timeline `DOCUMENT_CREATED`). Sem nenhum
 * risco no processo → 422 `BUSINESS_RULE_VIOLATION` (`RISK_LIST_EMPTY` — FA-02), só para quem pode
 * criar. O conteúdo tipado são os riscos VIGENTES: nada é copiado na criação; o snapshot nasce na
 * submissão/finalização (RN-RISK-20 — `RiskMapDocumentValidator`).
 */

let createdCounter: Counter | undefined;

function countCreated(): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('risk_map_created_total', { description: 'Mapas de Riscos emitidos (RSK-10).' });
  createdCounter.add(1);
}

export interface CreateRiskMapInput {
  readonly processId: string;
  readonly idempotencyKey: string | null;
}

export interface CreatedRiskMap {
  readonly dto: DocumentDto;
  readonly meta: DocumentMeta;
}

@Injectable()
export class CreateRiskMapCommand extends RiskCommand<CreateRiskMapInput, CreatedRiskMap> {
  constructor(
    @Inject(RISK_TRANSACTIONS) transactions: RiskTransactions,
    @Inject(RISK_CLOCK) clock: RiskClock,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly documents: DocumentFacade,
  ) {
    // O nome do comando dá o span e o log `document.create_failed`.
    super('document.create', transactions, clock);
  }

  protected async handle(tx: TenantTx, input: CreateRiskMapInput): Promise<CreatedRiskMap> {
    const created = await this.createDocument(tx, input);
    return {
      dto: toDocumentDto(created.document, created.type),
      meta: { allowedActions: created.allowedActions },
    };
  }

  private async createDocument(
    tx: TenantTx,
    input: CreateRiskMapInput,
  ): Promise<CreatedStructuredDocument> {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'RISK_MAP',
        titleOf: () => RISK_MAP_TITLE,
        messages: {
          templateInvalid: RISK_MAP_MESSAGES.templateInvalid,
          notCustodian: RISK_MAP_MESSAGES.createDenied,
        },
        idempotencyKey: input.idempotencyKey,
        allowCollaborators: true,
        beforeCreate: async (process) => {
          const risks = await this.risks.listByProcess(tx, process.id, {});
          if (risks.length > 0) return;
          throw new ApiError('BUSINESS_RULE_VIOLATION', {
            detail: RISK_MAP_MESSAGES.listEmpty,
            violations: riskMapViolations([]),
          });
        },
        auditChanges: [{ path: 'documentTypeCode', old: null, new: 'RISK_MAP' }],
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') {
        // FA-01: o existente (verificação prévia) vai em `meta` para o "Abrir o Mapa de Riscos".
        throw new ApiError('DOCUMENT_ALREADY_EXISTS', {
          detail: RISK_MAP_MESSAGES.alreadyExists,
          extensions: error.extensions,
        });
      }
      if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        throw new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: RISK_MAP_MESSAGES.typeNotAllowedInStage,
          extensions: error.extensions,
        });
      }
      throw error;
    }
  }

  protected override committed(result: CreatedRiskMap, durationMs: number): void {
    countCreated();
    this.logger.log(
      {
        event: 'document.created',
        documentId: result.dto.id,
        documentTypeCode: 'RISK_MAP',
        durationMs,
        ...logContext(),
      },
      'document.created',
    );
  }
}
