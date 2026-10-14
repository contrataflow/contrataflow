/*
 * Convenção de query keys do TanStack Query (architecture.md §8.5 · RN-FND-90): o primeiro
 * segmento é sempre o tenant (`['t', tenantId, …]`), para que nenhum dado sobreviva à troca de
 * instituição. Exceções: dados do usuário independentes de tenant (`['me']`, `['me', 'memberships']`).
 */

export type TenantQueryKey = readonly ['t', string, ...unknown[]];

/** Raiz de todas as consultas de um tenant. */
export function tenantKey<const T extends readonly unknown[]>(
  tenantId: string,
  ...parts: T
): readonly ['t', string, ...T] {
  if (tenantId === '') throw new Error('tenantId obrigatório na query key.');
  return ['t', tenantId, ...parts] as const;
}

export const meKeys = {
  all: ['me'] as const,
  memberships: ['me', 'memberships'] as const,
};

/** Permissões efetivas dependem do tenant ativo (ME-03 com `X-Tenant-Id`). */
export const permissionKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'me', 'permissions'),
};

/** `true` se a chave pertence ao tenant informado (ou a qualquer tenant, sem argumento). */
export function isTenantKey(key: readonly unknown[], tenantId?: string): key is TenantQueryKey {
  return (
    key[0] === 't' && typeof key[1] === 'string' && (tenantId === undefined || key[1] === tenantId)
  );
}

/** Chaves permitidas sem tenant (dados do próprio usuário). */
export function isUserKey(key: readonly unknown[]): boolean {
  return key[0] === 'me' && (key.length === 1 || (key.length === 2 && key[1] === 'memberships'));
}

/** Toda chave deve ser de tenant ou de usuário (guarda usada pelo QueryClient em desenvolvimento e testes). */
export function assertQueryKeyConvention(key: readonly unknown[]): void {
  if (!isTenantKey(key) && !isUserKey(key)) {
    throw new Error(`Query key fora da convenção ['t', tenantId, …]: ${JSON.stringify(key)}`);
  }
}
