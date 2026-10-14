import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { z } from 'zod';

import { WithoutTenant } from '#shared/auth/route-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';

/** Portão controlado pelo teste: o handler lento só termina quando o teste o abre. */
export class Gate {
  private release: (() => void) | undefined;
  entered: Promise<void>;
  private markEntered: (() => void) | undefined;
  private opened: Promise<void>;

  constructor() {
    this.entered = new Promise((resolve) => (this.markEntered = resolve));
    this.opened = new Promise((resolve) => (this.release = resolve));
  }

  async pass(): Promise<void> {
    this.markEntered?.();
    await this.opened;
  }

  open(): void {
    this.release?.();
  }
}

export const slowGate = { current: new Gate() };

/** Rotas usadas só pelos testes do pipeline (não fazem parte da aplicação). */
@Controller('_test')
export class PipelineTestController {
  @Get('context')
  async context() {
    // Intervalo assíncrono aleatório: força o entrelaçamento de requisições concorrentes.
    await sleep(randomInt(15));
    const context = requireRequestContext();
    return { correlationId: context.correlationId, userId: context.actor.userId };
  }

  @Post('slow')
  @HttpCode(201)
  @Idempotent()
  async slow() {
    await slowGate.current.pass();
    return { done: true };
  }

  @Post('fail')
  @Idempotent()
  fail(): never {
    throw new Error('segredo interno do servidor');
  }

  @Get('zod')
  zod(): never {
    z.object({ code: z.string() }).parse({});
    throw new Error('inalcançável');
  }

  @Patch('versioned')
  @RequireIfMatch()
  versioned(@IfMatch() ifMatch: IfMatchValue) {
    return ifMatch;
  }

  @Get('without-tenant')
  @WithoutTenant()
  withoutTenant() {
    const context = requireRequestContext();
    return { tenantId: context.tenantId, userId: context.actor.userId };
  }

  @Post('export')
  @RateLimit('export')
  @HttpCode(204)
  exportSomething(): void {
    // sem corpo: o envelope não é aplicado (204)
  }
}
