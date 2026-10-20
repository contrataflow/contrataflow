import {
  addProcessParticipantSchema,
  dataEnvelope,
  processIdParamsSchema,
  processParticipantIdParamsSchema,
  processParticipantSchema,
  processParticipantsMetaSchema,
  removeProcessParticipantSchema,
} from '@contrataflow/validation';
import type {
  AddProcessParticipant,
  ProcessParticipantDto,
  ProcessParticipantsMeta,
  RemoveProcessParticipant,
} from '@contrataflow/validation';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { Policy, RequirePermission } from '#shared/auth/authorization.js';
import { ApiError } from '#shared/errors/api-error.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodValidationPipe } from '#shared/validation/zod-validation.pipe.js';

import {
  AddProcessParticipantCommand,
  FollowProcessCommand,
  ListProcessParticipantsQuery,
  RemoveProcessParticipantCommand,
  UnfollowProcessCommand,
} from '../application/process-participants.commands.js';

const TAGS = ['Processos'];

const MANAGE_DENIED = 'Você não tem permissão para gerenciar participantes deste processo.';

/** Identificador do caminho que não é UUIDv7 = 400 `MALFORMED_REQUEST` (não é campo — sem 422). */
class UuidV7Pipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = processIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

/** `@PathId('id' | 'participantId')`: valida o identificador do caminho e o documenta. */
function PathId(name: 'id' | 'participantId'): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param(name, new UuidV7Pipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(
        target,
        propertyKey,
        'params',
        name === 'id' ? processIdParamsSchema : processParticipantIdParamsSchema,
      );
    }
  };
}

/** Corpo OPCIONAL (DELETE sem corpo = `{}`), validado e documentado como o `@ZodBody`. */
function OptionalZodBody(schema: z.ZodType): ParameterDecorator {
  const pipe = new ZodValidationPipe(schema);
  return (target, propertyKey, index) => {
    Body({ transform: (value: unknown) => pipe.transform(value ?? {}) })(
      target,
      propertyKey,
      index,
    );
    if (propertyKey !== undefined) recordRequestSchema(target, propertyKey, 'body', schema);
  };
}

const PARTICIPANT_EFFECTS =
  'Grava `ProcessAccess` (`PARTICIPANT`), a timeline e a auditoria na mesma transação do evento.';

/**
 * Participantes do processo (api/02-processes.md · US-012 · DEC-036): PRC-28 (listar), PRC-29
 * (adicionar) e PRC-31/32 (seguir/deixar de seguir) sob `/processes/{id}`, com a permissão cobrindo
 * o processo do caminho no guard (não visível = 404 `PROCESS_NOT_FOUND`); PRC-30 (remover) sob
 * `/process-participants/{participantId}`, com o processo do participante conferido no caso de uso.
 */
@Controller()
@TenantScope('TENANT')
export class ProcessParticipantsController {
  constructor(
    private readonly list: ListProcessParticipantsQuery,
    private readonly add: AddProcessParticipantCommand,
    private readonly remove: RemoveProcessParticipantCommand,
    private readonly follow: FollowProcessCommand,
    private readonly unfollow: UnfollowProcessCommand,
  ) {}

  @Get('processes/:id/participants')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-28',
    summary: 'Listar participantes do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Participações ativas, da concessão mais antiga para a mais nova; consultor com validade vencida fica de fora (RN-PROC-135). `meta.canManage` = `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo; `meta.me` = a participação do próprio usuário (botão "Seguir").',
        schema: z.object({
          data: z.array(processParticipantSchema),
          meta: processParticipantsMetaSchema,
        }),
      },
    },
  })
  async listParticipants(
    @PathId('id') id: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<ProcessParticipantDto[], ProcessParticipantsMeta>> {
    const { items, meta } = await this.list.execute(id);
    response.setHeader('Cache-Control', 'no-store');
    return new DataResult(items, meta);
  }

  @Post('processes/:id/participants')
  @Idempotent()
  @RequirePermission('PROCESS_MANAGE_PARTICIPANTS', {
    scope: { processParam: 'id' },
    detail: MANAGE_DENIED,
  })
  @Policy('POL-10')
  @ApiOperation({
    operationId: 'PRC-29',
    summary: 'Adicionar participante ao processo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['process.participant_add'],
    responses: {
      201: {
        description: `Participação criada (\`Location\`). Exatamente um entre \`userId\`/\`departmentId\` ativos do tenant (422 \`REFERENCE_NOT_FOUND\`/\`REFERENCE_INACTIVE\` — de outro tenant = inexistente); \`CONSULTANT\` só para usuário com vínculo \`EXTERNAL\` ativo e validade futura ≤ a do vínculo, e ninguém se inclui como Colaborador/Consultor (422 \`PARTICIPANT_NOT_ELIGIBLE\` — POL-10); quem já participa → 409 \`PARTICIPANT_ALREADY_EXISTS\` com \`meta.currentRole\`. ${PARTICIPANT_EFFECTS}`,
        schema: dataEnvelope(processParticipantSchema),
      },
    },
  })
  async addParticipant(
    @PathId('id') id: string,
    @ZodBody(addProcessParticipantSchema) body: AddProcessParticipant,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessParticipantDto> {
    const { dto } = await this.add.execute({ processId: id, body });
    response.setHeader('Location', `/api/v1/process-participants/${dto.id}`);
    return dto;
  }

  @Delete('process-participants/:participantId')
  @HttpCode(204)
  @RequirePermission('PROCESS_MANAGE_PARTICIPANTS', { detail: MANAGE_DENIED })
  @Policy('POL-10')
  @ApiOperation({
    operationId: 'PRC-30',
    summary: 'Remover participante do processo',
    tags: TAGS,
    auditActions: ['process.participant_remove'],
    responses: {
      204: {
        description: `Participação revogada (\`revokedAt\`; \`revocationReason\` opcional, até 500). \`PROCESS_MANAGE_PARTICIPANTS\` cobrindo o processo do participante (403 \`PERMISSION_DENIED\`); inexistente, já revogado, de outro tenant ou de processo não visível → 404 \`PARTICIPANT_NOT_FOUND\`. Revoga o \`ProcessAccess\` e grava \`ProcessParticipantRemoved\` (\`REVOKED\`), a timeline e a auditoria na mesma transação.`,
      },
    },
  })
  async removeParticipant(
    @PathId('participantId') participantId: string,
    @OptionalZodBody(removeProcessParticipantSchema) body: RemoveProcessParticipant,
  ): Promise<void> {
    await this.remove.execute({
      participantId,
      revocationReason: body.revocationReason ?? null,
    });
  }

  @Post('processes/:id/follow')
  @HttpCode(200)
  @RequirePermission('PROCESS_FOLLOW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-31',
    summary: 'Seguir processo',
    tags: TAGS,
    auditActions: ['process.participant_add'],
    responses: {
      200: {
        description: `Participação \`OBSERVER\` do próprio usuário com \`notify = true\`. Quem já participa (em qualquer papel) recebe a participação existente, sem novo evento (RN-PROC-133). ${PARTICIPANT_EFFECTS}`,
        schema: dataEnvelope(processParticipantSchema),
      },
    },
  })
  async followProcess(@PathId('id') id: string): Promise<ProcessParticipantDto> {
    const { dto } = await this.follow.execute(id);
    return dto;
  }

  @Delete('processes/:id/follow')
  @HttpCode(204)
  @RequirePermission('PROCESS_FOLLOW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-32',
    summary: 'Deixar de seguir processo',
    tags: TAGS,
    auditActions: ['process.participant_remove'],
    responses: {
      204: {
        description:
          'Revoga a própria participação `OBSERVER` (sem participação = nada a fazer). Em outro papel → 403 `PERMISSION_DENIED`: a remoção é de quem gerencia os participantes (PRC-30 · RN-PROC-133).',
      },
    },
  })
  async unfollowProcess(@PathId('id') id: string): Promise<void> {
    await this.unfollow.execute(id);
  }
}
