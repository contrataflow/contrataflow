import type { PolicyId } from '@contrataflow/types';
import { Body, Controller, Get, HttpCode, Injectable, Param, Post } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { AccessFacade } from '#modules/access/application/access.facade.js';
import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import type { ContextualPolicy, PolicyContext, PolicyResult } from '#shared/auth/authorization.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';

/*
 * Rotas de prova da autorização (US-097): os casos de uso reais de processo (criar, consultar,
 * cancelar, comentar) chegam com as stories de negócio; aqui eles só exercitam o mecanismo — guard,
 * decorators, escopo do processo, participação e políticas — pelo pipeline HTTP completo.
 */

/** Política de prova: o ID e a decisão são trocados pelo teste (POL-01..17). */
@Injectable()
export class ProbePolicy implements ContextualPolicy {
  static policyId: PolicyId = 'POL-01';
  static deny = false;
  static lastContext: PolicyContext | null = null;

  get id(): PolicyId {
    return ProbePolicy.policyId;
  }

  evaluate(context: PolicyContext): PolicyResult {
    ProbePolicy.lastContext = context;
    return ProbePolicy.deny ? { allowed: false } : { allowed: true };
  }
}

@Controller('_test/authz')
@TenantScope('TENANT')
export class AuthorizationProbeController {
  // O módulo raiz de teste não reexporta a fachada: lida do contêiner, como faria um caso de uso.
  constructor(private readonly moduleRef: ModuleRef) {}

  private get access(): AccessFacade {
    return this.moduleRef.get(AccessFacade, { strict: false });
  }

  /** "Criar processo" na unidade solicitante do corpo (`PROCESS_CREATE` cobrindo a unidade). */
  @Post('processes')
  @HttpCode(201)
  @RequirePermission('PROCESS_CREATE')
  async create(@Body() body: { readonly requestingDepartmentId: string }) {
    await this.access.assertCanInDepartment(
      'PROCESS_CREATE',
      { id: body.requestingDepartmentId, organizationId: null },
      { mfaPolicy: 'NONE' },
    );
    return { created: true };
  }

  @Get('processes/:id')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  view(@Param('id') id: string) {
    return { id };
  }

  @Post('processes/:id/cancel')
  @HttpCode(200)
  @RequirePermission('PROCESS_CANCEL', { scope: { processParam: 'id' } })
  cancel(@Param('id') id: string) {
    return { canceled: id };
  }

  /** Participação `COLLABORATOR`/`OBSERVER` concede `COMMENT_CREATE` naquele processo (FA-02). */
  @Post('processes/:id/comments')
  @HttpCode(201)
  @RequirePermission('COMMENT_CREATE', { scope: { processParam: 'id' } })
  comment(@Param('id') id: string) {
    return { commented: id };
  }

  @Post('processes/:id/policy')
  @HttpCode(200)
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @Policy(ProbePolicy)
  guarded(@Param('id') id: string) {
    return { id };
  }

  @Post('implicit')
  @HttpCode(200)
  @ImplicitAccess('Rota de prova sem permissão de perfil (vínculo ativo basta).')
  implicit() {
    return { ok: true };
  }
}
