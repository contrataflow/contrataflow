import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { SettingsRegistry } from './settings-registry.js';
import {
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
