import {
  contrastAgainstWhite,
  PLATFORM_UPLOAD_EXTENSIONS,
  SETTING_DEFINITIONS,
  SETTING_GROUPS,
  settingGroupOf,
  settingSchemaOf,
} from '@contrataflow/validation';
import type { SettingGroup, SettingsMapDto } from '@contrataflow/validation';

/*
 * Modelo do formulário da SCR-041 (US-103): agrupamento por prefixo, tipo de editor por chave,
 * rascunhos e validação com os MESMOS schemas Zod da API (RN-TEN-53). Funções puras.
 */

/** Editor de cada chave (`SettingField`). */
export type FieldKind =
  | 'text'
  | 'mask'
  | 'color'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'select'
  | 'extensions'
  | 'json'
  | 'readonly';

/** Valores aceitos pelos seletores (iguais aos enums do registro). */
export const SELECT_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  'security.mfaPolicy': ['NONE', 'ADMINS', 'ALL'],
  'numbering.process.scope': ['TENANT', 'ORGANIZATION'],
  'numbering.process.assignOn': ['CREATE', 'START'],
  'priceResearch.defaultMethod': ['AUTO_CV', 'MEAN', 'MEDIAN', 'LOWEST'],
  'priceResearch.roundingMode': ['HALF_UP', 'HALF_EVEN'],
  'priceResearch.unitPriceDecimals': ['2', '4'],
};

export const EXTENSION_OPTIONS: readonly string[] = PLATFORM_UPLOAD_EXTENSIONS;

const NUMBER_KEYS = new Set([
  'priceResearch.cvThresholdPercent',
  'priceResearch.outlierLowerPercent',
  'priceResearch.outlierUpperPercent',
]);

export function fieldKindOf(key: string): FieldKind {
  if (key === 'branding.primaryColor') return 'color';
  if (key === 'branding.logoAttachmentId') return 'readonly';
  if (key === 'numbering.process.mask' || key === 'numbering.document.defaultMask') return 'mask';
  if (key === 'uploads.allowedExtensions') return 'extensions';
  if (key === 'risk.scale' || key === 'risk.levelThresholds') return 'json';
  if (key in SELECT_OPTIONS) return 'select';
  if (NUMBER_KEYS.has(key)) return 'number';
  if (key.startsWith('features.')) return 'boolean';
  const definition = SETTING_DEFINITIONS.find((item) => item.key === key);
  if (typeof definition?.defaultValue === 'boolean') return 'boolean';
  if (typeof definition?.defaultValue === 'number') return 'integer';
  return 'text';
}

/** Chaves com efeito apenas a partir do próximo número/exercício (RN-TEN-58 · FA-01). */
export function hasFutureEffect(key: string): boolean {
  return key.startsWith('numbering.');
}

export interface SettingGroupModel {
  readonly group: SettingGroup;
  readonly keys: readonly string[];
}

/** Grupos na ordem da SCR-041; só os que têm alguma chave na resposta (SET-01). */
export function groupSettings(settings: SettingsMapDto): readonly SettingGroupModel[] {
  const keys = Object.keys(settings);
  return SETTING_GROUPS.map((group) => ({
    group,
    keys: keys.filter((key) => settingGroupOf(key) === group),
  })).filter((model) => model.keys.length > 0);
}

/** Rascunho de um campo: texto digitado, booleano, escolha ou lista de extensões. */
export type Draft = string | boolean | readonly string[];

/** Valor de SET-01 → rascunho do editor. */
export function toDraft(key: string, value: unknown): Draft {
  switch (fieldKindOf(key)) {
    case 'boolean':
      return value === true;
    case 'extensions':
      return Array.isArray(value) ? (value as string[]) : [];
    case 'json':
      return JSON.stringify(value, null, 2);
    case 'integer':
    case 'number':
    case 'select':
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'invalid' | 'number' | 'json' | 'contrast' };

/** Rascunho → valor tipado, validado pelo schema do registro (RN-TEN-53). */
export function parseDraft(key: string, draft: Draft): ParseResult {
  const kind = fieldKindOf(key);
  let candidate: unknown = draft;
  if (kind === 'integer' || kind === 'number' || key === 'priceResearch.unitPriceDecimals') {
    const text = typeof draft === 'string' ? draft.trim().replace(',', '.') : '';
    const parsed = Number(text);
    if (text === '' || !Number.isFinite(parsed)) return { ok: false, reason: 'number' };
    candidate = parsed;
  } else if (kind === 'json') {
    try {
      candidate = JSON.parse(String(draft)) as unknown;
    } catch {
      return { ok: false, reason: 'json' };
    }
  } else if (kind === 'extensions') {
    candidate = [...(draft as readonly string[])];
  }
  const result = settingSchemaOf(key)?.safeParse(candidate);
  if (result?.success !== true) {
    const contrast =
      kind === 'color' && typeof draft === 'string' && /^#[0-9A-Fa-f]{6}$/.test(draft);
    return { ok: false, reason: contrast ? 'contrast' : 'invalid' };
  }
  return { ok: true, value: result.data };
}

/** Contraste insuficiente para texto branco sobre a cor (AA = 4,5:1). */
export function isLowContrast(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color) && contrastAgainstWhite(color) < 4.5;
}

export interface PendingChange {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

export interface DraftEvaluation {
  /** Chaves cujo valor difere do atual, com valor tipado e versão esperada. */
  readonly changes: readonly PendingChange[];
  /** Erro por chave (rascunho inválido). */
  readonly errors: Readonly<Record<string, Exclude<ParseResult, { ok: true }>['reason']>>;
}

/** Compara os rascunhos com SET-01: só o que mudou e é válido vira `PendingChange`. */
export function evaluateDrafts(
  settings: SettingsMapDto,
  drafts: Readonly<Record<string, Draft>>,
): DraftEvaluation {
  const changes: PendingChange[] = [];
  const errors: Record<string, Exclude<ParseResult, { ok: true }>['reason']> = {};
  for (const [key, draft] of Object.entries(drafts)) {
    const current = settings[key];
    if (!current) continue;
    const parsed = parseDraft(key, draft);
    if (!parsed.ok) {
      errors[key] = parsed.reason;
      continue;
    }
    if (JSON.stringify(parsed.value) === JSON.stringify(current.value)) continue;
    changes.push({ key, value: parsed.value, version: current.version });
  }
  return { changes, errors };
}

/** Corpo de SET-02 a partir das alterações pendentes. */
export function buildPatchBody(changes: readonly PendingChange[]): {
  values: Record<string, unknown>;
  expectedVersions: Record<string, number>;
} {
  const values: Record<string, unknown> = {};
  const expectedVersions: Record<string, number> = {};
  for (const change of changes) {
    values[change.key] = change.value;
    expectedVersions[change.key] = change.version;
  }
  return { values, expectedVersions };
}

/** Tipos dos tokens de máscara exibidos nas mensagens. */
export const MASK_TOKENS = { seqToken: '{seq:N}', yearToken: '{year}', orgToken: '{org}' } as const;

const MASK_KEY = 'numbering.process.mask';
const SCOPE_KEY = 'numbering.process.scope';

/**
 * Máscara do processo × escopo (SET-02): com escopo `ORGANIZATION` a máscara precisa de `{org}`.
 * Só vale quando o formulário altera uma das duas chaves.
 */
export function maskNeedsOrganization(
  settings: SettingsMapDto,
  drafts: Readonly<Record<string, Draft>>,
): boolean {
  if (!(MASK_KEY in drafts) && !(SCOPE_KEY in drafts)) return false;
  const scope = drafts[SCOPE_KEY] ?? settings[SCOPE_KEY]?.value;
  const mask = drafts[MASK_KEY] ?? settings[MASK_KEY]?.value;
  return scope === 'ORGANIZATION' && !(typeof mask === 'string' && mask.includes('{org}'));
}
