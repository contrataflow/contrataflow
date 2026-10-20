import type { TagDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  atLimit,
  filterOptions,
  keepKnown,
  nextSelection,
  pickerOptions,
  quickCreateName,
  searchKey,
  selectionChanged,
} from './tag-model';
import type { AppliedTag } from './tag-model';

const id = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const tag = (n: number, name: string, extra: Partial<TagDto> = {}): TagDto => ({
  id: id(n),
  name,
  color: '#64748B',
  isActive: true,
  version: 1,
  ...extra,
});

describe('pickerOptions (FA-03)', () => {
  const catalog = [
    tag(1, 'Recurso federal'),
    tag(2, 'Antiga', { isActive: false }),
    tag(3, 'Obras emergenciais'),
  ];

  it('oferece as ativas por nome e esconde as inativas fora do processo', () => {
    expect(pickerOptions(catalog, []).map((option) => option.name)).toEqual([
      'Obras emergenciais',
      'Recurso federal',
    ]);
  });

  it('mantém a inativa já aplicada ao processo (só para remover), com o estado do cadastro', () => {
    const applied: AppliedTag[] = [
      { id: id(2), name: 'Antiga', color: '#64748B', isActive: false },
    ];
    const options = pickerOptions(catalog, applied);
    expect(options.map((option) => [option.name, option.isActive])).toEqual([
      ['Antiga', false],
      ['Obras emergenciais', true],
      ['Recurso federal', true],
    ]);
  });

  it('usa a etiqueta aplicada quando o cadastro não a traz (quem não gerencia não lê inativas)', () => {
    const applied: AppliedTag[] = [{ id: id(9), name: 'Oculta', color: null, isActive: false }];
    expect(pickerOptions([], applied)).toEqual([
      { id: id(9), name: 'Oculta', color: null, isActive: false },
    ]);
  });
});

describe('busca sem acento nem caixa', () => {
  it('searchKey normaliza', () => {
    expect(searchKey('  ÓBRAS Emergenciais ')).toBe('obras emergenciais');
  });

  it('filterOptions filtra pelo trecho e devolve tudo sem busca', () => {
    const options = pickerOptions([tag(1, 'Obras emergenciais'), tag(2, 'Gabinete')], []);
    expect(filterOptions(options, 'obras').map((option) => option.name)).toEqual([
      'Obras emergenciais',
    ]);
    expect(filterOptions(options, 'xyz')).toEqual([]);
    expect(filterOptions(options, '  ')).toHaveLength(2);
  });
});

describe('seleção e limite de 10 (RN-PROC-88)', () => {
  const ten = Array.from({ length: 10 }, (_, index) => id(index + 1));

  it('marca e desmarca', () => {
    expect(nextSelection([id(1)], id(2))).toEqual([id(1), id(2)]);
    expect(nextSelection([id(1), id(2)], id(1))).toEqual([id(2)]);
  });

  it('no limite, marcar uma nova não muda a seleção, mas desmarcar continua possível', () => {
    expect(atLimit(ten)).toBe(true);
    expect(nextSelection(ten, id(11))).toEqual(ten);
    expect(nextSelection(ten, id(1))).toHaveLength(9);
    expect(atLimit(ten.slice(1))).toBe(false);
  });

  it('selectionChanged compara sem ordem', () => {
    expect(selectionChanged([id(1), id(2)], [id(2), id(1)])).toBe(false);
    expect(selectionChanged([id(1)], [id(1), id(2)])).toBe(true);
    expect(selectionChanged([id(1)], [id(2)])).toBe(true);
    expect(selectionChanged([], [])).toBe(false);
  });

  it('keepKnown descarta ids que não existem mais', () => {
    const options = pickerOptions([tag(1, 'A etiqueta')], []);
    expect(keepKnown([id(1), id(9)], options)).toEqual([id(1)]);
  });
});

describe('quickCreateName (FA-01)', () => {
  const known = [{ name: 'Obras emergenciais' }, { name: 'Antiga' }];

  it('oferece criar um nome válido que ainda não existe', () => {
    expect(quickCreateName('  Recurso federal ', known)).toBe('Recurso federal');
  });

  it('não oferece para nome repetido (inclusive inativa, sem caixa), curto ou longo', () => {
    expect(quickCreateName('obras EMERGENCIAIS', known)).toBeNull();
    expect(quickCreateName('antiga', known)).toBeNull();
    expect(quickCreateName('a', known)).toBeNull();
    expect(quickCreateName('x'.repeat(41), known)).toBeNull();
    expect(quickCreateName('', known)).toBeNull();
  });
});
