import { createLogger, serializeError, uuidv7 } from '@contrataflow/observability';
import type { DestinationStream, Logger } from '@contrataflow/observability';
import { Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import type { AppConfig } from '#config/env.js';

import { requestContextLogFields } from '../context/request-context.js';

/**
 * Logger pino da API (RN-FND-71): `service=api`, ambiente, versão e — em toda linha emitida durante
 * uma requisição — `correlationId`/`tenantId`/`userId`/`membershipId` do `RequestContext` e
 * `traceId`/`spanId` do span ativo. Redação de DEC-138 no pacote `@contrataflow/observability`.
 */
export function createApiLogger(config: AppConfig, destination?: DestinationStream): Logger {
  return createLogger({
    service: 'api',
    env: config.appEnv,
    version: config.observability.version,
    level: config.observability.logLevel,
    context: requestContextLogFields,
    ...(destination ? { destination } : {}),
  });
}

/**
 * Integra o pino ao NestJS via `nestjs-pino` (substitui o logger padrão em `bootstrap.ts`). O
 * `pino-http` só cria o logger da requisição com o `requestId` (UUIDv7 por salto): o log de fim de
 * requisição é do `RequestContextMiddleware`, que conhece o template da rota e o contexto final.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(logger: Logger): DynamicModule {
    return {
      module: ObservabilityModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger,
            autoLogging: false,
            quietReqLogger: true,
            genReqId: () => uuidv7(),
            customAttributeKeys: { reqId: 'requestId' },
            // Os serializers padrão do pino-http refariam o `err` já redigido pelo logger.
            wrapSerializers: false,
            serializers: { err: (error: unknown) => serializeError(error) },
          },
          // Sintaxe de curinga do Express 5 (a padrão `*` gera aviso de rota legada).
          forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
