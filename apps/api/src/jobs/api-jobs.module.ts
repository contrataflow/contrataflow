import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { ConfigModule } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { API_MODULES } from '#modules/index.js';
import { DatabaseModule } from '#shared/database/database.module.js';
import { HealthModule } from '#shared/observability/health.module.js';

import { withoutControllers } from './headless-modules.js';

/**
 * Contexto Nest da API **sem HTTP** que o worker sobe para consumir as filas dos módulos da API
 * (DEC-052 · queues.md §4.4/§4.5/§4.5.1): configuração, banco (`TenantTransaction`), storage,
 * Gotenberg, antivírus, provedor de IA e todos os módulos de DEC-040 — os jobs dependem dos
 * registros síncronos de outros módulos (timeline, auditoria, outbox). Sem controllers, guards,
 * interceptors, middlewares, logger HTTP (`nestjs-pino`) nem rotas de health: o logger, o OTel e a
 * porta interna são os do worker. O `HealthRegistry` existe só porque os módulos de infraestrutura
 * registram nele os seus checks.
 */
@Module({})
export class ApiJobsModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ApiJobsModule,
      imports: [
        ConfigModule.forRoot(config),
        HealthModule,
        DatabaseModule,
        ...withoutControllers(API_MODULES),
      ],
    };
  }
}
