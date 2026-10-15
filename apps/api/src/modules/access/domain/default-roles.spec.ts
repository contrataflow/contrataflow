import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PERMISSION_CODES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_GRANTS,
  DEFAULT_ROLES,
  defaultGrants,
  seedDefaultRoles,
} from './default-roles.js';
import { grantPermission, UnknownPermissionError } from './role.js';

const TENANT = '0192f000-0000-7000-8000-000000000941';
const NOW = new Date('2026-10-15T12:00:00.000Z');

function sequentialIds(): () => string {
  let next = 0;
  return () => `0192f000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}`;
}

const ROLE_COLUMNS: Readonly<Record<string, string>> = {
  ADM: 'ADMIN_ORGAO',
  GES: 'GESTOR_CONTRATACOES',
  REQ: 'REQUISITANTE',
  PLA: 'PLANEJAMENTO',
  COM: 'COMPRAS',
  LIC: 'LICITACOES',
  CTB: 'CONTABILIDADE',
  JUR: 'JURIDICO',
  CI: 'CONTROLE_INTERNO',
  AUT: 'AUTORIDADE_COMPETENTE',
  FIS: 'FISCAL_CONTRATO',
  GCT: 'GESTOR_CONTRATO',
  AUD: 'AUDITOR',
  LEI: 'SOMENTE_LEITURA',
  EXT: 'CONSULTOR_EXTERNO',
};

/** Matriz §3.2 lida do documento canônico: perfil → permissões marcadas, na ordem das linhas. */
function matrixFromDocs(): Record<string, string[]> {
  const path = fileURLToPath(
    new URL('../../../../../../docs/mvp-01/permissions.md', import.meta.url),
  );
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('### 3.2'));
  const header = lines.slice(start).find((line) => line.startsWith('| Permissão |')) ?? '';
  const columns = header
    .split('|')
    .map((cell) => cell.trim())
    .slice(2, -1)
    .map((column) => ROLE_COLUMNS[column] ?? column);
  const matrix: Record<string, string[]> = Object.fromEntries(columns.map((role) => [role, []]));
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const row = /^\| `([A-Z_]+)` \|(.*)\|\s*$/.exec(line);
    if (!row) continue;
    const [, code = '', rest = ''] = row;
    rest.split('|').forEach((cell, index) => {
      const role = columns[index];
      if (cell.trim() === '✔' && role) matrix[role]?.push(code);
    });
  }
  return matrix;
}

describe('perfis padrão (permissions.md §3 · RN-IAM-74/75)', () => {
  it('são os 15 perfis de §3.1, na ordem do documento', () => {
    expect(DEFAULT_ROLES.map((role) => role.key)).toEqual(Object.values(ROLE_COLUMNS));
  });

  it('cada perfil concede exatamente a sua coluna da matriz §3.2 (linha a linha)', () => {
    const fromDocs = matrixFromDocs();
    expect(Object.keys(fromDocs)).toHaveLength(15);
    for (const role of DEFAULT_ROLES) {
      expect([...role.permissions], role.key).toEqual(fromDocs[role.key]);
    }
  });

  it('quantidade de concessões por perfil (snapshot da matriz)', () => {
    expect(
      Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, role.permissions.length])),
    ).toEqual({
      ADMIN_ORGAO: 26,
      GESTOR_CONTRATACOES: 55,
      REQUISITANTE: 32,
      PLANEJAMENTO: 39,
      COMPRAS: 31,
      LICITACOES: 21,
      CONTABILIDADE: 16,
      JURIDICO: 17,
      CONTROLE_INTERNO: 20,
      AUTORIDADE_COMPETENTE: 22,
      FISCAL_CONTRATO: 7,
      GESTOR_CONTRATO: 20,
      AUDITOR: 13,
      SOMENTE_LEITURA: 6,
      CONSULTOR_EXTERNO: 11,
    });
  });

  it('toda concessão referencia permissão do catálogo, sem repetição no perfil', () => {
    for (const [key, codes] of Object.entries(DEFAULT_ROLE_GRANTS)) {
      expect(new Set(codes).size, key).toBe(codes.length);
      for (const code of codes) expect(PERMISSION_CODES, key).toContain(code);
    }
  });

  it('ADMIN_ORGAO tem todas as permissões de administração (DEC-035)', () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN_ORGAO).toEqual(
      expect.arrayContaining([
        'USER_VIEW',
        'USER_INVITE',
        'USER_MANAGE',
        'ROLE_VIEW',
        'ROLE_MANAGE',
        'ROLE_ASSIGN',
        'ORGANIZATION_MANAGE',
        'DEPARTMENT_MANAGE',
        'SETTINGS_MANAGE',
      ]),
    );
  });

  it('CONSULTOR_EXTERNO não recebe *_SUBMIT nem APPROVAL_DECIDE (POL-15)', () => {
    const codes: readonly string[] = DEFAULT_ROLE_GRANTS.CONSULTOR_EXTERNO;
    expect(codes.filter((code) => code.endsWith('_SUBMIT'))).toEqual([]);
    expect(codes).not.toContain('APPROVAL_DECIDE');
  });
});

describe('Role.seedDefaults (seedDefaultRoles)', () => {
  const seeded = seedDefaultRoles(TENANT, NOW, sequentialIds());
  const byKey = new Map(seeded.map((entry) => [entry.role.key, entry.role]));

  it('15 perfis de sistema ativos, do tenant, com ator SYSTEM e versão 1', () => {
    expect(seeded).toHaveLength(15);
    for (const { role } of seeded) {
      expect(role).toMatchObject({
        tenantId: TENANT,
        isSystem: true,
        isActive: true,
        createdById: null,
        updatedById: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
      });
      expect(role.name.trim()).not.toBe('');
    }
    expect(new Set(seeded.map((entry) => entry.role.id)).size).toBe(15);
    expect(new Set(seeded.map((entry) => entry.role.name.toLowerCase())).size).toBe(15);
  });

  it('só ADMIN_ORGAO é protegido', () => {
    expect(seeded.filter((entry) => entry.role.isProtected).map((e) => e.role.key)).toEqual([
      'ADMIN_ORGAO',
    ]);
  });

  it('allowExternalAssignment só em AUDITOR e CONSULTOR_EXTERNO; falso nos demais 13', () => {
    const external = seeded.filter((entry) => entry.role.allowExternalAssignment);
    expect(external.map((entry) => entry.role.key)).toEqual(['AUDITOR', 'CONSULTOR_EXTERNO']);
    expect(seeded.filter((entry) => !entry.role.allowExternalAssignment)).toHaveLength(13);
  });

  it('escopo padrão de atribuição conforme §3.1', () => {
    const scopes = Object.fromEntries(
      DEFAULT_ROLES.map((role) => [role.key, role.defaultAssignmentScope]),
    );
    expect(scopes).toMatchObject({
      ADMIN_ORGAO: 'TENANT',
      REQUISITANTE: 'OWN_DEPARTMENTS',
      AUTORIDADE_COMPETENTE: 'ORGANIZATION',
      CONSULTOR_EXTERNO: 'OWN_DEPARTMENTS',
    });
  });

  it('defaultGrants gera a matriz para os perfis gravados (ids do banco)', () => {
    const grants = defaultGrants([...byKey.values()], DEFAULT_ROLES, NOW, sequentialIds());
    const total = DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0);
    expect(grants).toHaveLength(total);
    const admin = byKey.get('ADMIN_ORGAO');
    expect(grants.filter((grant) => grant.roleId === admin?.id)).toHaveLength(26);
    expect(grants[0]).toMatchObject({ tenantId: TENANT, createdById: null, createdAt: NOW });
  });

  it('defaultGrants ignora perfil que não foi gravado', () => {
    const admin = byKey.get('ADMIN_ORGAO');
    if (!admin) throw new Error('sem ADMIN_ORGAO');
    expect(defaultGrants([admin], DEFAULT_ROLES, NOW, sequentialIds())).toHaveLength(26);
  });
});

describe('RolePermission.grant (V-02)', () => {
  const role = { id: '0192f000-0000-7000-8000-0000000009a1', tenantId: TENANT, key: 'X_Y' };

  it('concede permissão do catálogo', () => {
    expect(grantPermission(role, 'ROLE_VIEW', { id: 'g', now: NOW, userId: null })).toEqual({
      id: 'g',
      tenantId: TENANT,
      roleId: role.id,
      permissionCode: 'ROLE_VIEW',
      createdAt: NOW,
      createdById: null,
    });
  });

  it('permissão inexistente → REFERENCE_NOT_FOUND', () => {
    expect(() =>
      grantPermission(role, 'ROLE_DESTROY', { id: 'g', now: NOW, userId: null }),
    ).toThrow(UnknownPermissionError);
    try {
      grantPermission(role, 'ROLE_DESTROY', { id: 'g', now: NOW, userId: null });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'REFERENCE_NOT_FOUND',
        roleKey: 'X_Y',
        permissionCode: 'ROLE_DESTROY',
      });
    }
  });
});
