import { isDeepStrictEqual } from 'node:util';

import type { SettingGroup } from '@contrataflow/validation';

import type { SettingsRegistry } from './settings-registry.js';

/*
 * Regras do `PATCH /settings` em lote (US-103 · RN-TEN-52..54): tudo ou nada. A ordem das
 * conferências é a do fluxo principal (passo 4): chave desconhecida → valor inválido → versão
 * ausente → versão divergente. Função pura: quem chama lê as linhas e grava o plano.
 */

/** Linha persistida; `version = 0` representa a chave sem linha (RN-TEN-57 — vale o padrão). */
export interface StoredSetting {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

export interface SettingsUpdateInput {
  readonly values: Readonly<Record<string, unknown>>;
  readonly expectedVersions: Readonly<Record<string, number>>;
}

/** RN-TEN-52: chave fora do registro. */
export class UnknownSettingKeysError extends Error {
  constructor(readonly keys: readonly string[]) {
    super('Chave de configuração fora do registro.');
    this.name = 'UnknownSettingKeysError';
  }
}

export interface SettingViolation {
  readonly key: string;
  /** Código próprio do módulo dono em vez do genérico `VALIDATION_ERROR` (RN-TEN-53). */
  readonly code: 'VALIDATION_ERROR' | 'NUMBERING_MASK_INVALID';
  /** Máscara válida, mas sem `{org}` com escopo `ORGANIZATION` (V-02 da US-105). */
  readonly missingOrganization?: boolean;
}

/** RN-TEN-53: valor fora do schema da chave. */
export class InvalidSettingValuesError extends Error {
  constructor(readonly violations: readonly SettingViolation[]) {
    super('Valor de configuração inválido.');
    this.name = 'InvalidSettingValuesError';
  }
}

/** RN-TEN-54: `expectedVersions` ausente para chave alterada (V-05). */
export class MissingExpectedVersionsError extends Error {
  constructor(readonly keys: readonly string[]) {
    super('Versão esperada ausente.');
    this.name = 'MissingExpectedVersionsError';
  }
}

export interface SettingConflict {
  readonly key: string;
  readonly currentVersion: number;
}

/** RN-TEN-54: versão esperada divergente da atual (V-04). */
export class SettingVersionConflictError extends Error {
  constructor(readonly conflicts: readonly SettingConflict[]) {
    super('Versão de configuração divergente.');
    this.name = 'SettingVersionConflictError';
  }
}

export interface PlannedSettingChange {
  readonly key: string;
  readonly group: SettingGroup;
  readonly previous: unknown;
  readonly next: unknown;
  readonly expectedVersion: number;
  /** Sem linha até agora: grava a primeira versão. */
  readonly insert: boolean;
}

export interface SettingsUpdatePlan {
  /** Só as chaves cujo valor mudou, na ordem do corpo. */
  readonly changes: readonly PlannedSettingChange[];
}

/** Valor efetivo de uma chave: o gravado ou o padrão do registro (RN-TEN-57). */
function effective(
  registry: SettingsRegistry,
  current: ReadonlyMap<string, StoredSetting>,
  key: string,
): StoredSetting {
  const stored = current.get(key);
  if (stored) return stored;
  return { key, value: registry.definition(key)?.defaultValue ?? null, version: 0 };
}

/**
 * Máscara do processo × escopo (api/14 SET-02): com escopo `ORGANIZATION` a máscara precisa do
 * token `{org}`. Só confere quando o lote altera uma das duas chaves.
 */
function scopeMaskViolation(
  parsed: ReadonlyMap<string, unknown>,
  effectiveOf: (key: string) => unknown,
): SettingViolation | null {
  const maskKey = 'numbering.process.mask';
  const scopeKey = 'numbering.process.scope';
  if (!parsed.has(maskKey) && !parsed.has(scopeKey)) return null;
  const scope = parsed.get(scopeKey) ?? effectiveOf(scopeKey);
  const mask = parsed.get(maskKey) ?? effectiveOf(maskKey);
  if (scope !== 'ORGANIZATION' || (typeof mask === 'string' && mask.includes('{org}'))) {
    return null;
  }
  return {
    key: parsed.has(maskKey) ? maskKey : scopeKey,
    code: 'NUMBERING_MASK_INVALID',
    missingOrganization: true,
  };
}

/**
 * @throws UnknownSettingKeysError @throws InvalidSettingValuesError
 * @throws MissingExpectedVersionsError @throws SettingVersionConflictError
 */
export function planSettingsUpdate(
  registry: SettingsRegistry,
  current: ReadonlyMap<string, StoredSetting>,
  input: SettingsUpdateInput,
): SettingsUpdatePlan {
  const keys = Object.keys(input.values);

  const unknown = keys.filter((key) => registry.definition(key) === null);
  if (unknown.length > 0) throw new UnknownSettingKeysError(unknown);

  const parsed = new Map<string, unknown>();
  const violations: SettingViolation[] = [];
  for (const key of keys) {
    const result = registry.parse(key, input.values[key]);
    if (result?.ok === true) parsed.set(key, result.value);
    else if (result !== null) {
      violations.push({ key, code: result.definition.violationCode ?? 'VALIDATION_ERROR' });
    }
  }
  if (violations.length === 0) {
    const crossKey = scopeMaskViolation(parsed, (key) => effective(registry, current, key).value);
    if (crossKey) violations.push(crossKey);
  }
  if (violations.length > 0) throw new InvalidSettingValuesError(violations);

  const missing = keys.filter((key) => input.expectedVersions[key] === undefined);
  if (missing.length > 0) throw new MissingExpectedVersionsError(missing);

  const conflicts = keys
    .map((key) => ({ key, currentVersion: effective(registry, current, key).version }))
    .filter(({ key, currentVersion }) => input.expectedVersions[key] !== currentVersion);
  if (conflicts.length > 0) throw new SettingVersionConflictError(conflicts);

  const changes: PlannedSettingChange[] = [];
  for (const key of keys) {
    const definition = registry.definition(key);
    if (definition === null) continue;
    const before = effective(registry, current, key);
    const next = parsed.get(key);
    if (isDeepStrictEqual(before.value, next)) continue;
    changes.push({
      key,
      group: definition.group,
      previous: before.value,
      next,
      expectedVersion: before.version,
      insert: before.version === 0,
    });
  }
  return { changes };
}
