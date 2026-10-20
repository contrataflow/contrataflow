import type { PromptTemplate } from '../../domain/prompts.js';

/*
 * Prompt `draft.tr` (US-120 · RN-AI-06/43..46): rascunho das seções narrativas do Termo de
 * Referência a partir do ETP, dos riscos, da pesquisa de preços, dos itens e das condições já
 * cadastradas no TR. Versionado em código: mudar UMA letra exige nova `version` e a linha
 * correspondente em `prompt-fingerprints.ts` (a versão antiga continua citada pelas gerações gravadas).
 */
export const TERM_DRAFT_PROMPT: PromptTemplate = {
  key: 'draft.tr',
  version: '1.0.0',
  instructions: [
    'Tarefa: redigir as seções narrativas do Termo de Referência (TR — Lei 14.133/2021, art. 6º, XXIII) a partir do ETP do processo e dos dados já cadastrados: condições contratuais do TR, itens com especificação e critérios de aceitação, riscos e tratamentos, pesquisa de preços concluída e DFD (quando houver).',
    '',
    'Orientações específicas do TR:',
    '- Para cada seção pedida, siga o guia de redação do modelo do órgão: título, orientação, base legal e texto padrão (quando houver). Objeto, fundamentação e descrição da solução reescrevem o que o ETP diz, sem acrescentar fatos.',
    '- Prazos, vigência, pagamento, garantias, local de entrega, subcontratação e critério de julgamento só podem vir das condições contratuais do TR. Condição não informada sai como [a confirmar: <condição>], por exemplo [a confirmar: prazo de pagamento] ou [a confirmar: local de entrega]. Nunca proponha prazo, garantia, percentual ou local que não esteja nos dados.',
    '- Obrigações e sanções partem do modelo do órgão, da base legal das seções e dos riscos e tratamentos. Não crie percentual nem valor de multa: sem o número nos dados, escreva [a confirmar: percentual da multa]. Preserve as citações legais (lei, artigo, inciso).',
    '- Valor estimado só o da pesquisa de preços informada nos dados; sem ele, escreva [a confirmar: valor estimado da pesquisa de preços]. Nunca calcule, arredonde ou estime outro valor.',
    '- A adequação orçamentária depende da dotação, que não consta dos dados: escreva [a confirmar: dotação orçamentária].',
    '- Seções marcadas como texto complementar acompanham uma tabela gerada a partir dos dados (itens, valores): escreva só o texto de apoio, sem repetir a tabela nem os números dela.',
    '- Itens, quantidades, unidades, datas, prazos e valores só podem aparecer como estão nos dados de referência; não os altere, não os some e não os converta.',
    '- Refira-se às pessoas apenas pelo papel ou pela unidade (contratada, contratante, fiscal do contrato, área requisitante), nunca pelo nome; nunca cite fornecedores.',
    '- Seção opcional sem informação nos dados pode ser omitida da resposta; as obrigatórias sempre devem vir, com [a confirmar: <o que falta>] no que não constar dos dados.',
    '- Texto objetivo, em parágrafos curtos; use lista apenas quando houver vários elementos de mesma natureza, como obrigações e sanções.',
  ].join('\n'),
};
