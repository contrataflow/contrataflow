import {
  COMPARATIVE_MAP_LIMITS,
  comparativeMapExportQuerySchema,
  comparativeMapSchema,
  dataEnvelope,
  priceResearchIdParamsSchema,
} from '@contrataflow/validation';
import type { ComparativeMapDto, ComparativeMapExportQuery } from '@contrataflow/validation';
import { Controller, Get, Res, StreamableFile } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  ExportComparativeMapXlsxCommand,
  GetComparativeMapQuery,
} from '../application/comparative-map.queries.js';

const TAGS = ['Pesquisa de preços'];

const ACCESS =
  'Mapa comparativo (US-031 · DEC-024): visibilidade do processo (PROCESS_VIEW com escopo que o cubra, concessão USER ou participação), conferida no caso de uso; não visível = 404 PRICE_RESEARCH_NOT_FOUND igual ao inexistente. Valores sob POL-09 (RN-PRICE-56).';
const MATRIX = `Linhas = itens por \`sortOrder\`; colunas = fontes por \`sortOrder\`; células = a cotação de cada cruzamento item × fonte (ausente quando não há) com \`unitPrice\`, \`status\`, \`outlierFlag\` e \`isExpired\`; cada linha termina com as estatísticas e os \`alerts\` do item (RN-PRICE-53). Sempre o estado do último recálculo consolidado (\`lastCalculatedAt\`), lido numa única transação — nunca um estado parcial (RN-PRICE-57). Sem \`PROCESS_VIEW_CONFIDENTIAL_BUDGET\` nem custódia atual em processo sigiloso: \`masked: true\`, toda célula com \`unitPrice: null\` + \`unitPriceMasked: true\`, estatísticas e totais \`null\` com \`valuesMasked: true\` (RN-PRICE-56). Pesquisa inexistente, de outro tenant ou não visível = 404 \`PRICE_RESEARCH_NOT_FOUND\`; banco indisponível = 503 \`DEPENDENCY_UNAVAILABLE\`.`;

/**
 * Mapa comparativo (api/07 · US-031): PRS-21 (matriz) e PRS-22 (XLSX síncrono). O PDF é a
 * renderização do documento `PRICE_RESEARCH` (DOC-20..23), seção `PRICE_SUMMARY`.
 */
@Controller('price-research/:id/comparative-map')
@TenantScope('TENANT')
export class ComparativeMapController {
  constructor(
    private readonly map: GetComparativeMapQuery,
    private readonly exportXlsx: ExportComparativeMapXlsxCommand,
  ) {}

  @Get()
  @ImplicitAccess(ACCESS)
  @ApiOperation({
    operationId: 'PRS-21',
    summary: 'Obter mapa comparativo',
    tags: TAGS,
    responses: {
      200: {
        description: `Mapa comparativo da pesquisa. ${MATRIX} Somente leitura: sem auditoria nem eventos.`,
        schema: dataEnvelope(comparativeMapSchema),
      },
    },
  })
  async comparativeMap(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ComparativeMapDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.map.execute(params.id);
  }

  @Get('export')
  @RateLimit('export')
  @ImplicitAccess(ACCESS)
  @ApiOperation({
    operationId: 'PRS-22',
    summary: 'Exportar mapa comparativo (xlsx)',
    tags: TAGS,
    auditActions: ['price_research.export'],
    responses: {
      200: {
        description: `Arquivo \`.xlsx\` (\`Content-Disposition: attachment\`, \`mapa-comparativo-<código>.xlsx\`), síncrono, com uma aba: a mesma matriz do PRS-21 (preços numéricos; selos das células na coluna "Observações"), a legenda das fontes e o resumo (data-base, cálculo, total). ${MATRIX} Mascarado = "Sigiloso" nas células monetárias. Conteúdo determinístico: sem recálculo entre duas exportações, os bytes são idênticos. Acima de ${String(COMPARATIVE_MAP_LIMITS.maxExportItems)} itens ou ${String(COMPARATIVE_MAP_LIMITS.maxExportSources)} fontes = 422 \`EXPORT_TOO_LARGE\` (\`meta.itemsCount\`/\`sourcesCount\`) antes de montar o arquivo (RN-PRICE-54); \`format\` ausente ou diferente de \`xlsx\` = 422 \`VALIDATION_ERROR\` (V-02). Cada exportação grava \`price_research.export\` (\`format\`, \`itemsCount\`, \`sourcesCount\`, \`masked\`); nenhum byte é enviado se a gravação falhar.`,
        contentTypes: [COMPARATIVE_MAP_LIMITS.mimeType],
        schema: z.string(),
      },
    },
  })
  async export(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodQuery(comparativeMapExportQuerySchema) query: ComparativeMapExportQuery,
  ): Promise<StreamableFile> {
    const file = await this.exportXlsx.execute(params.id, query.format);
    return new StreamableFile(file.data, {
      type: COMPARATIVE_MAP_LIMITS.mimeType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.length,
    });
  }
}
