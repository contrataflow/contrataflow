import { PROCESS_EXPORT_MESSAGES, processExportQuerySchema } from '@contrataflow/validation';
import type { ProcessExportQuery } from '@contrataflow/validation';
import { Controller, Get, Logger, Res, StreamableFile } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ExportProcessesQuery } from '../application/export-processes.query.js';

const logger = new Logger('ProcessExport');

/**
 * PRC-34 (api/02-processes.md · US-003): exportação CSV da lista de processos. Registrado ANTES do
 * `ProcessController` para que `/processes/export` não caia em `/processes/:id`. `PROCESS_EXPORT`
 * (risco M, com escopo) no guard — sem ela, 403 + `access.denied` (`reasonCode = PROCESS_EXPORT`);
 * classe de limite "Exportações" (20/min).
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessExportController {
  constructor(private readonly exporter: ExportProcessesQuery) {}

  @Get('export')
  @RateLimit('export')
  @RequirePermission('PROCESS_EXPORT', { detail: PROCESS_EXPORT_MESSAGES.forbidden })
  @ApiOperation({
    operationId: 'PRC-34',
    summary: 'Exportar processos em CSV',
    tags: ['Processos'],
    auditActions: ['process.export'],
    responses: {
      200: {
        description:
          '`text/csv` em *streaming* (`Content-Disposition: attachment; filename="processos-AAAAMMDD-HHmm.csv"`) com os mesmos filtros e ordenação de PRC-01, sem paginação, e as colunas de `columns` (padrão: as visíveis por padrão na lista). Linhas = processos visíveis E cobertos pelo escopo de `PROCESS_EXPORT`. UTF-8 com BOM, separador `;`, CRLF, decimais com vírgula, datas `DD/MM/AAAA` (data-hora `DD/MM/AAAA HH:mm`) no fuso do tenant, rótulos em pt-BR. Valor sigiloso sem POL-09 sai como `Sigiloso` (e a coluna "Orçamento sigiloso" acompanha "Valor estimado"); texto iniciado por `=`, `+`, `-`, `@`, tabulação ou CR recebe `\'`. Acima de 10.000 linhas = 422 `EXPORT_TOO_LARGE` com `meta.totalItems`, antes de qualquer byte; exportação simultânea do mesmo usuário = 429 `RATE_LIMITED` com `Retry-After`. Grava `process.export` (`SUCCESS` ao concluir; `FAILURE` se interrompida); falha no meio do envio derruba a conexão.',
        contentTypes: ['text/csv'],
        schema: z.string(),
      },
    },
  })
  async export(
    @ZodQuery(processExportQuerySchema) query: ProcessExportQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<StreamableFile> {
    const file = await this.exporter.execute(query);
    response.setHeader('Cache-Control', 'no-store');
    // Cliente que desiste (aborta o download) encerra o cursor e a transação de leitura.
    response.once('close', () => {
      if (!response.writableFinished) file.stream.destroy();
    });
    return new StreamableFile(file.stream, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
    }).setErrorHandler((error, res) => {
      // Falha no meio do envio: derruba a conexão em vez de entregar um arquivo truncado como
      // completo (o cliente vê erro de rede e descarta o arquivo parcial — FA-08).
      logger.error({ event: 'process.export_stream_aborted', error: error.name }, 'process.export');
      (res as { destroy?: (cause?: Error) => void }).destroy?.(error);
    });
  }
}
