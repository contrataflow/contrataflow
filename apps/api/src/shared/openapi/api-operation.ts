import type { AuditAction } from '@contrataflow/types';
import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const API_OPERATION_METADATA = 'cf:openapi:operation';
export const API_REQUEST_METADATA = 'cf:openapi:request';

export interface ApiResponseSpec {
  readonly description: string;
  /** Schema do corpo de sucesso (já com envelope — `dataEnvelope`, `pageEnvelope`…). */
  readonly schema?: z.ZodType;
  /** Tipos de mídia do corpo quando não é JSON (arquivo — ex.: `text/csv` de AUD-03). */
  readonly contentTypes?: readonly string[];
}

export interface ApiOperationSpec {
  /** Identificador do catálogo de api.md §3 quando houver (ex.: `PRC-05`). */
  readonly operationId: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  /** Respostas de sucesso por status; os erros RFC 9457 são acrescentados pelo gerador. */
  readonly responses: Readonly<Record<number, ApiResponseSpec>>;
  /** Rotas internas (`/_internal/*`) ficam fora do contrato público versionado. */
  readonly internal?: boolean;
  /** Rota aceita `Idempotency-Key` (DEC-105). */
  readonly idempotent?: boolean;
  /**
   * Ações de auditoria que a rota grava (RN-AUD-09 · events.md §7): obrigatório em
   * POST/PUT/PATCH/DELETE, salvo `auditExempt`. Vai para o OpenAPI como `x-audit-actions`; o
   * meta-teste `audit-coverage.spec.ts` reprova o build se faltar.
   */
  readonly auditActions?: readonly AuditAction[];
  /** Rota mutável sem auditoria própria, com a justificativa (`x-audit-exempt`). */
  readonly auditExempt?: string;
  /**
   * Corpo que não é JSON (ex.: `multipart/form-data` do upload da planilha — PRS-18), documentado no
   * lugar do schema do `@ZodBody`.
   */
  readonly requestBody?: { readonly contentType: string; readonly schema: z.ZodType };
}

/** Metadados de documentação lidos pelo `openapi:generate` (RN-FND-38). */
export const ApiOperation = (spec: ApiOperationSpec): MethodDecorator =>
  SetMetadata(API_OPERATION_METADATA, spec);

export type RequestPart = 'body' | 'query' | 'params';

/** Schemas de entrada registrados pelos decorators `ZodBody`/`ZodQuery`/`ZodParams`. */
export type RequestSchemas = Partial<Record<RequestPart, z.ZodType>>;

/** Registra o schema de uma parte da requisição no método (usado pelos decorators de parâmetro). */
export function recordRequestSchema(
  target: object,
  propertyKey: string | symbol,
  part: RequestPart,
  schema: z.ZodType,
): void {
  const handler = (target as Record<string | symbol, unknown>)[propertyKey] as object;
  const current = (Reflect.getMetadata(API_REQUEST_METADATA, handler) ?? {}) as RequestSchemas;
  Reflect.defineMetadata(API_REQUEST_METADATA, { ...current, [part]: schema }, handler);
}
