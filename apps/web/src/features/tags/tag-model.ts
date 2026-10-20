import { TAG_LIMITS, tagNameKey, tagNameSchema } from '@contrataflow/validation';
import type { TagDto } from '@contrataflow/validation';

/*
 * Regras puras do seletor e da administração de etiquetas (US-007): quais opções o seletor mostra,
 * busca sem acento, limite de 10 e a criação rápida. A paleta, os limites e a validação do nome
 * vêm de `@contrataflow/validation` — a mesma regra da API.
 */

/** Texto do chip sobre a cor da paleta (contraste AA garantido por `TAG_PALETTE`). */
export const TAG_TEXT_COLOR = '#FFFFFF';

/** Etiqueta como o cabeçalho e a lista a mostram (`color` nula = sem cor definida). */
export interface AppliedTag {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly isActive: boolean;
}

export interface PickerOption {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly isActive: boolean;
}

const byName = (a: PickerOption, b: PickerOption) =>
  a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);

/** Busca sem acento nem caixa ("Obras" acha "obras emergenciais" e "Óbras"). */
export function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Opções do seletor (FA-03): as etiquetas ATIVAS do catálogo e as inativas já aplicadas ao processo
 * (que só podem ser removidas). Inativas fora do processo nunca aparecem.
 */
export function pickerOptions(
  catalog: readonly TagDto[],
  applied: readonly AppliedTag[],
): PickerOption[] {
  const options = new Map<string, PickerOption>();
  for (const tag of catalog) {
    if (tag.isActive) options.set(tag.id, tag);
  }
  for (const tag of applied) {
    const known = catalog.find((candidate) => candidate.id === tag.id);
    options.set(tag.id, {
      id: tag.id,
      name: known?.name ?? tag.name,
      color: known?.color ?? tag.color,
      isActive: known?.isActive ?? tag.isActive,
    });
  }
  return [...options.values()].sort(byName);
}

export function filterOptions(
  options: readonly PickerOption[],
  query: string,
): readonly PickerOption[] {
  const key = searchKey(query);
  return key === '' ? options : options.filter((option) => searchKey(option.name).includes(key));
}

/** Marca ou desmarca; no limite de 10, marcar uma nova não muda a seleção (RN-PROC-88). */
export function nextSelection(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((value) => value !== id);
  return selected.length >= TAG_LIMITS.perProcess ? [...selected] : [...selected, id];
}

export function atLimit(selected: readonly string[]): boolean {
  return selected.length >= TAG_LIMITS.perProcess;
}

/** A seleção difere do conjunto aplicado (sem ordem)? */
export function selectionChanged(initial: readonly string[], selected: readonly string[]): boolean {
  if (initial.length !== selected.length) return true;
  const before = new Set(initial);
  return selected.some((id) => !before.has(id));
}

/**
 * FA-01: nome para "Criar etiqueta" quando a busca é um nome válido (2–40) que ainda não existe —
 * ativa ou inativa — no cadastro. `null` = não oferecer a criação.
 */
export function quickCreateName(query: string, known: readonly { name: string }[]): string | null {
  const parsed = tagNameSchema.safeParse(query);
  if (!parsed.success) return null;
  const key = tagNameKey(parsed.data);
  return known.some((tag) => tagNameKey(tag.name) === key) ? null : parsed.data;
}

/** Ids marcados que ainda existem entre as opções (mantém a seleção após recarregar). */
export function keepKnown(selected: readonly string[], options: readonly PickerOption[]): string[] {
  const known = new Set(options.map((option) => option.id));
  return selected.filter((id) => known.has(id));
}
