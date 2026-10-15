import type { DepartmentDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LABELS,
  buildTree,
  canDropOn,
  idsWithChildren,
  labelsFrom,
  moveTargets,
  typeLabel,
  visibleNodes,
} from './department-tree-model';

const ORG = '0192a000-0000-7000-8000-0000000100a1';
let sequence = 0;
function unit(name: string, parent: DepartmentDto | null, extra: Partial<DepartmentDto> = {}) {
  sequence += 1;
  const id = `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    id,
    organizationId: ORG,
    parentId: parent?.id ?? null,
    type: 'SECTOR',
    name,
    acronym: null,
    code: null,
    email: null,
    phone: null,
    headUserId: null,
    deputyUserId: null,
    isActive: true,
    isSecretariat: parent === null,
    sortOrder: 0,
    path: `${parent?.path ?? '/'}${id}/`,
    depth: parent ? parent.depth + 1 : 0,
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...extra,
  } satisfies DepartmentDto;
}

const sec = unit('Secretaria de Obras', null, { type: 'SECRETARIAT' });
const dep = unit('Departamento de Projetos', sec, { type: 'DEPARTMENT' });
const setor = unit('Setor de Topografia', dep);
const outra = unit('Secretaria de Saúde', null, { type: 'SECRETARIAT' });
const inativa = unit('Secretaria Extinta', null, { isActive: false });
const ALL = [sec, dep, setor, outra, inativa];

describe('árvore de unidades (US-102)', () => {
  it('monta a árvore e lista os nós visíveis conforme o que está expandido', () => {
    const tree = buildTree(ALL);
    expect(tree.map((node) => node.department.name)).toEqual([
      'Secretaria de Obras',
      'Secretaria de Saúde',
      'Secretaria Extinta',
    ]);
    expect(visibleNodes(tree, new Set()).map((node) => node.department.name)).toHaveLength(3);
    const open = visibleNodes(tree, new Set([sec.id, dep.id]));
    expect(open.map((node) => [node.department.name, node.level])).toEqual([
      ['Secretaria de Obras', 1],
      ['Departamento de Projetos', 2],
      ['Setor de Topografia', 3],
      ['Secretaria de Saúde', 1],
      ['Secretaria Extinta', 1],
    ]);
    expect(open[0]).toMatchObject({ hasChildren: true, expanded: true, position: 1, setSize: 3 });
    expect(open[2]).toMatchObject({ hasChildren: false, parentId: dep.id, setSize: 1 });
    expect(idsWithChildren(ALL)).toEqual(new Set([sec.id, dep.id]));
  });

  it('pai fora da lista (filtro) vira raiz local', () => {
    expect(buildTree([setor]).map((node) => node.department.id)).toEqual([setor.id]);
  });

  it('"Mover para…": exclui a própria unidade, descendentes, o pai atual e inativas (RN-TEN-46)', () => {
    expect(moveTargets(ALL, dep).map((d) => d.name)).toEqual(['Secretaria de Saúde']);
    expect(moveTargets(ALL, setor).map((d) => d.name)).toEqual([
      'Secretaria de Obras',
      'Secretaria de Saúde',
    ]);
    expect(canDropOn(dep, setor)).toBe(false);
    expect(canDropOn(dep, dep)).toBe(false);
    expect(canDropOn(dep, outra)).toBe(true);
    expect(canDropOn(dep, inativa)).toBe(false);
    expect(canDropOn(dep, null)).toBe(true);
    expect(canDropOn(sec, null)).toBe(false);
  });

  it('rótulos configuráveis (FA-06): secretaria e setor seguem labels.*; demais tipos das mensagens', () => {
    expect(labelsFrom(undefined)).toEqual(DEFAULT_LABELS);
    const labels = labelsFrom({ 'labels.secretariat': 'Diretoria', 'labels.department': ' ' });
    expect(labels).toEqual({ secretariat: 'Diretoria', department: 'Setor' });
    const message = (type: string) => `msg:${type}`;
    expect(typeLabel('SECRETARIAT', labels, message)).toBe('Diretoria');
    expect(typeLabel('SECTOR', labels, message)).toBe('Setor');
    expect(typeLabel('BOARD', labels, message)).toBe('msg:BOARD');
  });
});
