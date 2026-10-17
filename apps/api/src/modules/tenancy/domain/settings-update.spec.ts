import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { SettingsRegistry } from './settings-registry.js';
import {
  AiTermsNotAcceptedError,
  InvalidSettingValuesError,
  MissingExpectedVersionsError,
  planSettingsUpdate,
  SettingVersionConflictError,
  UnknownSettingKeysError,
} from './settings-update.js';
import type { StoredSetting } from './settings-update.js';

const registry = new SettingsRegistry([SETTING_DEFINITIONS]);

function stored(...rows: [string, unknown, number][]): Map<string, StoredSetting> {
  return new Map(rows.map(([key, value, version]) => [key, { key, value, version }]));
}

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('planSettingsUpdate (RN-TEN-52..54, tudo ou nada)', () => {
  it('planeja só as chaves cujo valor mudou, com valor anterior e novo', () => {
    const plan = planSettingsUpdate(
      registry,
      stored(['labels.secretariat', 'Secretaria', 1], ['labels.department', 'Setor', 4]),
      {
        values: { 'labels.secretariat': 'Diretoria', 'labels.department': 'Setor' },
        expectedVersions: { 'labels.secretariat': 1, 'labels.department': 4 },
      },
    );
    expect(plan.changes).toEqual([
      {
        key: 'labels.secretariat',
        group: 'labels',
        previous: 'Secretaria',
        next: 'Diretoria',
        expectedVersion: 1,
        insert: false,
      },
    ]);
  });

  it('chave sem linha vale o padrão com versão 0 e a primeira gravação é um insert (RN-TEN-57)', () => {
    const plan = planSettingsUpdate(registry, stored(), {
      values: { 'security.sessionIdleMinutes': 60 },
      expectedVersions: { 'security.sessionIdleMinutes': 0 },
    });
    expect(plan.changes).toEqual([
      expect.objectContaining({ previous: 30, next: 60, expectedVersion: 0, insert: true }),
    ]);
    // O padrão não gera linha nova.
    expect(
      planSettingsUpdate(registry, stored(), {
        values: { 'security.sessionIdleMinutes': 30 },
        expectedVersions: { 'security.sessionIdleMinutes': 0 },
      }).changes,
    ).toEqual([]);
  });

  it('valores objeto e lista são comparados por conteúdo', () => {
    const scale = SETTING_DEFINITIONS.find((item) => item.key === 'risk.scale')?.defaultValue;
    const plan = planSettingsUpdate(registry, stored(['risk.scale', scale, 2]), {
      values: { 'risk.scale': structuredClone(scale) },
      expectedVersions: { 'risk.scale': 2 },
    });
    expect(plan.changes).toEqual([]);
  });

  it('chave desconhecida vem antes de qualquer outra conferência (RN-TEN-52)', () => {
    const error = capture(() =>
      planSettingsUpdate(registry, stored(), {
        values: { 'nada.disso': 1, 'security.sessionIdleMinutes': 1 },
        expectedVersions: {},
      }),
    );
    expect(error).toBeInstanceOf(UnknownSettingKeysError);
    expect((error as UnknownSettingKeysError).keys).toEqual(['nada.disso']);
  });

  it('valor inválido vem antes da versão; máscara usa o código do módulo dono (RN-TEN-53)', () => {
    const error = capture(() =>
      planSettingsUpdate(registry, stored(), {
        values: { 'numbering.process.mask': 'PROC-{seq:4}', 'security.sessionIdleMinutes': 1 },
        expectedVersions: {},
      }),
    ) as InvalidSettingValuesError;
    expect(error).toBeInstanceOf(InvalidSettingValuesError);
    expect(error.violations).toEqual([
      { key: 'numbering.process.mask', code: 'NUMBERING_MASK_INVALID' },
      { key: 'security.sessionIdleMinutes', code: 'VALIDATION_ERROR' },
    ]);
  });

  it('versão ausente (428) vem antes da divergente (412)', () => {
    const missing = capture(() =>
      planSettingsUpdate(registry, stored(['labels.secretariat', 'Secretaria', 1]), {
        values: { 'labels.secretariat': 'X', 'labels.department': 'Y' },
        expectedVersions: { 'labels.secretariat': 9 },
      }),
    );
    expect(missing).toBeInstanceOf(MissingExpectedVersionsError);
    expect((missing as MissingExpectedVersionsError).keys).toEqual(['labels.department']);
  });

  it('versão divergente cancela o lote e identifica as chaves em conflito (RN-TEN-54)', () => {
    const error = capture(() =>
      planSettingsUpdate(
        registry,
        stored(['labels.secretariat', 'Secretaria', 2], ['labels.department', 'Setor', 1]),
        {
          values: { 'labels.secretariat': 'X', 'labels.department': 'Y' },
          expectedVersions: { 'labels.secretariat': 1, 'labels.department': 1 },
        },
      ),
    ) as SettingVersionConflictError;
    expect(error).toBeInstanceOf(SettingVersionConflictError);
    expect(error.conflicts).toEqual([{ key: 'labels.secretariat', currentVersion: 2 }]);
  });

  it('versão divergente também vale quando o valor não muda (reenvio — duplicidade)', () => {
    expect(
      capture(() =>
        planSettingsUpdate(registry, stored(['labels.secretariat', 'Diretoria', 2]), {
          values: { 'labels.secretariat': 'Diretoria' },
          expectedVersions: { 'labels.secretariat': 1 },
        }),
      ),
    ).toBeInstanceOf(SettingVersionConflictError);
  });

  describe('máscara × escopo da numeração do processo', () => {
    it('escopo ORGANIZATION sem {org} na máscara efetiva é recusado', () => {
      const error = capture(() =>
        planSettingsUpdate(registry, stored(), {
          values: { 'numbering.process.scope': 'ORGANIZATION' },
          expectedVersions: { 'numbering.process.scope': 0 },
        }),
      ) as InvalidSettingValuesError;
      expect(error.violations).toEqual([
        {
          key: 'numbering.process.scope',
          code: 'NUMBERING_MASK_INVALID',
          missingOrganization: true,
        },
      ]);
    });

    it('trocar só a máscara com escopo ORGANIZATION já gravado também exige {org}', () => {
      const current = stored(['numbering.process.scope', 'ORGANIZATION', 2]);
      expect(
        capture(() =>
          planSettingsUpdate(registry, current, {
            values: { 'numbering.process.mask': '{seq:4}/{year}' },
            expectedVersions: { 'numbering.process.mask': 0 },
          }),
        ),
      ).toBeInstanceOf(InvalidSettingValuesError);
      expect(
        planSettingsUpdate(registry, current, {
          values: { 'numbering.process.mask': '{org} {seq:4}/{year}' },
          expectedVersions: { 'numbering.process.mask': 0 },
        }).changes,
      ).toHaveLength(1);
    });

    it('escopo TENANT dispensa {org}', () => {
      expect(
        planSettingsUpdate(registry, stored(), {
          values: { 'numbering.process.mask': '{seq:5}-{year}' },
          expectedVersions: { 'numbering.process.mask': 0 },
        }).changes,
      ).toHaveLength(1);
    });
  });
});

describe('chaves ai.* (US-116 · RN-AI-16 · V-01..V-03)', () => {
  const ai = { termsVersion: '2026-10', maxMonthlyTokens: 20_000_000 };
  const versions = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 0]));

  it('[Sucesso] liga com a versão vigente aceita no mesmo lote (padrão: desligada, sem termos)', () => {
    const values = { 'ai.enabled': true, 'ai.termsAcceptedVersion': '2026-10' };
    const plan = planSettingsUpdate(
      registry,
      stored(),
      { values, expectedVersions: versions(Object.keys(values)) },
      ai,
    );
    expect(plan.changes.map((change) => [change.key, change.previous, change.next])).toEqual([
      ['ai.enabled', false, true],
      ['ai.termsAcceptedVersion', null, '2026-10'],
    ]);
  });

  it('[Sucesso] liga com os termos vigentes já gravados', () => {
    const plan = planSettingsUpdate(
      registry,
      stored(['ai.termsAcceptedVersion', '2026-10', 1]),
      { values: { 'ai.enabled': true }, expectedVersions: { 'ai.enabled': 0 } },
      ai,
    );
    expect(plan.changes).toHaveLength(1);
  });

  it.each([
    ['sem termos', {}, { 'ai.enabled': true }],
    ['com termos antigos gravados (FA-02)', { old: true }, { 'ai.enabled': true }],
    [
      'aceitando versão que não é a vigente',
      {},
      { 'ai.enabled': true, 'ai.termsAcceptedVersion': '2025-01' },
    ],
  ])('[Validação] ligar %s → AI_TERMS_NOT_ACCEPTED', (_label, options, values) => {
    const current = 'old' in options ? stored(['ai.termsAcceptedVersion', '2025-01', 1]) : stored();
    expect(
      capture(() =>
        planSettingsUpdate(
          registry,
          current,
          { values, expectedVersions: versions(Object.keys(values)) },
          ai,
        ),
      ),
    ).toBeInstanceOf(AiTermsNotAcceptedError);
  });

  it('FA-02: IA já ligada com termos antigos continua ligada e aceita ajuste de limites', () => {
    const plan = planSettingsUpdate(
      registry,
      stored(['ai.enabled', true, 1], ['ai.termsAcceptedVersion', '2025-01', 1]),
      {
        values: { 'ai.monthlyTokenLimit': 100_000 },
        expectedVersions: { 'ai.monthlyTokenLimit': 0 },
      },
      ai,
    );
    expect(plan.changes).toHaveLength(1);
  });

  it.each([
    ['ai.monthlyTokenLimit', 49_999],
    ['ai.monthlyTokenLimit', 20_000_001],
    ['ai.userDailyRequestLimit', 0],
    ['ai.userDailyRequestLimit', 501],
  ])('[Validação] %s = %i fora da faixa → VALIDATION_ERROR', (key, value) => {
    const error = capture(() =>
      planSettingsUpdate(
        registry,
        stored(),
        { values: { [key]: value }, expectedVersions: { [key]: 0 } },
        ai,
      ),
    );
    expect(error).toBeInstanceOf(InvalidSettingValuesError);
    expect((error as InvalidSettingValuesError).violations).toEqual([
      { key, code: 'VALIDATION_ERROR' },
    ]);
  });

  it('nenhuma chave ai.* é pública (SET-03)', () => {
    expect(registry.publicDefinitions().some((definition) => definition.group === 'ai')).toBe(
      false,
    );
  });
});
