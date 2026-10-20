import type { PromptTemplate } from '../../domain/prompts.js';

/*
 * Prompt `draft.etp` (US-118 · RN-AI-06/33..37): rascunho das seções narrativas do Estudo Técnico
 * Preliminar a partir do DFD e dos dados já cadastrados no ETP (itens, alternativas, pesquisa de
 * preços). Versionado em código: mudar UMA letra exige nova `version` e a linha correspondente em
 * `prompt-fingerprints.ts` (a versão antiga continua citada pelas gerações gravadas).
 */
export const ETP_DRAFT_PROMPT: PromptTemplate = {
  key: 'draft.etp',
  version: '1.0.0',
  instructions: [
    'Tarefa: redigir as seções narrativas do Estudo Técnico Preliminar (ETP — Lei 14.133/2021, art. 18, §1º) a partir do DFD do processo e dos dados já cadastrados no ETP: itens com quantidades e memórias de cálculo, alternativas avaliadas e pesquisa de preços concluída.',
    '',
    'Orientações específicas do ETP:',
    '- Para cada seção pedida, siga o guia de redação do modelo do órgão: título, orientação, base legal e texto padrão (quando houver). A necessidade, o problema, o objetivo, os resultados e o alinhamento ao plano de contratações reescrevem o que o DFD diz, sem acrescentar fatos.',
    '- A IA não decide: a conclusão sobre a viabilidade, a solução escolhida e o parcelamento são decisões da pessoa. Se a decisão já estiver registrada nos dados, descreva-a sem alterá-la; se estiver pendente, escreva [a confirmar: conclusão sobre a viabilidade], [a confirmar: solução escolhida] ou [a confirmar: decisão sobre o parcelamento], conforme a seção. Justificativa que não conste dos dados vai como [a confirmar: <o que falta>].',
    '- Sem solução escolhida, a descrição da solução apresenta as alternativas cadastradas com vantagens e desvantagens, sem recomendar nenhuma.',
    '- Valor estimado só o da pesquisa de preços informada nos dados; sem ele, escreva [a confirmar: valor estimado da pesquisa de preços]. Nunca use o custo de uma alternativa nem outro valor como estimativa.',
    '- Requisitos e levantamento de mercado partem dos itens, das orientações do modelo e do método e do número de cotações da pesquisa; não invente requisito técnico, norma, marca nem fornecedor.',
    '- Seções marcadas como texto complementar acompanham uma tabela gerada a partir dos dados (itens, alternativas, riscos, valores): escreva só o texto de apoio, sem repetir a tabela nem os números dela.',
    '- Contratações correlatas, impactos ambientais e providências prévias só com o que vier do resumo ou das orientações; sem base, use [a confirmar: <o que falta>].',
    '- Itens, quantidades, unidades, datas, prazos e valores só podem aparecer como estão nos dados de referência; não os altere, não os some e não os converta.',
    '- Refira-se às pessoas apenas pelo papel ou pela unidade (área requisitante, setor de compras), nunca pelo nome.',
    '- Seção opcional sem informação nos dados pode ser omitida da resposta; as obrigatórias sempre devem vir, com [a confirmar: <o que falta>] no que não constar dos dados.',
    '- Texto objetivo, em parágrafos curtos; use lista apenas quando houver vários elementos de mesma natureza.',
  ].join('\n'),
};
