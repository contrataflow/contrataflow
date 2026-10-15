/*
 * Manifesto da suíte "tenant leak" (US-100 · RN-TEN-36 · multi-tenancy.md §14): TODA operação da
 * API (OpenAPI, inclusive as internas) é classificada aqui — coberta pela suíte HTTP
 * (`test/tenant-leak/tenant-leak.spec.ts`) ou isenta com motivo. Rota nova sem classificação reprova
 * o build (`tenant-leak.spec.ts`). Ao criar uma rota com ID no caminho ou referência no corpo,
 * declare `pathParams`/`body` para que a suíte troque os IDs pelos do tenant B.
 */

/** Tipos de fixture do tenant B que a suíte sabe fornecer (cresce com as stories de negócio). */
export type LeakFixtureKind = 'membership' | 'department' | 'tenant';

/** IDs do tenant B por tipo de fixture (a suíte resolve). */
export type LeakIds = (kind: LeakFixtureKind) => string;

export interface CoveredOperation {
  readonly kind: 'covered';
  /** Parâmetros de caminho → fixture de B: a operação deve responder 404 `<RESOURCE>_NOT_FOUND`. */
  readonly pathParams?: Readonly<Record<string, LeakFixtureKind>>;
  /**
   * Corpo válido com referências de B: a operação deve responder 422 `REFERENCE_NOT_FOUND` em
   * `referenceFields`.
   */
  readonly body?: (ids: LeakIds) => unknown;
  readonly referenceFields?: readonly string[];
  /** Quem chama (padrão: usuário só do tenant A). */
  readonly caller?: 'single-tenant' | 'multi-tenant';
}

export interface ExemptOperation {
  readonly kind: 'exempt';
  /** Por que a operação não entra na suíte HTTP (≥ 20 caracteres, revisado no PR). */
  readonly reason: string;
}

export type TenantLeakCase = CoveredOperation | ExemptOperation;

const EXAMPLE_ROUTE =
  'Rota interna de exemplo do pipeline (US-080/US-084): não lê nem grava dados de tenant e fica fora do contrato público.';

/** Classificação por `operationId`. */
export const TENANT_LEAK_MANIFEST: Readonly<Record<string, TenantLeakCase>> = Object.freeze({
  'ME-01': { kind: 'covered' },
  'ME-04': { kind: 'covered' },
  'INTERNAL-SESSION-EVENTS': {
    kind: 'exempt',
    reason:
      'Contrato BFF → API com credencial de serviço, fora de /api/v1; vínculo de outra pessoa → 422 REFERENCE_NOT_FOUND coberto em identity/presentation/tenant-switch.routes.spec.ts.',
  },
  'INTERNAL-PING': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-ITEMS': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-FEED': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-ECHO': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-TRACE-DEMO-JOB': { kind: 'exempt', reason: EXAMPLE_ROUTE },
});
