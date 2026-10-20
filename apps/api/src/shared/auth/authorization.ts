import type { PermissionCode, PolicyId } from '@contrataflow/types';
import { SetMetadata } from '@nestjs/common';
import type { Type } from '@nestjs/common';

import type { ProcessAccessTarget } from './process-access.js';

/*
 * Autorização declarada na rota (US-097 · DEC-134 · permissions.md §1 e §10): o
 * `AuthorizationGuard` lê `@RequirePermission`/`@Policy` do handler e delega a decisão ao
 * `AuthorizationService` do módulo `access` (porta `AUTHORIZATION_PORT`). Toda rota mutável declara
 * a permissão ou consta como capacidade implícita (`@ImplicitAccess`) — o meta-teste
 * `src/openapi/authorization-coverage.spec.ts` reprova o build caso contrário (RN-IAM-101).
 */

export const REQUIRE_PERMISSION_METADATA = 'cf:auth:require-permission';
export const POLICY_METADATA = 'cf:auth:policies';
export const IMPLICIT_ACCESS_METADATA = 'cf:auth:implicit-access';

/**
 * Recurso cujo escopo a permissão precisa cobrir (permissions.md §1.1):
 * - `ANY` (padrão) — a permissão em algum escopo; a listagem filtra pela visibilidade e o caso de
 *   uso confere o recurso quando ele vem no corpo (ex.: unidade solicitante do `PROCESS_CREATE`);
 * - `{ processParam }` — o processo do parâmetro de rota: não visível = 404 `PROCESS_NOT_FOUND`
 *   (FA-05); visível sem a permissão cobrindo-o (perfil ou participação) = 403 `PERMISSION_DENIED`.
 */
export type PermissionScopeRequirement = 'ANY' | { readonly processParam: string };

export interface PermissionRequirement {
  readonly permission: PermissionCode;
  readonly scope: PermissionScopeRequirement;
  /** Mensagem do 403 `PERMISSION_DENIED` da rota (padrão: a genérica de V-04). */
  readonly detail?: string;
}

export interface RequirePermissionOptions {
  readonly scope?: PermissionScopeRequirement;
  readonly detail?: string;
}

/** Permissão exigida pela rota (no método ou no controller; a do método prevalece). */
export const RequirePermission = (
  permission: PermissionCode,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_METADATA, {
    permission,
    scope: options.scope ?? 'ANY',
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  } satisfies PermissionRequirement);

/**
 * Capacidade implícita (permissions.md §7 · RN-IAM-101): a rota não exige permissão de perfil —
 * basta o vínculo ativo (ou o token, nas rotas sem tenant). O motivo (≥ 20 caracteres) é revisado
 * no PR e listado pelo meta-teste.
 */
export const ImplicitAccess = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(IMPLICIT_ACCESS_METADATA, reason);

/** Contexto entregue a uma política avaliada pelo guard. */
export interface PolicyContext {
  readonly userId: string;
  readonly membershipId: string;
  /** Parâmetros de rota (strings cruas do caminho). */
  readonly params: Readonly<Record<string, string | undefined>>;
  /** Processo do `scope.processParam` da permissão, quando houver. */
  readonly process: ProcessAccessTarget | null;
  /** A permissão em algum escopo efetivo do vínculo. */
  has(permission: PermissionCode): boolean;
}

export type PolicyResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Padrão: o `denialCode`/`denialStatus` da política (`CONTEXTUAL_POLICIES`). */
      readonly code?: string;
      readonly status?: number;
      readonly detail?: string;
    };

/**
 * Política contextual avaliada pelo guard depois da permissão (permissions.md §6). Provider Nest
 * comum (injetável), resolvido pela classe; a recusa vira `access.denied` com o ID da política em
 * `reasonCode` (RN-IAM-105).
 */
export interface ContextualPolicy {
  readonly id: PolicyId;
  evaluate(context: PolicyContext): PolicyResult | Promise<PolicyResult>;
}

/**
 * `@Policy(...)`: o ID (`'POL-13'`) declara uma política aplicada pelo caso de uso (precisa do corpo
 * ou da transação — ex.: anti-escalonamento); a classe (`@Policy(ProcessCustodyPolicy)`) é
 * avaliada pelo guard. Ambas entram na matriz de autorização.
 */
export type PolicyDeclaration = PolicyId | Type<ContextualPolicy>;

export const Policy = (...policies: PolicyDeclaration[]): MethodDecorator & ClassDecorator =>
  SetMetadata(POLICY_METADATA, policies);

/** Pedido de autorização de uma rota `@TenantScope('TENANT')`, montado pelo guard. */
export interface AuthorizationRequest {
  readonly requirement: PermissionRequirement | null;
  readonly policies: readonly PolicyDeclaration[];
  readonly params: Readonly<Record<string, string | undefined>>;
  /** Padrão da rota (sem IDs) para a auditoria `auth.mfa_required` (US-090). */
  readonly route?: string | null;
  /** Instância da política declarada pela classe (provider registrado ou criada com injeção). */
  readonly resolvePolicy: (type: Type<ContextualPolicy>) => Promise<ContextualPolicy>;
}

/**
 * Implementada pelo `AuthorizationService` (`access`): carrega as permissões efetivas do vínculo
 * no contexto da requisição (cache Redis → banco) e aplica a fórmula de decisão (RN-IAM-100).
 */
export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): Promise<void>;
}

export const AUTHORIZATION_PORT = Symbol('AuthorizationPort');

/** Metadados declarados num handler/controller sem `ExecutionContext` (meta-testes). */
export interface RouteAuthorization {
  readonly requirement: PermissionRequirement | undefined;
  readonly policies: readonly PolicyDeclaration[];
  readonly implicitReason: string | undefined;
}

export function routeAuthorizationOf(handler: object, controller: object): RouteAuthorization {
  const read = (key: string): unknown =>
    Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
  return {
    requirement: read(REQUIRE_PERMISSION_METADATA) as PermissionRequirement | undefined,
    policies: (read(POLICY_METADATA) as PolicyDeclaration[] | undefined) ?? [],
    implicitReason: read(IMPLICIT_ACCESS_METADATA) as string | undefined,
  };
}

/**
 * ID da política declarada: o próprio ID ou o `static policyId` da classe (lido sem instanciar —
 * meta-testes e matriz).
 */
export function policyIdOf(declaration: PolicyDeclaration): PolicyId {
  if (typeof declaration === 'string') return declaration;
  const id = (declaration as unknown as { readonly policyId?: PolicyId }).policyId;
  if (id === undefined) throw new Error(`Política ${declaration.name} sem \`static policyId\`.`);
  return id;
}
