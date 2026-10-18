import {
  dataEnvelope,
  documentSectionParamsSchema,
  documentSectionSavedSchema,
  documentSectionSaveSchema,
  sectionEtag,
} from '@contrataflow/validation';
import type {
  DocumentSectionParams,
  DocumentSectionSave,
  DocumentSectionSavedDto,
} from '@contrataflow/validation';
import { Controller, HttpCode, Put, Res } from '@nestjs/common';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { SaveDocumentSectionCommand } from '../application/save-document-section.command.js';

const TAGS = ['Documentos'];

const EDIT_ACCESS =
  'Permissão de EDIÇÃO do tipo do documento (DOCUMENT_UPDATE, DFD_UPDATE, ETP_UPDATE, TERM_UPDATE…) cobrindo o processo + custódia ou participação COLLABORATOR/CONSULTANT (403 NOT_PROCESS_CUSTODIAN com access.denied) + processo em DRAFT/IN_PROGRESS/RETURNED + tipo permitido na etapa (POL-02), conferidos pelo caso de uso a cada gravação (RN-DFD-30).';

/**
 * DOC-05 (api/03-documents.md · US-015): o autosave genérico de seção — DFD, ETP (US-020), TR
 * (US-036) e documentos livres (US-063) usam a mesma rota. `If-Match: "s<revision>"` é a revisão
 * da SEÇÃO (api.md §1.3), não a versão do documento; classe de limite `autosave` (60/min por
 * usuário + documento — api.md §1.6).
 */
@Controller('documents')
@TenantScope('TENANT')
export class DocumentSectionsController {
  constructor(private readonly saveSection: SaveDocumentSectionCommand) {}

  @Put(':id/sections/:sectionKey')
  @HttpCode(200)
  @RequireIfMatch()
  @RateLimit('autosave', { keyParam: 'id' })
  @ImplicitAccess(EDIT_ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-05',
    summary: 'Salvar seção do documento (autosave)',
    tags: TAGS,
    auditActions: ['document.draft_update'],
    responses: {
      200: {
        description:
          'Seção gravada numa atualização condicional atômica (documento em `DRAFT`/`RETURNED` e a revisão da seção igual à do `If-Match`): estado derivado no servidor (`FILLED`/`EMPTY`, ou `NOT_APPLICABLE` com justificativa), `revision + 1` e `draftRevision + 1` — `Document.version` NÃO muda (RN-DFD-26) e nenhuma versão é criada (DEC-017). `ETag: "s<revision>"`. Reenvio idêntico = 200 com a revisão atual, sem gravar (RN-DFD-36). Erros: 412 `SECTION_REVISION_CONFLICT` com `meta.current` (seção atual, autor e horário), 428 `PRECONDITION_REQUIRED`, 409 `DOCUMENT_NOT_EDITABLE` (`meta.status`/`statusSince`)/`INVALID_PROCESS_STATUS`, 403 `NOT_PROCESS_CUSTODIAN`/`PERMISSION_DENIED`, 422 `SECTION_NOT_IN_TEMPLATE`/`RICH_TEXT_INVALID`/`DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`/`VALIDATION_ERROR` (`TOO_LONG`), 413 `PAYLOAD_TOO_LARGE` (> 1 MB), 429 `RATE_LIMITED`, 404 `NOT_FOUND`. Auditoria `document.draft_update` coalescida (1 por documento/seção/usuário a cada 10 min) ou imediata em "Manter a minha versão" (`overwrittenRevision`).',
        schema: dataEnvelope(documentSectionSavedSchema),
      },
    },
  })
  async save(
    @ZodParams(documentSectionParamsSchema) params: DocumentSectionParams,
    @ZodBody(documentSectionSaveSchema) body: DocumentSectionSave,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentSectionSavedDto> {
    const result = await this.saveSection.save({
      documentId: params.id,
      sectionKey: params.sectionKey,
      // `"7"` (versão) no lugar de `"s7"` nunca casa com uma revisão de seção: 412.
      expectedRevision: ifMatch?.kind === 'section' ? ifMatch.value : -1,
      content: body.content,
      notApplicable: body.notApplicable === true || body.state === 'NOT_APPLICABLE',
      justification: body.justification ?? null,
      overwrittenRevision: body.overwrittenRevision ?? null,
    });
    response.setHeader('ETag', sectionEtag(result.saved.revision));
    response.setHeader('Cache-Control', 'no-store');
    return result.saved;
  }
}
