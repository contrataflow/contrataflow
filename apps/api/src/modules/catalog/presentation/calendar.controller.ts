import {
  addBusinessDaysResultSchema,
  addBusinessDaysSchema,
  businessDaysQuerySchema,
  businessDaysResultSchema,
  createHolidaySchema,
  dataEnvelope,
  holidayIdParamsSchema,
  holidayListQuerySchema,
  holidaySchema,
  pageEnvelope,
  updateHolidaySchema,
} from '@contrataflow/validation';
import type {
  AddBusinessDays,
  AddBusinessDaysResult,
  BusinessDaysQuery,
  BusinessDaysResult,
  CreateHoliday,
  HolidayDto,
  HolidayListQuery,
  UpdateHoliday,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';

import type { HttpResponse } from '#shared/http/http-types.js';
import { pageResult } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  AddBusinessDaysQuery,
  BusinessDaysQueryHandler,
  ListHolidaysQuery,
} from '../application/calendar.queries.js';
import { CreateHolidayCommand } from '../application/create-holiday.command.js';
import { DeleteHolidayCommand } from '../application/delete-holiday.command.js';
import { UpdateHolidayCommand } from '../application/update-holiday.command.js';

const TAGS = ['Calendário'];

/**
 * CAL-01..06 (api/14-tenant-administration.md · US-106): feriados e dias úteis do tenant. Leitura
 * (`CAL-01`, `CAL-05`, `CAL-06`) é capacidade implícita do vínculo ativo; criar, editar e excluir
 * feriado exigem `CALENDAR_MANAGE` (+ MFA conforme a política do tenant), conferido nos casos de
 * uso. Editar e excluir exigem `If-Match` (DEC-104).
 */
@Controller()
@TenantScope('TENANT')
export class CalendarController {
  constructor(
    private readonly list: ListHolidaysQuery,
    private readonly create: CreateHolidayCommand,
    private readonly update: UpdateHolidayCommand,
    private readonly remove: DeleteHolidayCommand,
    private readonly businessDays: BusinessDaysQueryHandler,
    private readonly addBusinessDays: AddBusinessDaysQuery,
  ) {}

  @Get('holidays')
  @ApiOperation({
    operationId: 'CAL-01',
    summary: 'Listar feriados do ano',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Feriados do ano (`year`, padrão o ano corrente no fuso do tenant) por data e nome.',
        schema: pageEnvelope(holidaySchema),
      },
    },
  })
  async listHolidays(
    @ZodQuery(holidayListQuerySchema) query: HolidayListQuery,
  ): Promise<PageResult<HolidayDto>> {
    const page = await this.list.execute(query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post('holidays')
  @ApiOperation({
    operationId: 'CAL-02',
    summary: 'Criar feriado',
    tags: TAGS,
    auditActions: ['holiday.create'],
    responses: {
      201: {
        description: 'Feriado criado, ativo e não-sistema (`Location` e `ETag` = versão).',
        schema: dataEnvelope(holidaySchema),
      },
    },
  })
  async createHoliday(
    @ZodBody(createHolidaySchema) body: CreateHoliday,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<HolidayDto> {
    const created = await this.create.execute(body);
    response.setHeader('Location', `/api/v1/holidays/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Patch('holidays/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'CAL-03',
    summary: 'Atualizar feriado',
    tags: TAGS,
    auditActions: ['holiday.update'],
    responses: {
      200: {
        description: 'Feriado atualizado (novo `ETag`).',
        schema: dataEnvelope(holidaySchema),
      },
    },
  })
  async updateHoliday(
    @ZodParams(holidayIdParamsSchema) params: { id: string },
    @ZodBody(updateHolidaySchema) body: UpdateHoliday,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<HolidayDto> {
    const holiday = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${holiday.version}"`);
    return holiday;
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'CAL-04',
    summary: 'Excluir feriado',
    tags: TAGS,
    auditActions: ['holiday.delete'],
    responses: { 204: { description: 'Feriado excluído; os de sistema só são desativados.' } },
  })
  async deleteHoliday(
    @ZodParams(holidayIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ id: params.id, expectedVersion: ifMatch?.value ?? 0 });
  }

  @Get('calendar/business-days')
  @ApiOperation({
    operationId: 'CAL-05',
    summary: 'Consultar dias úteis em um intervalo',
    tags: TAGS,
    responses: {
      200: {
        description: 'Quantidade e datas dos dias úteis de `from` a `to` (inclusive).',
        schema: dataEnvelope(businessDaysResultSchema),
      },
    },
  })
  getBusinessDays(
    @ZodQuery(businessDaysQuerySchema) query: BusinessDaysQuery,
  ): Promise<BusinessDaysResult> {
    return this.businessDays.execute(query);
  }

  @Post('calendar/add-business-days')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'CAL-06',
    summary: 'Somar dias úteis a uma data/hora',
    tags: TAGS,
    auditExempt: 'Cálculo somente de leitura: o POST apenas carrega o corpo, sem efeito colateral.',
    responses: {
      200: {
        description:
          'Fim do dia (`23:59:59.999` no fuso do tenant, em UTC) do N-ésimo dia a partir de `fromDateTime`.',
        schema: dataEnvelope(addBusinessDaysResultSchema),
      },
    },
  })
  postAddBusinessDays(
    @ZodBody(addBusinessDaysSchema) body: AddBusinessDays,
  ): Promise<AddBusinessDaysResult> {
    return this.addBusinessDays.execute(body);
  }
}
