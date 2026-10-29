import { ADMIN_ORGAO_SEEDED_PERMISSIONS } from '@contrataflow/validation';
import type { PermissionDto } from '@contrataflow/validation';

/*
 * Regras de exibição da matriz (SCR-031 · US-095): reflexo das políticas da API para a UI — a API
 * continua decidindo cada requisição (RN-FND-92).
 */

const PROTECTED: ReadonlySet<string> = new Set(ADMIN_ORGAO_SEEDED_PERMISSIONS);

/** Alcance do ator para POL-13. */
export interface ActorReach {
  readonly permissions: ReadonlySet<string>;
  /** Isento de POL-13 (perfil `ADMIN_ORGAO`). */
  readonly exempt: boolean;
}

/**
 * Alcance a partir das permissões efetivas (ME-03). ME-03 não informa os perfis do vínculo: quem
 * detém TODAS as permissões semeadas do `ADMIN_ORGAO` — que esse perfil nunca perde (RN-IAM-82) —
 * é tratado como administrador do órgão. Se a heurística errar, a API recusa com
 * `PRIVILEGE_ESCALATION_FORBIDDEN` e a tela explica.
 */
export function actorReach(codes: readonly string[]): ActorReach {
  const permissions = new Set(codes);
  return {
    permissions,
    exempt: ADMIN_ORGAO_SEEDED_PERMISSIONS.every((code) => permissions.has(code)),
  };
}

/**
 * Estado de um interruptor:
 * - `readonly`: sem `ROLE_MANAGE` (ou perfil inativo não editável — não se aplica no MVP 1);
 * - `protected`: permissão semeada do `ADMIN_ORGAO` (FA-01), sempre marcada;
 * - `out-of-reach`: o ator não possui a permissão e ela não está concedida (FA-02 · POL-13) —
 *   desmarcar o que já está concedido continua permitido;
 * - `enabled`.
 */
export type SwitchState = 'enabled' | 'readonly' | 'protected' | 'out-of-reach';

export function switchState(input: {
  readonly code: string;
  readonly isProtectedRole: boolean;
  readonly granted: ReadonlySet<string>;
  readonly canManage: boolean;
  readonly actor: ActorReach;
}): SwitchState {
  if (!input.canManage) return 'readonly';
  if (input.isProtectedRole && PROTECTED.has(input.code) && input.granted.has(input.code)) {
    return 'protected';
  }
  if (
    !input.actor.exempt &&
    !input.actor.permissions.has(input.code) &&
    !input.granted.has(input.code)
  ) {
    return 'out-of-reach';
  }
  return 'enabled';
}

/** Diff entre o salvo e o marcado (contagem do botão "Salvar matriz"). */
export function matrixDiff(
  granted: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...selected].filter((code) => !granted.has(code)),
    removed: [...granted].filter((code) => !selected.has(code)),
  };
}

/** Agrupa por módulo na ordem do catálogo (permissions.md §2). */
export function groupByModule(
  permissions: readonly PermissionDto[],
): { module: string; items: PermissionDto[] }[] {
  const groups = new Map<string, PermissionDto[]>();
  for (const permission of permissions) {
    const items = groups.get(permission.module);
    if (items) items.push(permission);
    else groups.set(permission.module, [permission]);
  }
  return [...groups].map(([module, items]) => ({ module, items }));
}

/** Busca sem acento e sem diferença de maiúsculas ("Descricao" encontra "Descrição"). */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Permissões cujo nome ou código contém o termo (vazio = todas). */
export function filterPermissions(
  permissions: readonly PermissionDto[],
  search: string,
): PermissionDto[] {
  const term = foldText(search.trim());
  if (term === '') return [...permissions];
  return permissions.filter(
    (permission) =>
      foldText(permission.name).includes(term) || foldText(permission.code).includes(term),
  );
}

/** Quantas permissões do conjunto estão marcadas. */
export function countSelected(
  permissions: readonly PermissionDto[],
  selected: ReadonlySet<string>,
): number {
  return permissions.filter((permission) => selected.has(permission.code)).length;
}
