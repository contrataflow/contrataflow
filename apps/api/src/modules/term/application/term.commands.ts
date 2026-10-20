import { TERM_MESSAGES, termDocumentTitle } from '@contrataflow/validation';
import type { TermDto, TermMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { PriceResearchSummaryRegistry } from '#shared/price-research/price-research-summary.js';
import type { PriceResearchSummary } from '#shared/price-research/price-research-summary.js';

import { TERM_CLOCK, TERM_REPOSITORY, TERM_TRANSACTIONS } from './ports.js';
import type { TermClock, TermRepository, TermTransactions } from './ports.js';
import { toTermDto, toTermMeta } from './term.presenter.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { CreatedStructuredDocument } from '../../document/application/document.facade.js';
import { createTermOfReference } from '../domain/term-of-reference.js';

/*
 * TRM-02 — Criar Termo de Referência (US-036 · fluxo principal 4.1–4.7): UMA transação do tenant com
 * o padrão de documento tipado do `document` (`createStructuredIn`: template ativo do tipo TR com
 * versão publicada — o padrão do tipo ou o escolhido (RN-TR-03) —, `TERM_CREATE` + POL-02 com a
 * CUSTÓDIA (participantes não criam — RN-TR-02), processo editável, tipo na etapa, TR único — 409
 * (RN-TR-01) —, número `TR 0003/2026` (RN-TR-04), rascunho de todas as seções (RN-TR-05), sigilo
 * `RESTRICTED` com orçamento sigiloso (RN-TR-09), `document.create`, `DocumentCreated` —
 * `document.created.tr` — e a timeline `DOCUMENT_CREATED`) e o cabeçalho `TermOfReference`
 * (RN-TR-06/07). Qualquer falha desfaz tudo, inclusive o número. Não notifica (RN-TR-15). Logs sem
 * objeto, seções nem valores.
 */

let createdCounter: Counter | undefined;

function countCreated(): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('document_created_total', { description: 'Documentos criados por tipo.' });
  createdCounter.add(1, { type: 'TR' });
}

export interface CreateTermInput {
  readonly processId: string;
  readonly templateId: string | null;
  readonly title: string | null;
  readonly idempotencyKey: string | null;
}

export interface CreatedTerm {
  readonly dto: TermDto;
  readonly meta: TermMeta;
}

interface Prepared {
  readonly now: Date;
}

/** RN-TR-07: a pesquisa concluída com total (o leitor só devolve concluída com total). */
function completedResearchOf(
  research: PriceResearchSummary | null,
): { readonly id: string; readonly totalEstimatedValue: string } | null {
  const total = research?.totalEstimatedValue ?? null;
  return research === null || total === null
    ? null
    : { id: research.id, totalEstimatedValue: total };
}

@Injectable()
export class CreateTermCommand extends TransactionalCommandHandler<
  CreateTermInput,
  Prepared,
  CreatedTerm
> {
  constructor(
    @Inject(TERM_TRANSACTIONS) transactions: TermTransactions,
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    @Inject(TERM_CLOCK) private readonly clock: TermClock,
    private readonly documents: DocumentFacade,
    private readonly researches: PriceResearchSummaryRegistry,
  ) {
    // O nome do comando dá o span e o log `term.create_failed` ("Logs" da US-036).
    super('term.create', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: CreateTermInput,
    { now }: Prepared,
  ): Promise<CreatedTerm> {
    // RN-TR-07 (leitura): a pesquisa concluída do processo. Só vira dado depois da autorização.
    const research = await this.researches.completedOf(tx, input.processId);
    const created = await this.createDocument(tx, input, research);
    const { document, template, process } = created;
    const term = createTermOfReference({
      documentId: document.id,
      tenantId: document.tenantId,
      processId: document.processId,
      processObject: process.object,
      fieldConfig: template.fieldConfig,
      completedResearch: completedResearchOf(research),
      creatorId: document.createdById,
      now,
    });
    await this.terms.insert(tx, term);
    // POL-09: quem cria é o custodiante (RN-TR-02), que vê o orçamento sigiloso.
    return {
      dto: toTermDto(term, document, template, { masked: false }),
      meta: toTermMeta(created.allowedActions),
    };
  }

  /** 4.1–4.7 pelo `document`, com as mensagens e os códigos da US-036. */
  private async createDocument(
    tx: TenantTx,
    input: CreateTermInput,
    research: PriceResearchSummary | null,
  ): Promise<CreatedStructuredDocument> {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'TERM_OF_REFERENCE',
        templateId: input.templateId,
        titleOf: (process) => input.title ?? termDocumentTitle(process.title),
        messages: {
          templateInvalid: TERM_MESSAGES.templateInvalid,
          notCustodian: TERM_MESSAGES.notCustodian,
        },
        idempotencyKey: input.idempotencyKey,
        // RN-TR-09: o TR contém o valor estimado.
        confidentialityOf: (process) => (process.isBudgetConfidential ? 'RESTRICTED' : undefined),
        auditMetadata: { priceResearchId: research?.id ?? null },
        auditChanges: [{ path: 'documentTypeCode', old: null, new: 'TR' }],
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw await this.translated(tx, error);
    }
  }

  private async translated(tx: TenantTx, error: ApiError): Promise<ApiError> {
    switch (error.code) {
      case 'DOCUMENT_ALREADY_EXISTS':
        return this.alreadyExists(tx, error);
      case 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE':
        return new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: TERM_MESSAGES.typeNotAllowedInStage,
          extensions: error.extensions,
        });
      case 'INVALID_PROCESS_STATUS':
        return new ApiError('INVALID_PROCESS_STATUS', {
          detail: TERM_MESSAGES.processNotEditable,
          extensions: error.extensions,
        });
      default:
        return error;
    }
  }

  /**
   * O TR que já ocupa a vaga (verificação prévia — com o id para o "Abrir TR existente"); na corrida
   * decidida pelo índice único o `tx` já falhou no banco e o 409 vai sem o id.
   */
  private async alreadyExists(tx: TenantTx, error: ApiError): Promise<ApiError> {
    const meta = (error.extensions.meta ?? {}) as { existingDocumentId?: string };
    const existingId = meta.existingDocumentId ?? null;
    const existing =
      existingId === null
        ? undefined
        : (await this.documents.documentStatesIn(tx, [existingId])).get(existingId);
    return new ApiError('DOCUMENT_ALREADY_EXISTS', {
      detail: TERM_MESSAGES.alreadyExists,
      extensions:
        existing === undefined
          ? {}
          : {
              meta: {
                existingDocumentId: existing.id,
                existingTermId: existing.id,
                code: existing.code,
              },
            },
    });
  }

  protected override committed(result: CreatedTerm, durationMs: number): void {
    countCreated();
    const context = requireRequestContext();
    this.logger.log(
      {
        event: 'term.created',
        termId: result.dto.id,
        documentId: result.dto.documentId,
        code: result.dto.code,
        templateVersionId: result.dto.templateVersion?.id ?? null,
        linkedPriceResearch: result.dto.priceResearchId !== null,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'term.created',
    );
  }
}
