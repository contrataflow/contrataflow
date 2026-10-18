import type {
  DocumentStatus,
  SectionRequirement,
  SectionState,
  SystemDocumentModule,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { documentNotFound } from './document.errors.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTypeRepository } from './ports.js';
import { isEditable } from '../domain/document.js';

/*
 * Alvo de uma geração com IA (US-115 · POL-18 → POL-02 · V-05..V-07): o `ai` (nível 5) pergunta ao
 * dono do documento, por LEITURA, se o usuário da requisição pode editar o alvo — permissão de
 * edição do tipo cobrindo o processo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE`, `TERM_UPDATE`),
 * custódia ou participação, processo editável, tipo permitido na etapa e documento em
 * `DRAFT`/`RETURNED`. Sem documento (mapa de riscos ainda não emitido — US-119), a mesma POL-02
 * sobre o processo e o tipo de sistema. Nada é gravado aqui.
 */

export interface AiDocumentTargetInput {
  readonly processId: string;
  /**
   * Tipo de sistema do alvo. `null` só com `documentId` (AI-05 da US-116: disponibilidade no
   * editor, sem o tipo escolhido) — vale o tipo do próprio documento.
   */
  readonly systemModule: SystemDocumentModule | null;
  readonly documentId: string | null;
}

export interface AiDocumentTarget {
  readonly processId: string;
  readonly documentId: string | null;
  readonly documentTypeCode: string;
  readonly documentStatus: DocumentStatus | null;
  readonly draftRevision: number | null;
  readonly templateVersionId: string | null;
  /** Revisão de cada seção do rascunho (concorrência do ajuste de seção — US-121). */
  readonly sectionRevisions: Readonly<Record<string, number>>;
  readonly isBudgetConfidential: boolean;
}

/**
 * O que o gerador de IA lê do documento alvo (US-117 · RN-AI-25/26): a versão de template fixada
 * (seções narrativas e o guia de redação — título, ajuda, base legal e texto padrão), o estado de
 * cada seção e os itens do documento. Sem conteúdo das seções nem pessoas.
 */
export interface AiDraftSource {
  readonly documentId: string;
  readonly processId: string;
  readonly documentTypeCode: string;
  readonly draftRevision: number;
  readonly template: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly sections: readonly {
      readonly key: string;
      readonly title: string;
      readonly order: number;
      readonly requirement: SectionRequirement;
      readonly helpText: string | null;
      readonly legalBasis: string | null;
      /** `defaultContent` como texto puro. */
      readonly defaultText: string | null;
      readonly maxChars: number;
      readonly allowNarrative: boolean;
    }[];
  } | null;
  readonly sectionStates: Readonly<Record<string, SectionState>>;
  /** Linhas de item do documento (DOC-06): Decimal(18,4) como string. */
  readonly items: readonly { readonly processItemId: string; readonly quantity: string }[];
}

const TYPE_MISMATCH = 'O documento não corresponde ao tipo escolhido.';

@Injectable()
export class DocumentAiTargets {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async resolve(tx: TenantTx, input: AiDocumentTargetInput): Promise<AiDocumentTarget> {
    return input.documentId === null
      ? this.withoutDocument(tx, input)
      : this.withDocument(tx, input, input.documentId);
  }

  private async withDocument(
    tx: TenantTx,
    input: AiDocumentTargetInput,
    documentId: string,
  ): Promise<AiDocumentTarget> {
    const document = await this.documents.findById(tx, documentId);
    // Inexistente ou de outro tenant (RLS): 404 sem revelar nada; de outro processo do tenant: 422.
    if (document?.deletedAt !== null) throw documentNotFound();
    if (document.processId !== input.processId) {
      throw validationError([
        {
          field: 'documentId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Documento não encontrado neste processo.',
        },
      ]);
    }
    const context = await this.lifecycle.loadFor(tx, document);
    if (input.systemModule !== null && context.type.systemModule !== input.systemModule) {
      throw validationError([{ field: 'documentId', code: 'NOT_ALLOWED', message: TYPE_MISMATCH }]);
    }
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    if (!isEditable(document)) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: 'O documento não pode ser editado no status atual.',
        extensions: { status: document.status },
      });
    }
    return {
      processId: document.processId,
      documentId: document.id,
      documentTypeCode: context.type.code,
      documentStatus: document.status,
      draftRevision: document.draftRevision,
      templateVersionId: document.templateVersionId,
      sectionRevisions: Object.fromEntries(
        Object.entries(document.draftContent.sections).map(([key, section]) => [
          key,
          section.revision,
        ]),
      ),
      isBudgetConfidential: context.process.isBudgetConfidential,
    };
  }

  private async withoutDocument(
    tx: TenantTx,
    input: AiDocumentTargetInput,
  ): Promise<AiDocumentTarget> {
    const process = await this.processes.load(tx, input.processId);
    if (process === null) throw documentNotFound();
    if (input.systemModule === null) throw new Error('Alvo sem documento exige o tipo de sistema.');
    const type = (await this.types.list(tx)).find(
      (candidate) => candidate.systemModule === input.systemModule,
    );
    if (type === undefined)
      throw new Error(`Tipo de sistema ${input.systemModule} ausente no tenant.`);
    const context = { type, process };
    await this.lifecycle.authorizePol02(context, await this.lifecycle.actorOf(context), 'edit');
    return {
      processId: process.id,
      documentId: null,
      documentTypeCode: type.code,
      documentStatus: null,
      draftRevision: null,
      templateVersionId: null,
      sectionRevisions: {},
      isBudgetConfidential: process.isBudgetConfidential,
    };
  }
}
