import {
  documentAiReviewResultSchema,
  documentAiReviewSchema,
  documentCancelSchema,
  documentIdParamsSchema,
  documentMetaSchema,
  documentReopenSchema,
  documentSchema,
  documentTransitionSchema,
  documentUpdateSchema,
  documentUploadVersionSchema,
  documentValidationSchema,
  documentVersionCompareQuerySchema,
  documentVersionComparisonSchema,
  documentVersionCreateSchema,
  documentVersionListQuerySchema,
  documentVersionSchema,
  documentVersionSummarySchema,
  dataEnvelope,
  pageEnvelope,
} from '@contrataflow/validation';
import type {
  DocumentAiReview,
  DocumentAiReviewResultDto,
  DocumentCancel,
  DocumentDto,
  DocumentMeta,
  DocumentReopen,
  DocumentTransition,
  DocumentUpdate,
  DocumentUploadVersion,
  DocumentValidationDto,
  DocumentVersionCompareQuery,
  DocumentVersionComparisonDto,
  DocumentVersionCreate,
  DocumentVersionDto,
  DocumentVersionListQuery,
  DocumentVersionSummaryDto,
} from '@contrataflow/validation';
import { Controller, Delete, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import type { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { SaveDocumentVersionCommand } from '../application/document-version.commands.js';
import { DocumentVersionQueries } from '../application/document-version.queries.js';
import {
  CancelDocumentCommand,
  DeleteDocumentCommand,
  FinalizeDocumentCommand,
  ReopenDocumentCommand,
  SubmitDocumentCommand,
  UpdateDocumentHeaderCommand,
} from '../application/document.commands.js';
import { DocumentQueries } from '../application/document.queries.js';
import { toDocumentDto } from '../application/document.view.js';
import { ReviewAiContentCommand } from '../application/review-ai-content.command.js';
import { UploadDocumentVersionCommand } from '../application/uploaded-document.commands.js';
import type { DocumentType } from '../domain/document-type.js';
import type { Document } from '../domain/document.js';

const TAGS = ['Documentos'];

/** `{ data: Document, meta: { allowedActions } }` (api.md §1.5) + `ETag: "<version>"`. */
const DOCUMENT_RESPONSE = z.object({ data: documentSchema, meta: documentMetaSchema });

type DocumentResponse = DataResult<DocumentDto, DocumentMeta>;

/**
 * POL-02 depende do TIPO do documento (`DOCUMENT_*` nos livres/externos, `DFD_*`/`ETP_*`/… nos
 * tipados — permissions.md §2.2/§2.3): o caso de uso confere a permissão cobrindo o processo, a
 * custódia/participação, a etapa e o status (`DocumentLifecycleService.authorizePol02`).
 */
const TYPE_PERMISSION =
  'Permissão de edição/submissão do tipo do documento (DOCUMENT_*, DFD_*, ETP_*, TERM_*, RISK_*, PRICE_RESEARCH_*) conferida pelo caso de uso sobre o processo do documento, com POL-02.';

/**
 * DOC-03/04/08/09/10/12/13/14 (api/03-documents.md · US-065): o documento genérico e o seu ciclo de
 * vida (DEC-018). Toda transição de `status` passa pelo `DocumentLifecycleService` (RN-DOC-41) —
 * nenhum `PATCH` muda o status. Documento de outro tenant/processo não visível → 404.
 */
@Controller('documents')
@TenantScope('TENANT')
export class DocumentController {
  constructor(
    private readonly queries: DocumentQueries,
    private readonly updateHeader: UpdateDocumentHeaderCommand,
    private readonly finalize: FinalizeDocumentCommand,
    private readonly submit: SubmitDocumentCommand,
    private readonly reopen: ReopenDocumentCommand,
    private readonly cancel: CancelDocumentCommand,
    private readonly remove: DeleteDocumentCommand,
    private readonly versions: DocumentVersionQueries,
    private readonly saveVersion: SaveDocumentVersionCommand,
    private readonly reviewAi: ReviewAiContentCommand,
    private readonly uploadVersion: UploadDocumentVersionCommand,
  ) {}

  private respond(
    result: {
      readonly document: Document;
      readonly type: DocumentType;
      readonly allowedActions: DocumentMeta['allowedActions'];
    },
    response: HttpResponse,
  ): DocumentResponse {
    response.setHeader('ETag', `"${result.document.version}"`);
    return new DataResult(toDocumentDto(result.document, result.type), {
      allowedActions: result.allowedActions,
    });
  }

  @Get(':id')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-03',
    summary: 'Consultar documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Documento com o rascunho de trabalho e `meta.allowedActions` (`ETag` = versão).',
        schema: DOCUMENT_RESPONSE,
      },
    },
  })
  async getDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    return this.respond(await this.queries.get(params.id), response);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(TYPE_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-04',
    summary: 'Atualizar dados do documento',
    tags: TAGS,
    auditActions: ['document.draft_update'],
    responses: {
      200: {
        description: 'Título/responsável do rascunho atualizados (novo `ETag`); sem versão nova.',
        schema: DOCUMENT_RESPONSE,
      },
    },
  })
  async updateDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentUpdateSchema) body: DocumentUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    const result = await this.updateHeader.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      patch: body,
    });
    return this.respond(result, response);
  }

  @Get(':id/validation')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-08',
    summary: 'Consultar validação de completude do documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Pendências bloqueantes e avisos (regras genéricas + módulo tipado) num único `violations[]`.',
        schema: dataEnvelope(documentValidationSchema),
      },
    },
  })
  getValidation(
    @ZodParams(documentIdParamsSchema) params: { id: string },
  ): Promise<DocumentValidationDto> {
    return this.queries.validation(params.id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @ImplicitAccess(TYPE_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-09',
    summary: 'Submeter documento',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.submit', 'document.version_create', 'approval.request'],
    responses: {
      200: {
        description:
          'Documento em `IN_REVIEW` com a versão `SUBMISSION` e a aprovação avulsa em `pendingApprovalId`.',
        schema: DOCUMENT_RESPONSE,
      },
    },
  })
  async submitDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentTransitionSchema) body: DocumentTransition,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    const result = await this.submit.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      acknowledgedWarnings: body.acknowledgedWarnings ?? [],
      idempotencyKey: idempotencyKey ?? null,
    });
    return this.respond(result, response);
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @ImplicitAccess(TYPE_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-10',
    summary: 'Finalizar documento',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.finalize', 'document.version_create'],
    responses: {
      200: {
        description: 'Documento `FINALIZED` com a versão `FINALIZATION`; edição bloqueada.',
        schema: DOCUMENT_RESPONSE,
      },
    },
  })
  async finalizeDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentTransitionSchema) body: DocumentTransition,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    const result = await this.finalize.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      acknowledgedWarnings: body.acknowledgedWarnings ?? [],
      idempotencyKey: idempotencyKey ?? null,
    });
    return this.respond(result, response);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DOCUMENT_REOPEN')
  @Policy('POL-11')
  @ApiOperation({
    operationId: 'DOC-12',
    summary: 'Reabrir documento',
    tags: TAGS,
    auditActions: ['document.reopen'],
    responses: {
      200: {
        description:
          'Documento de volta a `DRAFT`, com o rascunho a partir da última versão (sem versão nova).',
        schema: DOCUMENT_RESPONSE,
      },
    },
  })
  async reopenDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentReopenSchema) body: DocumentReopen,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    const result = await this.reopen.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      reason: body.reopenReason,
    });
    return this.respond(result, response);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DOCUMENT_CANCEL')
  @Policy('POL-01')
  @ApiOperation({
    operationId: 'DOC-13',
    summary: 'Cancelar documento',
    tags: TAGS,
    auditActions: ['document.cancel'],
    responses: {
      200: { description: 'Documento `CANCELED` (final).', schema: DOCUMENT_RESPONSE },
    },
  })
  async cancelDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentCancelSchema) body: DocumentCancel,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentResponse> {
    const result = await this.cancel.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      reason: body.cancellationReason,
    });
    return this.respond(result, response);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireIfMatch()
  @ImplicitAccess(TYPE_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-14',
    summary: 'Excluir documento (rascunho)',
    tags: TAGS,
    auditActions: ['document.delete'],
    responses: {
      204: { description: 'Rascunho nunca submetido excluído (exclusão lógica — DEC-034).' },
    },
  })
  async deleteDocument(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ documentId: params.id, expectedVersion: ifMatch?.value ?? 0 });
  }

  // --- Conteúdo gerado por IA (US-122 · DOC-27) ----------------------------------------------

  @Post(':id/ai-review')
  @HttpCode(200)
  @ImplicitAccess(
    'Permissão de EDIÇÃO do tipo do documento (DFD_UPDATE, ETP_UPDATE, RISK_MANAGE, TERM_UPDATE…) conferida pelo caso de uso sobre o processo, com POL-02; AI_GENERATE não é exigida.',
  )
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-27',
    summary: 'Marcar seções geradas por IA como revisadas',
    tags: TAGS,
    auditActions: ['ai.content_review'],
    responses: {
      200: {
        description:
          'Seções revisadas (`reviewedAt/By`, `revision + 1`); seções sem proveniência pendente são ignoradas (idempotente). A concorrência é por seção (`expectedRevisions`): divergência → 412 `VERSION_CONFLICT` com `meta.current`.',
        schema: dataEnvelope(documentAiReviewResultSchema),
      },
    },
  })
  async reviewAiContent(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentAiReviewSchema) body: DocumentAiReview,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentAiReviewResultDto> {
    const result = await this.reviewAi.execute({
      documentId: params.id,
      sectionKeys: body.sectionKeys,
      expectedRevisions: body.expectedRevisions,
      confirmAll: body.confirmAll ?? false,
    });
    response.setHeader('ETag', `"${result.document.version}"`);
    return {
      document: toDocumentDto(result.document, result.type),
      reviewedSectionKeys: [...result.reviewedSectionKeys],
    };
  }

  // --- Versões (US-066 · DOC-15/16/18) -------------------------------------------------------

  @Get(':id/versions')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-15',
    summary: 'Listar versões do documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Versões imutáveis por `versionNumber` desc (RN-DOC-59), sem o snapshot: motivo, status na criação, autor, data, resumo e `contentHash` (`attachmentId` nos externos).',
        schema: pageEnvelope(documentVersionSummarySchema),
      },
    },
  })
  listVersions(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodQuery(documentVersionListQuerySchema) query: DocumentVersionListQuery,
  ): Promise<PageResult<DocumentVersionSummaryDto>> {
    return this.versions.list(params.id, query);
  }

  @Post(':id/versions')
  @Idempotent()
  @ImplicitAccess(TYPE_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-16',
    summary: 'Criar versão manual do documento',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.version_create'],
    responses: {
      201: {
        description:
          'Versão `MANUAL` (snapshot + `contentHash` SHA-256 do JSON canônico — RFC 8785) do rascunho em `DRAFT`/`RETURNED`, sem mudar o status. Tipo `UPLOADED` → 422 `NOT_ALLOWED` (use DOC-19); fora de edição → 409 `DOCUMENT_NOT_EDITABLE`.',
        schema: dataEnvelope(documentVersionSchema),
      },
    },
  })
  async createVersion(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentVersionCreateSchema) body: DocumentVersionCreate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentVersionDto> {
    const summary = body.changeSummary ?? '';
    const created = await this.saveVersion.execute({
      documentId: params.id,
      changeSummary: summary === '' ? null : summary,
    });
    response.setHeader('Location', `/api/v1/document-versions/${created.id}`);
    return created;
  }

  // --- Documento externo (US-064 · DOC-19) ---------------------------------------------------

  @Post(':id/upload-version')
  @Idempotent()
  @RequireIfMatch()
  @RateLimit('upload')
  @RequirePermission('DOCUMENT_UPDATE')
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-19',
    summary: 'Enviar nova versão do arquivo (upload)',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document.version_create'],
    responses: {
      201: {
        description:
          'Versão `UPLOAD` do documento externo a partir do anexo `AVAILABLE` dele (`content` nulo, `contentHash` = SHA-256 do arquivo), sem mudar o status; o documento passa a apontá-la (novo `ETag` no DOC-03). Anexo inexistente/de outro tenant/de outro alvo → 422 `REFERENCE_NOT_FOUND` em `attachmentId`; em varredura, infectado ou rejeitado → 409 `ATTACHMENT_NOT_AVAILABLE`; documento fora de `DRAFT`/`RETURNED` → 409 `DOCUMENT_NOT_EDITABLE`; tipo não `UPLOADED` → 422 `NOT_ALLOWED`; `If-Match` divergente → 412.',
        schema: dataEnvelope(documentVersionSchema),
      },
    },
  })
  async uploadDocumentVersion(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentUploadVersionSchema) body: DocumentUploadVersion,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentVersionDto> {
    const summary = body.changeSummary ?? '';
    const created = await this.uploadVersion.execute({
      documentId: params.id,
      expectedVersion: ifMatch?.value ?? 0,
      attachmentId: body.attachmentId,
      changeSummary: summary === '' ? null : summary,
    });
    response.setHeader('Location', `/api/v1/document-versions/${created.id}`);
    return created;
  }

  @Get(':id/versions/compare')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-18',
    summary: 'Comparar versões do documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Diferenças entre duas versões do documento em `header` (por campo), `sections` (por `sectionKey`) e `collections` (por chave natural), cada entrada `ADDED`/`REMOVED`/`CHANGED`/`UNCHANGED`, ou `MASKED` para campo sigiloso de quem não atende POL-09. Versões de outro documento/inexistentes → 422 `REFERENCE_NOT_FOUND`; iguais → 422.',
        schema: dataEnvelope(documentVersionComparisonSchema),
      },
    },
  })
  compareVersions(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodQuery(documentVersionCompareQuerySchema) query: DocumentVersionCompareQuery,
  ): Promise<DocumentVersionComparisonDto> {
    return this.versions.compare(params.id, query);
  }
}
