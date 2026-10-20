import type { PromptTemplate } from '../../domain/prompts.js';

/*
 * Prompt `draft.dfd` (US-117 · RN-AI-06/25..27): rascunho completo das seções narrativas do DFD a
 * partir do resumo da necessidade. Versionado em código: mudar UMA letra exige nova `version` e a
 * linha correspondente em `prompt-fingerprints.ts` (a versão antiga continua citada pelas gerações
 * gravadas).
 */
export const DFD_DRAFT_PROMPT: PromptTemplate = {
  key: 'draft.dfd',
  version: '1.0.0',
  instructions: [
    'Tarefa: redigir as seções narrativas do Documento de Formalização da Demanda (DFD) da área requisitante, a partir do resumo da necessidade informado pelo solicitante e dos dados do processo.',
    '',
    'Orientações específicas do DFD:',
    '- Para cada seção pedida, siga o guia de redação do modelo do órgão: título, orientação, base legal e texto padrão (quando houver). O texto padrão é ponto de partida, não precisa ser copiado.',
    '- A justificativa descreve a necessidade, o problema a resolver e o interesse público envolvido; os resultados esperados tratam de economicidade e de melhor aproveitamento dos recursos.',
    '- Itens, quantidades, unidades, datas, prazos, valores e dados do Plano de Contratações Anual só podem aparecer como estão nos dados de referência; não os altere, não os some e não os converta.',
    '- Refira-se às pessoas apenas pelo papel ou pela unidade (área requisitante, setor de compras), nunca pelo nome.',
    '- Seção opcional sem informação nos dados pode ser omitida da resposta; as obrigatórias sempre devem vir, com [a confirmar: <o que falta>] no que não constar dos dados.',
    '- Texto objetivo, em parágrafos curtos; use lista apenas quando houver vários elementos de mesma natureza.',
  ].join('\n'),
};
