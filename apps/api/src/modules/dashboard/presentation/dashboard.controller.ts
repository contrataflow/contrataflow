import {
  DASHBOARD_MESSAGES,
  DASHBOARD_WIDGET_KEYS,
  dashboardFiltersSchema,
  dashboardSummaryResponseSchema,
  dashboardWidgetQuerySchema,
  dashboardWidgetResponseSchema,
} from '@contrataflow/validation';
import type {
  DashboardCacheMeta,
  DashboardFilters,
  DashboardSummaryDto,
  DashboardWidgetDto,
  DashboardWidgetQuery,
} from '@contrataflow/validation';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  GetDashboardSummaryHandler,
  GetDashboardWidgetHandler,
} from '../application/dashboard.queries.js';

const TAGS = ['Dashboard'];

/** Fora do registro = 404 `WIDGET_NOT_FOUND` (V-01), não 422: por isso texto livre aqui. */
const widgetKeyParamsSchema = z
  .object({
    widgetKey: z
      .string()
      .max(60)
      .meta({
        description: `Registro \`DashboardWidgetKey\`: ${DASHBOARD_WIDGET_KEYS.join(', ')}.`,
      }),
  })
  .meta({ id: 'DashboardWidgetKeyParams' });

/** `@WidgetKey()`: `widgetKey` do caminho e o OpenAPI. */
function WidgetKey(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('widgetKey')(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', widgetKeyParamsSchema);
    }
  };
}

/**
 * DSH-01/DSH-02 (api/13-dashboard-notifications-audit.md · US-076 · SCR-003): o painel inicial como
 * leitura agregada dos processos visíveis (DEC-024). Somente leitura, sem evento nem auditoria
 * (recusa por falta de `DASHBOARD_VIEW` = `access.denied`).
 */
@Controller('dashboard')
@TenantScope('TENANT')
export class DashboardController {
  constructor(
    private readonly summary: GetDashboardSummaryHandler,
    private readonly widgets: GetDashboardWidgetHandler,
  ) {}

  @Get('summary')
  @RequirePermission('DASHBOARD_VIEW', { detail: DASHBOARD_MESSAGES.forbidden })
  @ApiOperation({
    operationId: 'DSH-01',
    summary: 'Obter resumo do dashboard',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Pendências de quem consulta (`pendingCount` = "Comigo" + "Aprovações pendentes" de TSK-02, mesmos predicados — RN-DASH-03), atrasados (`overdueSince` com o prazo correndo), a vencer (`currentStageDueAt` em até `deadlines.warnBeforeBusinessDays` dias úteis) e abertos (`IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED`) entre os processos visíveis (DEC-024), recortados por `secretariatId`/`departmentId` (com subárvore) da unidade solicitante — filtro fora do escopo = zeros, nunca erro. Cache de 60 s por usuário e filtros (`meta.cache`).',
        schema: dashboardSummaryResponseSchema,
      },
    },
  })
  async getSummary(
    @ZodQuery(dashboardFiltersSchema) filters: DashboardFilters,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DashboardSummaryDto, { cache: DashboardCacheMeta }>> {
    const result = await this.summary.execute(filters);
    // Pessoal e consultado por polling: o cache é o do servidor (RN-DASH-10), nunca intermediário.
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(result.data, { cache: result.cache });
  }

  @Get('widgets/:widgetKey')
  @RequirePermission('DASHBOARD_VIEW', { detail: DASHBOARD_MESSAGES.forbidden })
  @ApiOperation({
    operationId: 'DSH-02',
    summary: 'Obter indicador do dashboard',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Um indicador do registro `DashboardWidgetKey` (RN-DASH-02) sobre os processos visíveis e recortados pelos filtros: séries `{ key, label, value }` (contagens), `AVG_STAGE_DURATION` em segundos (90 dias), `OPENED_BY_MONTH` em 12 meses no fuso do tenant, `VALUE_BY_SECRETARIAT` com `confidentialExcluded` (POL-09: o sigiloso que o usuário não pode ver fica fora da soma) e `RECENT_ACTIVITY` com até `limit` (1–100, padrão 20) entradas da timeline, sem as `BUDGET_RESTRICTED` não visíveis. `widgetKey` fora do registro = 404 `WIDGET_NOT_FOUND`. Cache de 60 s (`meta.cache`).',
        schema: dashboardWidgetResponseSchema,
      },
    },
  })
  async getWidget(
    @WidgetKey() widgetKey: string,
    @ZodQuery(dashboardWidgetQuerySchema) query: DashboardWidgetQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DashboardWidgetDto, { generatedAt: string; cache: DashboardCacheMeta }>> {
    const result = await this.widgets.execute(widgetKey, query);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(result.data, {
      generatedAt: result.data.generatedAt,
      cache: result.cache,
    });
  }
}
