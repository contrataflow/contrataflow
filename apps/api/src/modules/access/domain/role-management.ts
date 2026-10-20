import type { PermissionCode, PermissionRiskLevel } from '@contrataflow/types';
import { ADMIN_ORGAO_SEEDED_PERMISSIONS, PROTECTED_ROLE_KEY } from '@contrataflow/validation';

import type { Role } from './role.js';

/*
 * Regras puras da gestão de perfis (US-095 · RN-IAM-80..87 · POL-12/13/14 · DEC-035): criação com
 * chave gerada, edição de dados, diff da matriz, anti-escalonamento, proteção do `ADMIN_ORGAO`,
 * desativação e nome da cópia. Sem Nest, Prisma nem contexto de requisição.
 */

/** Tamanho máximo do nome (`roles.name VARCHAR(120)`) e da chave (`roles_key_format`). */
const NAME_MAX = 120;
const KEY_MAX = 60;
/** Prefixo quando o nome não começa por letra (a chave precisa começar por letra). */
const KEY_PREFIX = 'PERFIL_';

/**
 * RN-IAM-80: chave SCREAMING_SNAKE_CASE ASCII a partir do nome — sem acentos, só letras/dígitos
 * separados por `_`, começando por letra, até 60 caracteres. `null` se o nome não tiver letra nem
 * dígito (nada de que derivar a chave).
 */
export function generateRoleKey(name: string): string | null {
  const ascii = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii === '') return null;
  const key = /^[A-Z]/.test(ascii) ? ascii : `${KEY_PREFIX}${ascii}`;
  return key.slice(0, KEY_MAX).replace(/_+$/, '');
}

/** Nome sem distinção de maiúsculas (RN-IAM-87 · índice `lower(name)`). */
export function sameRoleName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** V-03 sem chave derivável: o nome não tem letras nem dígitos. */
export class RoleKeyUnderivableError extends Error {
  constructor() {
    super('Nome de perfil sem letras nem dígitos para gerar a chave.');
    this.name = 'RoleKeyUnderivableError';
  }
}

export interface NewRoleInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly allowExternalAssignment?: boolean | undefined;
}

export interface MutationData {
  readonly now: Date;
  readonly userId: string | null;
}

/**
 * `Role.create` (RN-IAM-80): perfil personalizado — `isSystem = false`, `isProtected = false`,
 * ativo, versão 1, chave gerada do nome (imutável dali em diante).
 */
export function createRole(
  input: NewRoleInput,
  data: MutationData & { readonly id: string; readonly tenantId: string },
): Role {
  const key = generateRoleKey(input.name);
  if (key === null) throw new RoleKeyUnderivableError();
  return {
    id: data.id,
    tenantId: data.tenantId,
    key,
    name: input.name,
    description: emptyToNull(input.description),
    isSystem: false,
    isProtected: false,
    allowExternalAssignment: input.allowExternalAssignment ?? false,
    isActive: true,
    createdAt: data.now,
    updatedAt: data.now,
    createdById: data.userId,
    updatedById: data.userId,
    version: 1,
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

export type RoleUpdatableField = 'name' | 'description' | 'allowExternalAssignment';

export interface RoleFieldChange {
  readonly path: RoleUpdatableField;
  readonly old: unknown;
  readonly new: unknown;
}

export interface RoleDetailsUpdate {
  readonly next: Role;
  readonly changes: readonly RoleFieldChange[];
}

/** ROL-05: aplica só os campos que mudaram; nada mudou → `changes` vazio e `next` = atual. */
export function updateRoleDetails(
  role: Role,
  patch: {
    readonly name?: string | undefined;
    readonly description?: string | null | undefined;
    readonly allowExternalAssignment?: boolean | undefined;
  },
  data: MutationData,
): RoleDetailsUpdate {
  const changes: RoleFieldChange[] = [];
  let next: Role = role;
  if (patch.name !== undefined && patch.name !== role.name) {
    changes.push({ path: 'name', old: role.name, new: patch.name });
    next = { ...next, name: patch.name };
  }
  if (patch.description !== undefined) {
    const description = emptyToNull(patch.description);
    if (description !== role.description) {
      changes.push({ path: 'description', old: role.description, new: description });
      next = { ...next, description };
    }
  }
  if (
    patch.allowExternalAssignment !== undefined &&
    patch.allowExternalAssignment !== role.allowExternalAssignment
  ) {
    changes.push({
      path: 'allowExternalAssignment',
      old: role.allowExternalAssignment,
      new: patch.allowExternalAssignment,
    });
    next = { ...next, allowExternalAssignment: patch.allowExternalAssignment };
  }
  if (changes.length === 0) return { next: role, changes };
  return { next: { ...next, updatedAt: data.now, updatedById: data.userId }, changes };
}

/**
 * RN-IAM-83 · POL-14: ligar `allowExternalAssignment` (de `false` para `true`) num perfil que tem —
 * ou terá — ao menos uma permissão de risco `HIGH` exige MFA na sessão, qualquer que seja
 * `security.mfaPolicy`.
 */
export function externalAssignmentNeedsMfa(input: {
  readonly wasAllowed: boolean;
  readonly willAllow: boolean;
  readonly permissions: readonly PermissionCode[];
  readonly riskOf: (code: PermissionCode) => PermissionRiskLevel;
}): boolean {
  return (
    !input.wasAllowed &&
    input.willAllow &&
    input.permissions.some((code) => input.riskOf(code) === 'HIGH')
  );
}

export interface PermissionDiff {
  readonly added: readonly PermissionCode[];
  readonly removed: readonly PermissionCode[];
}

/** Diff da matriz (ROL-06), cada lado na ordem em que aparece. */
export function diffPermissions(
  current: readonly PermissionCode[],
  next: readonly PermissionCode[],
): PermissionDiff {
  const before = new Set(current);
  const after = new Set(next);
  return {
    added: [...after].filter((code) => !before.has(code)),
    removed: [...before].filter((code) => !after.has(code)),
  };
}

/** Permissões efetivas do ator para POL-13 (RN-IAM-81). */
export interface ActorGrants {
  readonly permissions: ReadonlySet<PermissionCode>;
  /** Possui o perfil `ADMIN_ORGAO`: isento da checagem de anti-escalonamento. */
  readonly isTenantAdmin: boolean;
}

/** POL-13: concessão de permissão que o ator não possui (V-04). */
export class PrivilegeEscalationError extends Error {
  constructor(readonly permissions: readonly PermissionCode[]) {
    super(`Concessão acima do próprio ator: ${permissions.join(', ')}.`);
    this.name = 'PrivilegeEscalationError';
  }
}

/**
 * POL-13 · RN-IAM-81: toda permissão concedida (`granted` — na criação, na duplicação ou as novas
 * da matriz) precisa estar entre as do próprio ator, salvo se ele tiver `ADMIN_ORGAO`.
 */
export function assertNoPrivilegeEscalation(
  granted: readonly PermissionCode[],
  actor: ActorGrants,
): void {
  if (actor.isTenantAdmin) return;
  const missing = granted.filter((code) => !actor.permissions.has(code));
  if (missing.length > 0) throw new PrivilegeEscalationError(missing);
}

const PROTECTED_PERMISSIONS: ReadonlySet<string> = new Set(ADMIN_ORGAO_SEEDED_PERMISSIONS);

/** RN-IAM-82 · V-05: a matriz removeria permissão protegida do `ADMIN_ORGAO`. */
export class ProtectedPermissionRemovalError extends Error {
  constructor(readonly permissions: readonly PermissionCode[]) {
    super(`Permissões protegidas do Administrador do órgão: ${permissions.join(', ')}.`);
    this.name = 'ProtectedPermissionRemovalError';
  }
}

/**
 * RN-IAM-82 (DEC-035): perfil `isProtected` nunca perde permissão presente desde a semeadura; a
 * submissão inteira é recusada (nada parcial). Adicionar permissões é livre.
 */
export function assertProtectedPermissionsKept(
  role: Pick<Role, 'isProtected'>,
  removed: readonly PermissionCode[],
): void {
  if (!role.isProtected) return;
  const blocked = removed.filter((code) => PROTECTED_PERMISSIONS.has(code));
  if (blocked.length > 0) throw new ProtectedPermissionRemovalError(blocked);
}

/** Permissão protegida (FA-01): a UI trava o interruptor e a API recusa a remoção. */
export function isProtectedPermission(
  role: Pick<Role, 'isProtected'>,
  code: PermissionCode,
): boolean {
  return role.isProtected && PROTECTED_PERMISSIONS.has(code);
}

/** POL-12 · RN-IAM-84 · V-06: desativar o `ADMIN_ORGAO` é sempre bloqueado. */
export class LastAdminRequiredError extends Error {
  constructor() {
    super('O perfil Administrador do órgão não pode ser desativado.');
    this.name = 'LastAdminRequiredError';
  }
}

/** FA-04: há vínculos ativos com o perfil e a desativação não foi confirmada explicitamente. */
export class DeactivationNotConfirmedError extends Error {
  constructor(readonly activeAssignments: number) {
    super(`Desativação não confirmada com ${activeAssignments} vínculo(s) ativo(s).`);
    this.name = 'DeactivationNotConfirmedError';
  }
}

/**
 * `Role.deactivate` (RN-IAM-84): `ADMIN_ORGAO` nunca (POL-12); com vínculos ativos, só com
 * `confirmDeactivate`; perfil já inativo → `null` (nada a fazer). As atribuições são preservadas e
 * deixam de conceder permissões enquanto o perfil estiver inativo.
 */
export function deactivateRole(
  role: Role,
  input: { readonly activeAssignments: number; readonly confirmed: boolean },
  data: MutationData,
): Role | null {
  if (role.isProtected || role.key === PROTECTED_ROLE_KEY) throw new LastAdminRequiredError();
  if (!role.isActive) return null;
  if (input.activeAssignments > 0 && !input.confirmed) {
    throw new DeactivationNotConfirmedError(input.activeAssignments);
  }
  return { ...role, isActive: false, updatedAt: data.now, updatedById: data.userId };
}

const COPY_SUFFIX = ' (cópia)';

/**
 * RN-IAM-86: nome da cópia — "{nome} (cópia)", depois "(cópia 2)", "(cópia 3)"… até um nome cuja
 * forma minúscula e cuja chave gerada ainda não existam no tenant. O nome de origem é encurtado
 * para caber nos 120 caracteres com o sufixo.
 */
export function duplicateRoleName(
  sourceName: string,
  taken: { readonly names: readonly string[]; readonly keys: readonly string[] },
): string {
  const names = new Set(taken.names.map((name) => name.toLowerCase()));
  const keys = new Set(taken.keys);
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? COPY_SUFFIX : ` (cópia ${attempt})`;
    const name = `${sourceName.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    const key = generateRoleKey(name);
    if (!names.has(name.toLowerCase()) && key !== null && !keys.has(key)) return name;
  }
}
