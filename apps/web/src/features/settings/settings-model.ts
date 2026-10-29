import {
  contrastAgainstWhite,
  NUMBERING_SCOPES,
  PLATFORM_UPLOAD_EXTENSIONS,
  SETTING_DEFINITIONS,
  SETTING_DOCUMENT_MASK_KEY,
  settingGroupOf,
  settingSchemaOf,
} from '@contrataflow/validation';
import type {
  NumberingPreview,
  NumberingScope,
  SettingGroup,
  SettingsMapDto,
} from '@contrataflow/validation';

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

const MASK_KEY = 'numbering.process.mask';
const SCOPE_KEY = 'numbering.process.scope';
const DEFAULT_DOCUMENT_MASK_KEY = 'numbering.document.defaultMask';
/** Tipo de exemplo da prévia da máscara padrão de documento (usa a padrão — DEC-028). */
export const DEFAULT_MASK_PREVIEW_TYPE = 'DFD';

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
  if (key === MASK_KEY || key === DEFAULT_DOCUMENT_MASK_KEY) return 'mask';
  if (SETTING_DOCUMENT_MASK_KEY.test(key)) return 'mask';
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

/**
 * Seções da página (prd-5 · `SettingsPage`), na ordem da tela, com os grupos do registro que cada
 * uma reúne. Todo grupo de `SETTING_GROUPS` pertence a exatamente uma seção (um teste confere).
 */
export const SETTINGS_SECTIONS = [
  { id: 'branding', groups: ['branding'] },
  { id: 'labels', groups: ['labels'] },
  { id: 'security', groups: ['security'] },
  { id: 'approval', groups: ['approval'] },
  { id: 'process', groups: ['process', 'access'] },
  { id: 'deadlines', groups: ['deadlines', 'calendar'] },
  { id: 'numbering', groups: ['numbering'] },
  { id: 'priceResearch', groups: ['priceResearch'] },
  { id: 'risk', groups: ['risk'] },
  { id: 'uploads', groups: ['uploads'] },
  { id: 'notifications', groups: ['notifications'] },
  { id: 'features', groups: ['features'] },
  { id: 'ai', groups: ['ai'] },
] as const satisfies readonly {
  readonly id: string;
  readonly groups: readonly SettingGroup[];
}[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export interface SettingsSectionModel {
  readonly id: SettingsSectionId;
  readonly keys: readonly string[];
}

/** Seções na ordem da tela; só as que têm alguma chave na resposta (SET-01). */
export function sectionSettings(settings: SettingsMapDto): readonly SettingsSectionModel[] {
  const keys = Object.keys(settings);
  return SETTINGS_SECTIONS.map((section) => {
    const groups: readonly SettingGroup[] = section.groups;
    return {
      id: section.id,
      keys: groups.flatMap((group) => keys.filter((key) => settingGroupOf(key) === group)),
    };
  }).filter((section) => section.keys.length > 0);
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

/** Código do tipo de `numbering.document.<TYPE>.mask`, ou `null` para outras chaves. */
export function documentMaskTypeOf(key: string): string | null {
  return SETTING_DOCUMENT_MASK_KEY.exec(key)?.[1] ?? null;
}

function scopeOf(value: unknown): NumberingScope {
  return (NUMBERING_SCOPES as readonly unknown[]).includes(value)
    ? (value as NumberingScope)
    : 'TENANT';
}

/**
 * Corpo de SET-04 (US-105 · FA-04) para a máscara em edição — a do rascunho, nunca a gravada — ou
 * `null` enquanto o rascunho é inválido (a prévia não avança). A máscara do processo leva o escopo
 * em edição; as de documento, o tipo de exemplo (`DFD` na padrão).
 */
export function maskPreviewRequest(
  key: string,
  settings: SettingsMapDto,
  drafts: Readonly<Record<string, Draft>>,
): NumberingPreview | null {
  const draft = drafts[key] ?? toDraft(key, settings[key]?.value);
  if (typeof draft !== 'string' || !parseDraft(key, draft).ok) return null;
  if (key === MASK_KEY) {
    if (maskNeedsOrganization(settings, drafts)) return null;
    return { mask: draft, scope: scopeOf(drafts[SCOPE_KEY] ?? settings[SCOPE_KEY]?.value) };
  }
  if (key === DEFAULT_DOCUMENT_MASK_KEY) {
    return { mask: draft, documentTypeCode: DEFAULT_MASK_PREVIEW_TYPE };
  }
  const type = documentMaskTypeOf(key);
  return type === null ? null : { mask: draft, documentTypeCode: type };
}

/** DEC-028 · RN-TEN-68: o escopo em edição difere do gravado (vale só no próximo exercício). */
export function scopeChanged(
  settings: SettingsMapDto,
  drafts: Readonly<Record<string, Draft>>,
): boolean {
  const draft = drafts[SCOPE_KEY];
  return draft !== undefined && draft !== settings[SCOPE_KEY]?.value;
}
