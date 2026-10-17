import {
  auditLogExportQuerySchema,
  auditLogIdParamsSchema,
  auditLogSchema,
  auditLogSearchQuerySchema,
  cursorEnvelope,
  dataEnvelope,
} from '@contrataflow/validation';
import type {
  AuditLogDto,
  AuditLogExportQuery,
  AuditLogSearchQuery,
} from '@contrataflow/validation';
import { Controller, Get, Logger, StreamableFile } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { CursorResult } from '#shared/http/pagination.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  ExportAuditLogsHandler,
  GetAuditLogHandler,
  SearchAuditLogsHandler,
} from '../application/audit-logs.handlers.js';

const TAGS = ['Auditoria'];
const logger = new Logger('Audit');

/**
 * AUD-01/AUD-02/AUD-03 (api/13-dashboard-notifications-audit.md · US-075): consulta, detalhe e
 * exportação da trilha para a aba "Registros" de SCR-037. `AUDIT_VIEW`/`AUDIT_EXPORT` são de risco
 * `HIGH` e sem escopo de unidade: o guard aplica também o MFA (POL-14) e grava `access.denied` na
 * recusa. Em `OFFBOARDING`, só `ADMIN_ORGAO`/`AUDITOR` chegam aqui (DEC-132 — pipeline). As rotas
 * fixas vêm antes de `:id`; `/audit/seals` é do `AuditSealsController`, registrado antes deste.
 */
@Controller('audit')
@TenantScope('TENANT')
export class AuditLogsController {
  constructor(
    private readonly search: SearchAuditLogsHandler,
    private readonly detail: GetAuditLogHandler,
    private readonly exporter: ExportAuditLogsHandler,
  ) {}

  @Get()
  @RequirePermission('AUDIT_VIEW')
  @ApiOperation({
    operationId: 'AUD-01',
    summary: 'Consultar trilha de auditoria',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Registros do tenant no período `occurredFrom`–`occurredTo` (obrigatório, inclusivo, até 90 dias — RN-AUD-17), mais recentes primeiro (`occurredAt DESC, id DESC`), por cursor; filtros combinados por E, valores do mesmo filtro por OU (vírgula). `limit` acima de 100 é ajustado para 100. `changes` já mascarado na gravação. A consulta é auditada como `audit.search` com os filtros. Banco fora do ar = 503 `DEPENDENCY_UNAVAILABLE`.',
        schema: cursorEnvelope(auditLogSchema),
      },
    },
  })
  list(
    @ZodQuery(auditLogSearchQuerySchema) query: AuditLogSearchQuery,
  ): Promise<CursorResult<AuditLogDto>> {
    return this.search.execute(query);
  }

  @Get('export')
  @RateLimit('export')
  @RequirePermission('AUDIT_EXPORT')
  @ApiOperation({
    operationId: 'AUD-03',
    summary: 'Exportar trilha de auditoria',
    tags: TAGS,
    auditActions: ['audit.export'],
    responses: {
      200: {
        description:
          "Arquivo (`Content-Disposition: attachment`) com os registros dos mesmos filtros de AUD-01, sem paginação, mais recentes primeiro: `text/csv` (UTF-8 com BOM, CRLF, colunas de `AuditLog`; `changes`/`metadata` em JSON; valor textual iniciado por `=`, `+`, `-`, `@`, tabulação ou CR recebe `'` — RN-AUD-20) ou `application/x-ndjson` (um `AuditLog` por linha). Período fixado até o instante do pedido. Acima de `audit.export.maxRows` (100 mil) = 422 `EXPORT_TOO_LARGE`, antes de gerar o arquivo. Cada exportação grava `audit.export` (filtros, `format`, `rowCount`).",
        contentTypes: ['text/csv', 'application/x-ndjson'],
        schema: z.string(),
      },
    },
  })
  async export(
    @ZodQuery(auditLogExportQuerySchema) query: AuditLogExportQuery,
  ): Promise<StreamableFile> {
    const file = await this.exporter.execute(query);
    return new StreamableFile(file.stream, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
    }).setErrorHandler((error, response) => {
      // Falha no meio do envio: derruba a conexão em vez de entregar um arquivo truncado como
      // completo (o cliente vê erro de rede e repete). Antes do 1º byte, as falhas já viraram
      // problem+json no handler (contagem e auditoria).
      logger.error({ event: 'audit.export_stream_aborted', error: error.name }, 'audit.export');
      (response as { destroy?: (cause?: Error) => void }).destroy?.(error);
    });
  }

  @Get(':id')
  @RequirePermission('AUDIT_VIEW')
  @ApiOperation({
    operationId: 'AUD-02',
    summary: 'Obter registro de auditoria',
    tags: TAGS,
    responses: {
      200: {
        description:
          'O `AuditLog` completo, com o diff de `changes` (`path`/`old`/`new`) exatamente como gravado: valor mascarado ou resumido (hash + tamanho) nunca é desmascarado (RN-AUD-18). Inexistente ou de outro tenant = 404 `NOT_FOUND`, sem distinguir. Auditado como `audit.search`.',
        schema: dataEnvelope(auditLogSchema),
      },
    },
  })
  get(@ZodParams(auditLogIdParamsSchema) params: { id: string }): Promise<AuditLogDto> {
    return this.detail.execute(params.id);
  }
}
