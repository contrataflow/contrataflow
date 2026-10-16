import { z } from 'zod';

/*
 * Meu perfil e preferências (US-098 · ME-02 · RN-IAM-109..113): contrato do `PATCH /me`,
 * compartilhado pela API e pelo formulário de SCR-039 (`/perfil`).
 */

export const PROFILE_NAME_MIN = 2;
export const PROFILE_NAME_MAX = 200;

/** Mensagens da story (V-01/V-02). */
export const PROFILE_NAME_MESSAGE = 'Informe seu nome (mín. 2 caracteres).';
export const PROFILE_PHONE_MESSAGE = 'Informe um telefone válido.';
export const PROFILE_PREFERENCE_UNKNOWN_MESSAGE = 'Preferência não reconhecida.';

/** Registro de preferências de interface aceitas (RN-IAM-111 · entities.md `User.preferences`). */
export const PROFILE_PREFERENCE_DEFINITIONS = {
  density: { values: ['comfortable', 'compact'], default: 'comfortable' },
  theme: { values: ['light', 'dark', 'system'], default: 'system' },
} as const;

export const PROFILE_DENSITIES = PROFILE_PREFERENCE_DEFINITIONS.density.values;
export const PROFILE_THEMES = PROFILE_PREFERENCE_DEFINITIONS.theme.values;
export type ProfileDensity = (typeof PROFILE_DENSITIES)[number];
export type ProfileTheme = (typeof PROFILE_THEMES)[number];

/** Chaves registradas de `User.preferences` editáveis em `PATCH /me`. */
export const PROFILE_PREFERENCE_KEYS = Object.keys(PROFILE_PREFERENCE_DEFINITIONS) as readonly (
  'density' | 'theme'
)[];

const PHONE_CHARACTERS = /^\+?[\d\s()-]+$/;

/**
 * Telefone brasileiro (RN-IAM-109): DDD (11–99) + 8 dígitos fixos ou 9 dígitos móveis iniciados em
 * 9, com `+55` opcional e pontuação livre (`(11) 91234-5678`).
 */
export function isBrazilianPhone(value: string): boolean {
  if (!PHONE_CHARACTERS.test(value)) return false;
  let digits = value.replace(/\D/g, '');
  if (value.startsWith('+')) {
    if (!digits.startsWith('55')) return false;
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return false;
  if (!/^[1-9][1-9]/.test(digits)) return false;
  return digits.length === 10 || digits[2] === '9';
}

/** Texto opcional: vazio, só espaços ou `null` limpa o campo (FA-01 — volta ao nome civil). */
function clearable<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable().optional(),
  );
}

const nameText = z
  .string()
  .trim()
  .min(PROFILE_NAME_MIN, { error: PROFILE_NAME_MESSAGE })
  .max(PROFILE_NAME_MAX, { error: `Informe no máximo ${String(PROFILE_NAME_MAX)} caracteres.` });

const phoneText = z
  .string()
  .trim()
  .max(20, { error: PROFILE_PHONE_MESSAGE })
  .refine(isBrazilianPhone, { error: PROFILE_PHONE_MESSAGE });

/**
 * ME-02 (corpo): só `name`, `socialName`, `phone` e `preferences` (RN-IAM-109) — qualquer outro
 * campo (`email`, `status`…) é recusado com 422. As chaves de `preferences` chegam livres: a
 * chave desconhecida vira `SETTING_KEY_UNKNOWN` na API (RN-IAM-111), não erro de formato; o valor
 * de chave conhecida fora do registro é `VALIDATION_ERROR`.
 */
export const updateMyProfileSchema = z.strictObject({
  name: nameText.optional(),
  socialName: clearable(nameText),
  phone: clearable(phoneText),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateMyProfile = z.output<typeof updateMyProfileSchema>;

/** Valor de preferência conhecida dentro do registro? (RN-IAM-111). */
export function isPreferenceValue(key: string, value: unknown): boolean {
  if (!isPreferenceKey(key) || typeof value !== 'string') return false;
  return (PROFILE_PREFERENCE_DEFINITIONS[key].values as readonly string[]).includes(value);
}

export function isPreferenceKey(key: string): key is (typeof PROFILE_PREFERENCE_KEYS)[number] {
  return (PROFILE_PREFERENCE_KEYS as readonly string[]).includes(key);
}
