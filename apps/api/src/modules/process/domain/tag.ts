import {
  DEFAULT_TAG_COLOR,
  TAG_MESSAGES,
  tagNameKey,
  tagSetIssues,
} from '@contrataflow/validation';
import type { FieldError, ProcessStatus, UpdateTag } from '@contrataflow/validation';

/*
 * `Tag` (US-007 · entities.md §4.4 · RN-PROC-85..92): etiqueta do órgão, nunca excluída — a
 * desativação (`isActive = false`) a tira das seleções novas e mantém as associações. Funções puras:
 * a unicidade do nome (`lower(name)`) é do banco; aqui ficam o diff de campos, o diff do conjunto
 * de etiquetas de um processo e a validação do conjunto (RN-PROC-88).
 */

export interface Tag {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly color: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface NewTagInput {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly color?: string | undefined;
  readonly now: Date;
  readonly userId: string | null;
}

/** RN-PROC-85: etiqueta nova — ativa, cor padrão `#64748B` quando a cor não é informada. */
export function newTag(input: NewTagInput): Tag {
  return {
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    color: input.color ?? DEFAULT_TAG_COLOR,
    isActive: true,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.userId,
    updatedById: input.userId,
    version: 1,
  };
}

/** Campos editáveis na ordem canônica do diff e da auditoria (TAG-03). */
export const TAG_FIELDS = ['name', 'color', 'isActive'] as const;
export type TagField = (typeof TAG_FIELDS)[number];

export interface TagChange {
  readonly path: TagField;
  readonly old: string | boolean;
  readonly new: string | boolean;
}

export interface TagPatchResult {
  readonly tag: Tag;
  readonly changes: readonly TagChange[];
}

/**
 * RN-PROC-90 · TAG-03: aplica o PATCH e devolve só a diferença efetiva (nome com `trim` já vindo do
 * schema; trocar só a caixa do nome é uma alteração). Sem diferença = a etiqueta atual, sem versão.
 */
export function applyTagPatch(
  tag: Tag,
  patch: UpdateTag,
  context: { readonly now: Date; readonly userId: string | null },
): TagPatchResult {
  const changes: TagChange[] = [];
  if (patch.name !== undefined && patch.name !== tag.name) {
    changes.push({ path: 'name', old: tag.name, new: patch.name });
  }
  if (patch.color !== undefined && patch.color !== tag.color) {
    changes.push({ path: 'color', old: tag.color, new: patch.color });
  }
  if (patch.isActive !== undefined && patch.isActive !== tag.isActive) {
    changes.push({ path: 'isActive', old: tag.isActive, new: patch.isActive });
  }
  if (changes.length === 0) return { tag, changes };
  const next: Tag = {
    ...tag,
    name: patch.name ?? tag.name,
    color: patch.color ?? tag.color,
    isActive: patch.isActive ?? tag.isActive,
    updatedAt: context.now,
    updatedById: context.userId,
  };
  return { tag: next, changes };
}

/** Auditoria de TAG-03: desativar = `tag.deactivate`; qualquer outra alteração = `tag.update`. */
export function tagUpdateAction(changes: readonly TagChange[]): 'tag.update' | 'tag.deactivate' {
  return changes.some((change) => change.path === 'isActive' && change.new === false)
    ? 'tag.deactivate'
    : 'tag.update';
}

/** `true` quando o nome já é usado por outra etiqueta do tenant (sem diferenciar maiúsculas). */
export function isTagNameTaken(tags: readonly Tag[], name: string, exceptId?: string): boolean {
  const key = tagNameKey(name);
  return tags.some((tag) => tag.id !== exceptId && tagNameKey(tag.name) === key);
}

export interface TagSetDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** RN-PROC-87/89: a diferença entre o conjunto atual e o enviado (ordem do conjunto de origem). */
export function diffTagSets(current: readonly string[], next: readonly string[]): TagSetDiff {
  const before = new Set(current);
  const after = new Set(next);
  return {
    added: next.filter((id) => !before.has(id)),
    removed: current.filter((id) => !after.has(id)),
  };
}

const tagIdsError = (code: FieldError['code'], message: string): FieldError => ({
  field: 'tagIds',
  code,
  message,
});

/**
 * RN-PROC-88: limite de 10 (`OUT_OF_RANGE`) e repetição (`DUPLICATE_IN_LIST`) do conjunto enviado;
 * id inexistente ou de outro tenant → `REFERENCE_NOT_FOUND`; etiqueta inativa só é aceita se já
 * estava aplicada ao processo (`REFERENCE_INACTIVE` para as novas). Um erro por código.
 */
export function tagSetErrors(
  tagIds: readonly string[],
  known: readonly Tag[],
  applied: ReadonlySet<string>,
): FieldError[] {
  const errors: FieldError[] = tagSetIssues(tagIds).map((issue) =>
    tagIdsError(issue.code, issue.message),
  );
  const byId = new Map(known.map((tag) => [tag.id, tag]));
  if (tagIds.some((id) => !byId.has(id))) {
    errors.push(tagIdsError('REFERENCE_NOT_FOUND', TAG_MESSAGES.invalidSet));
  }
  if (tagIds.some((id) => byId.get(id)?.isActive === false && !applied.has(id))) {
    errors.push(tagIdsError('REFERENCE_INACTIVE', TAG_MESSAGES.invalidSet));
  }
  return errors;
}

/** POL-01/RN-PROC-87: mensagem do status em que as etiquetas não podem ser alteradas. */
export function tagsNotEditableMessage(status: ProcessStatus): string {
  const labels: Partial<Record<ProcessStatus, string>> = {
    AWAITING_APPROVAL: 'aguardando aprovação',
    SUSPENDED: 'suspenso',
    CANCELED: 'cancelado',
    COMPLETED: 'concluído',
    PUBLISHED: 'publicado',
  };
  return `Etiquetas não podem ser alteradas com o processo ${labels[status] ?? status}.`;
}
