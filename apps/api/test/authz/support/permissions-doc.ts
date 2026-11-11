import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PERMISSION_CODES } from '@contrataflow/types';

const CATALOG: ReadonlySet<string> = new Set<string>(PERMISSION_CODES);

/*
 * Oráculo da bateria `test:authz` (permissions.md §10): a matriz perfil × permissão (§3.2) e o
 * conjunto fixo da participação (§4) lidos do DOCUMENTO canônico, nunca do código. A matriz gerada
 * compara a decisão do `AuthorizationService` com o que está escrito aqui.
 */

const DOC = fileURLToPath(new URL('../../../../../docs/mvp-01/permissions.md', import.meta.url));

/** Colunas abreviadas da matriz §3.2 → chave do perfil padrão (§3.1). */
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

function docLines(): string[] {
  return readFileSync(DOC, 'utf8').split(/\r?\n/);
}

/** Linhas de uma seção (`### 3.2`, `## 4`), até o próximo título de mesmo nível ou superior. */
function section(lines: readonly string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(`${heading} `));
  if (start < 0) throw new Error(`Seção ${heading} não encontrada em permissions.md`);
  const level = heading.split(' ')[0]?.length ?? 2;
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,6} /.test(line) && line.indexOf(' ') <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Matriz §3.2: perfil → permissões marcadas com ✔. */
export function documentedRoleMatrix(): ReadonlyMap<string, ReadonlySet<string>> {
  const lines = section(docLines(), '### 3.2');
  const header = lines.find((line) => line.startsWith('| Permissão |')) ?? '';
  const columns = header
    .split('|')
    .map((cell) => cell.trim())
    .slice(2, -1)
    .map((column) => ROLE_COLUMNS[column] ?? column);
  const matrix = new Map<string, Set<string>>(columns.map((role) => [role, new Set<string>()]));
  for (const line of lines) {
    const row = /^\| `([A-Z_]+)` \|(.*)\|\s*$/.exec(line);
    if (!row) continue;
    const [, code = '', rest = ''] = row;
    rest.split('|').forEach((cell, index) => {
      const role = columns[index];
      if (cell.trim() === '✔' && role) matrix.get(role)?.add(code);
    });
  }
  return matrix;
}

/**
 * Conjunto fixo por papel de participação (§4). Um papel citado na célula (`OBSERVER` +, "Igual a
 * `COLLABORATOR`") herda o conjunto dele.
 */
export function documentedParticipationPermissions(): ReadonlyMap<string, ReadonlySet<string>> {
  const lines = section(docLines(), '## 4.');
  const roles = new Map<string, Set<string>>();
  for (const line of lines) {
    const row = /^\| `([A-Z_]+)` \| (.*) \|\s*$/.exec(line);
    if (!row) continue;
    const [, role = '', cell = ''] = row;
    const codes = new Set<string>();
    for (const [, token = ''] of cell.matchAll(/`([A-Z_]+)`/g)) {
      const inherited = roles.get(token);
      if (inherited) inherited.forEach((code) => codes.add(code));
      // Só códigos do catálogo: `DRAFT`/`RETURNED` da nota da célula não são permissões.
      else if (CATALOG.has(token)) codes.add(token);
    }
    roles.set(role, codes);
  }
  return roles;
}
