import { createHash } from 'node:crypto';

import {
  publicSettingsResponseSchema,
  settingsResponseSchema,
  updateSettingsSchema,
} from '@contrataflow/validation';
import type { SettingsMapDto, UpdateSettings } from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Res } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { GetPublicSettingsQuery, GetSettingsQuery } from '../application/settings.queries.js';
import { UpdateSettingsCommand } from '../application/update-settings.command.js';

const TAGS = ['Configurações'];

/** ETag fraco do conteúdo: o cliente revalida (`If-None-Match`) em vez de reler o corpo. */
function weakEtag(payload: unknown): string {
  return `W/"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 22)}"`;
}

/**
 * SET-01..03 (api/14-tenant-administration.md · US-103): configurações do tenant. Leitura completa
 * e escrita exigem `SETTINGS_MANAGE` (+ MFA, POL-14), conferido nos casos de uso; a leitura pública
 * é capacidade implícita de qualquer vínculo ativo (RN-TEN-56). Concorrência por chave no corpo
 * (`expectedVersions`), não por `If-Match`; o `PATCH` aceita `Idempotency-Key` (reenvio devolve a
 * mesma resposta com `Idempotent-Replayed: true` — US-105).
 */
@Controller('settings')
@TenantScope('TENANT')
export class SettingsController {
  constructor(
    private readonly list: GetSettingsQuery,
    private readonly listPublic: GetPublicSettingsQuery,
    private readonly update: UpdateSettingsCommand,
  ) {}

  @Get()
  @RequirePermission('SETTINGS_MANAGE')
  @ApiOperation({
    operationId: 'SET-01',
    summary: 'Consultar configurações do tenant',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Todas as chaves do registro com `value` e `version` (0 = padrão ainda não gravado).',
        schema: settingsResponseSchema,
      },
    },
  })
  async getSettings(@Res({ passthrough: true }) response: HttpResponse): Promise<SettingsMapDto> {
    const settings = await this.list.execute();
    response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    response.setHeader('ETag', weakEtag(settings));
    return settings;
  }

  @Patch()
  @HttpCode(200)
  @Idempotent()
  @RequirePermission('SETTINGS_MANAGE')
  @ApiOperation({
    operationId: 'SET-02',
    summary: 'Atualizar configurações do tenant (lote, tudo ou nada)',
    tags: TAGS,
    idempotent: true,
    auditActions: ['settings.update'],
    responses: {
      200: {
        description: 'Somente as chaves alteradas, com o novo valor e a nova versão.',
        schema: settingsResponseSchema,
      },
    },
  })
  updateSettings(@ZodBody(updateSettingsSchema) body: UpdateSettings): Promise<SettingsMapDto> {
    return this.update.execute(body);
  }

  @Get('public')
  @ApiOperation({
    operationId: 'SET-03',
    summary: 'Consultar configurações públicas do tenant',
    tags: TAGS,
    responses: {
      200: {
        description: 'Somente as chaves públicas (`labels.*`, `branding.*`).',
        schema: publicSettingsResponseSchema,
      },
    },
  })
  async getPublicSettings(
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<Record<string, unknown>> {
    const settings = await this.listPublic.execute();
    response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    response.setHeader('ETag', weakEtag(settings));
    return settings;
  }
}
