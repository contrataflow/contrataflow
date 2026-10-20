import {
  dataEnvelope,
  documentIdParamsSchema,
  documentPresenceSchema,
  documentPresenceUpdateSchema,
} from '@contrataflow/validation';
import type { DocumentPresenceDto, DocumentPresenceUpdate } from '@contrataflow/validation';
import { Controller, Delete, HttpCode, Put, Res } from '@nestjs/common';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  RegisterDocumentPresenceCommand,
  RemoveDocumentPresenceCommand,
} from '../application/document-presence.commands.js';

const TAGS = ['Documentos'];

/** RN-DOC-93: heartbeats a cada 20 s tornariam a trilha ruidosa sem valor de rastreabilidade. */
const PRESENCE_AUDIT_EXEMPT =
  'Presença de edição é efêmera (Redis com TTL de 60 s): não altera o documento nem gera evento ou auditoria (RN-DOC-93).';

/**
 * DOC-24/25 (api/03-documents.md · US-070): o indicador de edição concorrente da SCR-105. O
 * heartbeat não altera o recurso (sem `If-Match` nem `Idempotency-Key`) e fica na classe de limite
 * de escrita — 3 por minuto por editor. Nada aqui gera evento ou auditoria (RN-DOC-93).
 */
@Controller('documents')
@TenantScope('TENANT')
export class DocumentPresenceController {
  constructor(
    private readonly register: RegisterDocumentPresenceCommand,
    private readonly leave: RemoveDocumentPresenceCommand,
  ) {}

  @Put(':id/presence')
  @HttpCode(200)
  @ImplicitAccess(
    'A mesma regra de edição do DOC-05: permissão de EDIÇÃO do tipo (DOCUMENT_UPDATE, DFD_UPDATE, ETP_UPDATE, TERM_UPDATE…) cobrindo o processo + custódia ou participação COLLABORATOR/CONSULTANT + processo e documento editáveis + tipo na etapa (POL-02), conferida pelo caso de uso sem negar com 403: quem não pode editar recebe 409 DOCUMENT_NOT_EDITABLE (o indicador não é exibido).',
  )
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-24',
    auditExempt: PRESENCE_AUDIT_EXEMPT,
    summary: 'Registrar presença de edição (heartbeat)',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Presença do usuário gravada/renovada no Redis com TTL de 60 s (uma entrada por usuário; trocar de seção atualiza `sectionKey` e `since`). Devolve os DEMAIS editores ativos no documento (sem o chamador; sem heartbeat há 60 s nunca aparece). Redis indisponível: 200 degradado com `editors: []` (RN-DOC-92 — a edição segue normal). Erros: 404 `NOT_FOUND` (inexistente, outro tenant ou não visível), 409 `DOCUMENT_NOT_EDITABLE` (sem permissão de edição do tipo, sem custódia/participação, processo ou documento fora de edição, tipo fora da etapa), 422 `SECTION_NOT_IN_TEMPLATE` (a presença é renovada mantendo a seção anterior) e `VALIDATION_ERROR` com `NOT_ALLOWED` (documento sem seções — `UPLOADED`). Sem evento nem auditoria (RN-DOC-93).',
        schema: dataEnvelope(documentPresenceSchema),
      },
    },
  })
  async heartbeat(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentPresenceUpdateSchema) body: DocumentPresenceUpdate,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentPresenceDto> {
    const presence = await this.register.execute({
      documentId: params.id,
      sectionKey: body.sectionKey,
    });
    response.setHeader('Cache-Control', 'no-store');
    return presence;
  }

  @Delete(':id/presence')
  @HttpCode(204)
  @ImplicitAccess(
    'Sessão autenticada com o documento visível (DEC-024): encerra apenas a própria presença.',
  )
  @ApiOperation({
    operationId: 'DOC-25',
    auditExempt: PRESENCE_AUDIT_EXEMPT,
    summary: 'Encerrar presença de edição',
    tags: TAGS,
    responses: {
      204: {
        description:
          'Presença do próprio usuário removida (idempotente; com o Redis indisponível também responde 204 — o TTL de 60 s expira a presença). Erro: 404 `NOT_FOUND` (inexistente, outro tenant ou não visível). Sem evento nem auditoria (RN-DOC-93).',
      },
    },
  })
  async leaveDocument(@ZodParams(documentIdParamsSchema) params: { id: string }): Promise<void> {
    await this.leave.execute(params.id);
  }
}
