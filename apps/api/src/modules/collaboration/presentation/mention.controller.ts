import {
  dataEnvelope,
  mentionCandidateSchema,
  mentionCandidatesQuerySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type { MentionCandidateDto, MentionCandidatesQuery } from '@contrataflow/validation';
import { Controller, Get, Param, Res } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { SearchMentionCandidatesQuery } from '../application/mention.queries.js';

/** Identificador do caminho que não é UUIDv7 = 400 `MALFORMED_REQUEST` (como em CMT-01..04). */
class ProcessIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = processIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

function ProcessId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id', new ProcessIdPipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', processIdParamsSchema);
    }
  };
}

const CANDIDATES_ACCESS =
  'COMMENT_CREATE cobrindo o processo (perfil com escopo ou participação — RN-CMT-07), conferida no caso de uso: sem permissão = 403 PERMISSION_DENIED com access.denied; processo não visível = 404 PROCESS_NOT_FOUND (DEC-024).';

/**
 * Candidatos de menção (api/12-comments-attachments.md CMT-05 · US-072): autocomplete do "@" no
 * compositor de comentários. A visibilidade do alvo é revalidada no commit do comentário.
 */
@Controller()
@TenantScope('TENANT')
export class MentionController {
  constructor(private readonly candidates: SearchMentionCandidatesQuery) {}

  @Get('processes/:id/mention-candidates')
  @ImplicitAccess(CANDIDATES_ACCESS)
  @ApiOperation({
    operationId: 'CMT-05',
    summary: 'Buscar candidatos de menção',
    tags: ['Comentários'],
    responses: {
      200: {
        description:
          'Até 10 candidatos em ordem alfabética (RN-CMT-21): usuários com vínculo ativo e visibilidade do processo (DEC-024 — `secondaryLabel` = unidade de lotação) e unidades ativas com visibilidade do processo e no máximo 50 membros ativos (`secondaryLabel` = sigla), filtrados por `q` (nome/e-mail ou nome/sigla, sem diferenciar maiúsculas nem acentos). `q` vazio → 422 `VALIDATION_ERROR`.',
        schema: dataEnvelope(z.array(mentionCandidateSchema)),
      },
    },
  })
  async searchCandidates(
    @ProcessId() id: string,
    @ZodQuery(mentionCandidatesQuerySchema) query: MentionCandidatesQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<MentionCandidateDto[]> {
    const candidates = await this.candidates.execute(id, query.q);
    // Personalizado (visibilidade de quem busca): nenhum cache intermediário.
    response.setHeader('Cache-Control', 'no-store');
    return candidates;
  }
}
