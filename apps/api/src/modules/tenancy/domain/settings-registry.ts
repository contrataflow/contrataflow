import {
  DOCUMENT_MASK_SETTING_SCHEMA,
  FEATURE_FLAG_SCHEMA,
  SETTING_DOCUMENT_MASK_KEY,
  SETTING_FEATURE_KEY,
  settingGroupOf,
} from '@contrataflow/validation';
import type { SettingDefinition, SettingGroup } from '@contrataflow/validation';

/*
 * Registro tipado de configurações do tenant (US-103 · entities.md §6 · RN-TEN-52/53): chave →
 * schema Zod, padrão, grupo e leitura pública. Cada módulo dono contribui com as suas chaves
 * (`SettingDefinition.module`); chave duplicada entre módulos, ou fora de um grupo conhecido,
 * impede o boot. Funções puras, sem I/O.
 */

/** Erro de programação no registro (falha na subida). */
export class SettingsRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsRegistryError';
  }
}

export type SettingParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly definition: SettingDefinition };

/** `features.<flag>` (DEC-059): booleana, desligada por padrão, nunca pública. */
function featureDefinition(key: string): SettingDefinition {
  return {
    key,
    group: 'features',
    module: 'tenancy',
    schema: FEATURE_FLAG_SCHEMA,
    defaultValue: false,
    isPublic: false,
  };
}

/**
 * `numbering.document.<TYPE>.mask` (US-105 · RN-TEN-72): máscara própria do tipo nas configurações,
 * dinâmica como as flags — sem linha, vale `numbering.document.defaultMask`; nunca pública.
 */
function documentMaskDefinition(key: string): SettingDefinition {
  return {
    key,
    group: 'numbering',
    module: 'catalog',
    schema: DOCUMENT_MASK_SETTING_SCHEMA,
    defaultValue: null,
    isPublic: false,
    violationCode: 'NUMBERING_MASK_INVALID',
  };
}

export class SettingsRegistry {
  private readonly byKey = new Map<string, SettingDefinition>();

  /** @throws SettingsRegistryError chave duplicada, fora de grupo, ou padrão que não passa no schema. */
  constructor(contributions: readonly (readonly SettingDefinition[])[]) {
    for (const definitions of contributions) {
      for (const definition of definitions) {
        if (this.byKey.has(definition.key)) {
          throw new SettingsRegistryError(`Chave de configuração duplicada: ${definition.key}.`);
        }
        if (settingGroupOf(definition.key) !== definition.group) {
          throw new SettingsRegistryError(
            `A chave ${definition.key} não pertence ao grupo ${definition.group}.`,
          );
        }
        if (!definition.schema.safeParse(definition.defaultValue).success) {
          throw new SettingsRegistryError(
            `O padrão de ${definition.key} não passa no próprio schema.`,
          );
        }
        this.byKey.set(definition.key, definition);
      }
    }
  }

  /** Definição da chave, ou `null` se não existe no registro (RN-TEN-52). */
  definition(key: string): SettingDefinition | null {
    const fixed = this.byKey.get(key);
    if (fixed) return fixed;
    if (SETTING_DOCUMENT_MASK_KEY.test(key)) return documentMaskDefinition(key);
    return SETTING_FEATURE_KEY.test(key) ? featureDefinition(key) : null;
  }

  /**
   * Chaves fixas do registro, na ordem de declaração (`features.<flag>` e
   * `numbering.document.<TYPE>.mask` são dinâmicas).
   */
  definitions(): readonly SettingDefinition[] {
    return [...this.byKey.values()];
  }

  publicDefinitions(): readonly SettingDefinition[] {
    return this.definitions().filter((definition) => definition.isPublic);
  }

  groups(): readonly SettingGroup[] {
    return [...new Set(this.definitions().map((definition) => definition.group))];
  }

  /** Valida (e normaliza) o valor pelo schema da chave (RN-TEN-53). */
  parse(key: string, value: unknown): SettingParseResult | null {
    const definition = this.definition(key);
    if (definition === null) return null;
    const parsed = definition.schema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, definition };
  }
}
