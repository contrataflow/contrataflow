import {
  dataEnvelope,
  documentVersionIdParamsSchema,
  documentVersionSchema,
} from '@contrataflow/validation';
import type { DocumentVersionDto } from '@contrataflow/validation';
import { Controller, Get } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { DocumentVersionQueries } from '../application/document-version.queries.js';

/**
 * DOC-17 (api/03-documents.md · US-066): uma versão imutável com o snapshot completo. Versão de
 * outro tenant ou de documento de processo não visível → 404; campos monetários de processo
 * sigiloso seguem POL-09 (`null` + `<campo>Masked: true`).
 */
@Controller('document-versions')
@TenantScope('TENANT')
export class DocumentVersionController {
  constructor(private readonly versions: DocumentVersionQueries) {}

  @Get(':versionId')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-17',
    summary: 'Consultar versão do documento',
    tags: ['Documentos'],
    responses: {
      200: {
        description:
          'Versão com `content` (snapshot completo cujo SHA-256 canônico é o `contentHash`; nulo para `UPLOADED`); valores sigilosos mascarados conforme POL-09.',
        schema: dataEnvelope(documentVersionSchema),
      },
    },
  })
  getVersion(
    @ZodParams(documentVersionIdParamsSchema) params: { versionId: string },
  ): Promise<DocumentVersionDto> {
    return this.versions.get(params.versionId);
  }
}
