import {
  applyQuotationImportSchema,
  dataEnvelope,
  priceResearchIdParamsSchema,
  QUOTATION_IMPORT_LIMITS,
  quotationImportPreviewSchema,
  quotationImportResultSchema,
  quotationImportUploadSchema,
} from '@contrataflow/validation';
import type {
  ApplyQuotationImport,
  QuotationImportPreview,
  QuotationImportResult,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { HttpRequest, HttpResponse } from '#shared/http/http-types.js';
import { headerValue } from '#shared/http/http-types.js';
import { drain, readMultipartFile } from '#shared/http/multipart.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  ApplyQuotationImportCommand,
  GetImportTemplateQuery,
  PreviewQuotationImportCommand,
} from '../application/quotation-import.commands.js';

const TAGS = ['Pesquisa de preços'];

const ACCESS =
  'PRICE_RESEARCH_UPDATE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — com a POL-02 estendida e POL-09 em processo sigiloso (RN-PRICE-10/12), conferidas no caso de uso; sem permissão = 403 PERMISSION_DENIED com access.denied.';
const RULES =
  '`PRICE_RESEARCH_UPDATE` cobrindo o processo (403 `PERMISSION_DENIED`) + custódia ou participação `COLLABORATOR`/`CONSULTANT` (403) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (409 `INVALID_PROCESS_STATUS`) + tipo permitido na etapa (422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) + POL-09 em processo sigiloso (403 `PERMISSION_DENIED`, `reasonCode = POL-09`). Pesquisa inexistente, de outro tenant ou não visível = 404 `NOT_FOUND`.';
const LAYOUT = `Planilha de uma aba: linha 1 = cabeçalho; colunas \`Item\` (sequência do item do processo), \`Descrição do item\` e \`Unidade\` (informativas), depois uma coluna por fonte com o cabeçalho = descrição da fonte (descrições repetidas ganham \` (n)\`). Até ${String(QUOTATION_IMPORT_LIMITS.maxRows)} itens e ${String(QUOTATION_IMPORT_LIMITS.maxSources)} fontes.`;

/**
 * Importação de cotações por planilha (api/07 · US-028): PRS-24 (modelo), PRS-18 (prévia, corpo
 * `multipart/form-data` lido aqui depois da autorização) e PRS-19 (aplicação).
 */
@Controller()
@TenantScope('TENANT')
export class QuotationImportController {
  constructor(
    private readonly template: GetImportTemplateQuery,
    private readonly preview: PreviewQuotationImportCommand,
    private readonly apply: ApplyQuotationImportCommand,
  ) {}

  @Get('price-research/:id/import-template')
  @ImplicitAccess(ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-24',
    summary: 'Obter modelo de planilha para importação',
    tags: TAGS,
    responses: {
      200: {
        description: `Arquivo \`.xlsx\` (\`Content-Disposition: attachment\`, \`cotacoes-<código>.xlsx\`) com a matriz itens × fontes já cadastradas e os preços atuais pré-preenchidos (células sem cotação em branco — RN-PRICE-35). ${LAYOUT} Acima disso → 422 \`EXPORT_TOO_LARGE\`. Somente leitura. ${RULES}`,
        contentTypes: [QUOTATION_IMPORT_LIMITS.mimeType],
        schema: z.string(),
      },
    },
  })
  async importTemplate(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
  ): Promise<StreamableFile> {
    const file = await this.template.execute(params.id);
    return new StreamableFile(file.data, {
      type: QUOTATION_IMPORT_LIMITS.mimeType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.length,
    });
  }

  @Post('price-research/:id/import-preview')
  @HttpCode(200)
  @ImplicitAccess(ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-18',
    summary: 'Pré-visualizar importação de cotações por planilha',
    tags: TAGS,
    auditExempt:
      'Prévia somente leitura (RN-PRICE-37): não grava nada nem gera evento; a gravação e a auditoria price_research.import ficam no PRS-19.',
    requestBody: { contentType: 'multipart/form-data', schema: quotationImportUploadSchema },
    responses: {
      200: {
        description: `Lê a planilha (campo \`file\`) sem gravar nada e devolve o \`previewToken\` (válido por 15 minutos, consumido no PRS-19) com o resumo por linha/célula: válidas, com erro, vazias e com aviso. ${LAYOUT} Colunas reconhecidas pelo cabeçalho em qualquer ordem; coluna sem fonte = aviso \`REFERENCE_NOT_FOUND\` (FA-02). Por linha: item inexistente → erro \`REFERENCE_NOT_FOUND\`; repetido → \`DUPLICATE_IN_LIST\`; por célula: preço ausente, ≤ 0 ou com mais casas que \`unitPriceDecimals\` → \`INVALID_DECIMAL\`; cotação \`EXCLUDED\` → aviso \`QUOTATION_EXCLUDED\` (RN-PRICE-39). Arquivo que não é \`.xlsx\` ou corrompido → 415 \`FILE_TYPE_NOT_ALLOWED\`; acima de \`uploads.maxFileSizeMb\` → 413 \`FILE_TOO_LARGE\`; sem a coluna \`Item\`, sem coluna de fonte, ou acima de ${String(QUOTATION_IMPORT_LIMITS.maxRows)} itens/${String(QUOTATION_IMPORT_LIMITS.maxSources)} fontes → 422 \`VALIDATION_ERROR\` em \`file\`. Sem preços na resposta. ${RULES}`,
        schema: dataEnvelope(quotationImportPreviewSchema),
      },
    },
  })
  async importPreview(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @Req() request: HttpRequest,
  ): Promise<QuotationImportPreview> {
    if (!/^multipart\/form-data/i.test(headerValue(request, 'content-type') ?? '')) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
    }
    return this.preview.execute({
      researchId: params.id,
      upload: {
        read: (maxFileBytes, tooLarge) =>
          readMultipartFile(request, { field: 'file', maxFileBytes, tooLarge }),
        discard: () => drain(request),
      },
    });
  }

  @Post('price-research/:id/import')
  @HttpCode(200)
  @Idempotent()
  @ImplicitAccess(ACCESS)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'PRS-19',
    summary: 'Aplicar importação de cotações',
    tags: TAGS,
    idempotent: true,
    auditActions: ['price_research.import'],
    responses: {
      200: {
        description: `Aplica, numa transação só, as células válidas da prévia (\`previewToken\` do PRS-18): cria a cotação do item na fonte ou atualiza o preço da \`VALID\`; células vazias não alteram nada; cotação \`EXCLUDED\`, preço igual ao gravado e item/fonte removidos depois da prévia são ignorados (RN-PRICE-38/39). A edição manual feita entre a prévia e a aplicação é sobrescrita (o último valor aplicado vale). Token de outra pesquisa, de outra pessoa ou de outro tenant → 404 \`NOT_FOUND\`; vencido (15 min) ou já aplicado → 410 \`IMPORT_PREVIEW_EXPIRED\`. As fontes alteradas ganham versão nova; um único recálculo ao final emite \`PriceResearchRecalculated\` (\`price_research.recalculated\`) e grava \`price_research.import\` (\`metadata\`: \`appliedCount\`, \`skippedCount\`, nome do arquivo). \`skippedCount\` = células preenchidas não aplicadas (com erro ou aviso na prévia, iguais à gravada ou sem referência). Reenvio com a mesma \`Idempotency-Key\` = mesma resposta com \`Idempotent-Replayed: true\`, sem aplicar de novo. ${RULES}`,
        schema: dataEnvelope(quotationImportResultSchema),
      },
    },
  })
  async importApply(
    @ZodParams(priceResearchIdParamsSchema) params: { id: string },
    @ZodBody(applyQuotationImportSchema) body: ApplyQuotationImport,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<QuotationImportResult> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.apply.execute({
      researchId: params.id,
      previewToken: body.previewToken,
    });
    return { appliedCount: result.appliedCount, skippedCount: result.skippedCount };
  }
}
