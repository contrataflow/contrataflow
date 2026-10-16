import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  duplicateWindowStart,
  isPossibleDuplicate,
  trigramSimilarity,
  trigrams,
} from './duplicate-detection.js';

const ANA = '0192f000-0000-7000-8000-0000000000a1';
const BETO = '0192f000-0000-7000-8000-0000000000a2';
const MANUTENCAO = '0192f000-0000-7000-8000-0000000000d2';
const SAUDE = '0192f000-0000-7000-8000-0000000000d9';
const NOW = new Date('2026-10-16T13:00:00.000Z');

describe('Heurística de duplicidade (US-001 · FA-02 · RN-PROC-13)', () => {
  it('trigramas como o pg_trgm (palavras em minúsculas, "  x " de borda)', () => {
    expect([...trigrams('Cão')].sort()).toEqual(['  c', ' cã', 'cão', 'ão '].sort());
    expect(trigrams('  ').size).toBe(0);
  });

  it('similaridade igual à do pg_trgm no exemplo do Gherkin (0,837) e abaixo do limiar para outro objeto', () => {
    const similarity = trigramSimilarity(
      'Aquisição de cimento para manutenção de vias',
      'Aquisição de cimento p/ manutenção das vias',
    );
    expect(similarity).toBeCloseTo(0.8372093, 6);
    expect(similarity).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY_THRESHOLD);
    expect(trigramSimilarity('Aquisição de cimento', 'Contratação de limpeza')).toBeCloseTo(
      0.1578947,
      6,
    );
    expect(trigramSimilarity('', 'qualquer')).toBe(0);
  });

  const probe = {
    title: 'Aquisição de cimento p/ manutenção das vias',
    object: 'Cimento para tapa-buracos',
    requestingDepartmentId: MANUTENCAO,
    createdById: ANA,
    since: new Date(NOW.getTime() - 10 * 60_000),
  };
  const candidate = {
    title: 'Aquisição de cimento para manutenção de vias',
    object: 'Outro objeto qualquer, sem relação',
    requestingDepartmentId: SAUDE,
    createdById: ANA,
    createdAt: new Date(NOW.getTime() - 3 * 60_000),
  };

  it('candidato: título semelhante, mesmo criador, dentro da janela', () => {
    expect(isPossibleDuplicate(candidate, probe)).toBe(true);
  });

  it('candidato pelo objeto semelhante e mesmo setor (outro criador)', () => {
    expect(
      isPossibleDuplicate(
        {
          ...candidate,
          title: 'Título totalmente diferente',
          object: 'Cimento para tapa buracos',
          createdById: BETO,
          requestingDepartmentId: MANUTENCAO,
        },
        probe,
      ),
    ).toBe(true);
  });

  it('não é candidato: fora da janela, outro criador e setor, ou textos diferentes', () => {
    expect(
      isPossibleDuplicate(
        { ...candidate, createdAt: new Date(NOW.getTime() - 11 * 60_000) },
        probe,
      ),
    ).toBe(false);
    expect(isPossibleDuplicate({ ...candidate, createdById: BETO }, probe)).toBe(false);
    expect(
      isPossibleDuplicate({ ...candidate, title: 'Contratação de serviço de limpeza' }, probe),
    ).toBe(false);
  });

  it('janela 0 (ou negativa) desativa a detecção', () => {
    expect(duplicateWindowStart(NOW, 0)).toBeNull();
    expect(duplicateWindowStart(NOW, -5)).toBeNull();
    expect(duplicateWindowStart(NOW, 10)).toEqual(new Date('2026-10-16T12:50:00.000Z'));
  });
});
