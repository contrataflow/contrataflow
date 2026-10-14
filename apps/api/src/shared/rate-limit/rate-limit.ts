import { SetMetadata } from '@nestjs/common';

import type { RateLimitClass } from '#config/env.js';

export type { RateLimitClass } from '#config/env.js';

/**
 * Armazenamento dos contadores (Redis em `modules/platform` — RN-FND-36). Janela deslizante
 * aproximada: contador da janela fixa atual + contador da anterior, ponderado pelo tempo decorrido.
 */
export interface RateLimitStorePort {
  /** Incrementa o contador da janela `windowIndex` e devolve também o da janela anterior. */
  increment(
    baseKey: string,
    windowIndex: number,
    windowMs: number,
  ): Promise<{ readonly current: number; readonly previous: number }>;
}

export const RATE_LIMIT_STORE = Symbol('RateLimitStorePort');

export const RATE_LIMIT_METADATA = 'cf:rate-limit';

export interface RateLimitOptions {
  readonly class: RateLimitClass;
  /** Parâmetro de rota que compõe a chave (ex.: `documentId` no autosave — api.md §1.6). */
  readonly keyParam?: string;
}

/**
 * Classe de limite da rota (api.md §1.6). Sem o decorator: `GET`/`HEAD` → leitura; demais
 * métodos → escrita/comandos.
 */
export const RateLimit = (
  rateLimitClass: RateLimitClass,
  options: Omit<RateLimitOptions, 'class'> = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, {
    ...options,
    class: rateLimitClass,
  } satisfies RateLimitOptions);
