import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { POLICY_IDS } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { AUTHZ_BATTERY, POLICY_EVIDENCE } from './battery.js';

/*
 * Políticas na bateria (permissions.md §10 — "um teste por POL, sucesso e violação, incluindo
 * segregação de funções, anti-escalonamento e anti-bloqueio"): toda POL do catálogo
 * (`CONTEXTUAL_POLICIES`) aponta ao menos uma suíte, essa suíte existe, cita a violação e roda no
 * `test:authz`. Política nova sem suíte, ou suíte renomeada, reprova aqui.
 */

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('inventário das políticas contextuais na bateria test:authz', () => {
  it('cada POL do catálogo tem ao menos uma suíte apontada', () => {
    expect(Object.keys(POLICY_EVIDENCE).sort()).toEqual([...POLICY_IDS].sort());
    for (const id of POLICY_IDS) expect(POLICY_EVIDENCE[id].length, id).toBeGreaterThan(0);
  });

  it.each(POLICY_IDS)('%s: a suíte existe, cita a violação e entra na bateria', (id) => {
    for (const { file, mentions } of POLICY_EVIDENCE[id]) {
      const path = `${API_ROOT}${file}`;
      expect(existsSync(path), `${id}: ${file} não existe`).toBe(true);
      const source = readFileSync(path, 'utf8');
      expect(
        mentions.filter((mention) => !source.includes(mention)),
        `${id}: ${file}`,
      ).toEqual([]);
      expect(AUTHZ_BATTERY).toContain(file);
    }
  });
});
