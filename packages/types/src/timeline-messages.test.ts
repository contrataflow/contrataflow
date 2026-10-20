import { describe, expect, it } from 'vitest';

import { TIMELINE_MESSAGE_TEMPLATES, renderTimelineEntry } from './timeline-messages.js';
import { TIMELINE_ENTRY_TYPES } from './timeline.js';

const user = { actorType: 'USER', actorName: 'Carlos Lima' } as const;

describe('dicionário de mensagens da timeline (US-060 · RN-TML-14)', () => {
  it('tem uma mensagem para cada tipo do registro', () => {
    expect(Object.keys(TIMELINE_MESSAGE_TEMPLATES).sort()).toEqual(
      [...TIMELINE_ENTRY_TYPES].sort(),
    );
  });

  it('renderiza todo tipo sem placeholder sobrando, mesmo sem params', () => {
    for (const type of TIMELINE_ENTRY_TYPES) {
      const { message } = renderTimelineEntry({ ...user, type, params: {} });
      expect(message, type).not.toMatch(/[{}]/);
    }
  });

  it.each([
    [
      'PROCESS_CREATED',
      { code: '0012/2026', title: 'Cimento' },
      'Carlos Lima abriu o processo 0012/2026',
    ],
    [
      'PROCESS_UPDATED',
      { fields: ['title', 'priority'] },
      'Carlos Lima alterou o título e a prioridade',
    ],
    [
      'PROCESS_UPDATED',
      { fields: ['title', 'object', 'campoNovo'] },
      'Carlos Lima alterou o título, o objeto e outros dados',
    ],
    ['PROCESS_UPDATED', { fields: [] }, 'Carlos Lima alterou os dados do processo'],
    [
      'PROCESS_FORWARDED',
      { toStageName: 'Pesquisa de preços', toDepartmentName: 'Setor de Cotações' },
      'Carlos Lima encaminhou para Pesquisa de preços — Setor de Cotações',
    ],
    [
      'PARTICIPANT_ADDED',
      { name: 'Ana', role: 'CONSULTANT' },
      'Carlos Lima adicionou Ana como consultor',
    ],
    [
      'CONFIDENTIALITY_CHANGED',
      { isBudgetConfidential: false },
      'Carlos Lima marcou o orçamento como público',
    ],
    [
      'CONFIDENTIALITY_CHANGED',
      { isBudgetConfidential: true },
      'Carlos Lima marcou o orçamento como sigiloso',
    ],
    [
      'DOCUMENT_VERSION_CREATED',
      { versionNumber: 3, documentCode: 'DFD-0001/2026', documentTitle: 'DFD do cimento' },
      'Carlos Lima gerou a versão 3 de DFD-0001/2026 — DFD do cimento',
    ],
    ['DOCUMENT_APPROVED', { typeName: 'ETP' }, 'ETP aprovado'],
    ['DOCUMENT_SUBMITTED', {}, 'Carlos Lima submeteu o documento'],
    [
      'APPROVAL_DECIDED',
      { decision: 'APPROVED', title: 'Aprovação do DFD' },
      'Carlos Lima aprovou — Aprovação do DFD',
    ],
    ['APPROVAL_DECIDED', { decision: 'OUTRA', title: 'X' }, 'Carlos Lima decidiu — X'],
    [
      'RISK_ADDED',
      { code: 'R01', level: 'EXTREME' },
      'Carlos Lima registrou o risco R01 (extremo)',
    ],
    ['RISK_ADDED', { code: 'R02', level: 'NOVO' }, 'Carlos Lima registrou o risco R02 (NOVO)'],
    ['PROCESS_ASSIGNED', { toUserName: null }, 'Carlos Lima atribuiu o processo a —'],
    [
      'AI_CONTENT_REVIEWED',
      { documentCode: 'DFD 0005/2026', documentTitle: 'DFD', sectionsCount: 2, risksCount: 0 },
      'Carlos Lima revisou o conteúdo gerado por IA em DFD 0005/2026 — DFD (2 seções)',
    ],
    [
      'AI_CONTENT_APPLIED',
      { documentCode: 'DFD 0005/2026', documentTitle: 'DFD', sectionsCount: 2, risksCount: 0 },
      'Carlos Lima aplicou conteúdo gerado por IA em DFD 0005/2026 — DFD (2 seções)',
    ],
    [
      'AI_CONTENT_REVIEWED',
      { targetModule: 'RISK_MAP', sectionsCount: 1, risksCount: 3 },
      'Carlos Lima revisou o conteúdo gerado por IA em o mapa de riscos (1 seção e 3 riscos)',
    ],
  ] as const)('%s %o → "%s"', (type, params, expected) => {
    expect(renderTimelineEntry({ ...user, type, params }).message).toBe(expected);
  });

  it('ator de sistema aparece como "Sistema"; usuário sem nome congelado, como "Usuário"', () => {
    expect(
      renderTimelineEntry({ type: 'PROCESS_CLAIMED', actorType: 'SYSTEM', actorName: null })
        .message,
    ).toBe('Sistema assumiu o processo');
    expect(
      renderTimelineEntry({ type: 'PROCESS_CLAIMED', actorType: 'USER', actorName: ' ' }).message,
    ).toBe('Usuário assumiu o processo');
  });

  it('detalhe: trecho do comentário ou motivo; nada nos demais', () => {
    expect(
      renderTimelineEntry({ ...user, type: 'COMMENT_ADDED', params: { excerpt: 'Ver item 3' } }),
    ).toEqual({ message: 'Carlos Lima comentou', detail: 'Ver item 3' });
    expect(
      renderTimelineEntry({ ...user, type: 'PROCESS_SUSPENDED', params: { reason: 'Recesso' } })
        .detail,
    ).toBe('Recesso');
    expect(renderTimelineEntry({ ...user, type: 'PROCESS_CLAIMED', params: null }).detail).toBe(
      null,
    );
  });

  it('tipo fora do registro vira frase neutra', () => {
    expect(renderTimelineEntry({ ...user, type: 'TIPO_RETIRADO' }).message).toBe(
      'Carlos Lima registrou um evento',
    );
  });
});
