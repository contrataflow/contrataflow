import type { PromptTemplate } from '../../domain/prompts.js';

/*
 * Prompt `draft.risk_map` (US-119 · RN-AI-06/38..41): proposta de riscos e tratamentos do processo
 * (e, com o Mapa de Riscos emitido, das seções narrativas) a partir do DFD, do ETP e do TR.
 * Versionado em código: mudar UMA letra exige nova `version` e a linha correspondente em
 * `prompt-fingerprints.ts`.
 */
export const RISK_MAP_DRAFT_PROMPT: PromptTemplate = {
  key: 'draft.risk_map',
  version: '1.0.0',
  instructions: [
    'Tarefa: propor os riscos da contratação e as ações de tratamento de cada um, para o Mapa de Riscos da fase preparatória (Lei 14.133/2021, art. 18, X), a partir do DFD, do ETP e do Termo de Referência informados nos dados de referência.',
    '',
    'Orientações específicas do Mapa de Riscos:',
    '- Proponha de 1 a 15 riscos concretos deste processo, nas fases de planejamento, seleção do fornecedor e gestão do contrato; evite riscos genéricos que valeriam para qualquer contratação.',
    '- Cada risco traz título, descrição, categoryCode (um dos códigos de categoria informados), phase (PLANNING, SELECTION ou CONTRACT_MANAGEMENT), causa, consequência, probability e impact (inteiros de 1 até o máximo da escala informada), rationale curta e de 1 a 3 tratamentos (type PREVENTIVE ou CONTINGENCY e description).',
    '- Não repita riscos já registrados; se um risco proposto for parecido com um deles, informe o código do registrado (ex.: R03) em similarToRiskCode.',
    '- Nunca indique responsável, prazo, data ou valor nos riscos e tratamentos: isso é decisão da equipe. O que depender de informação ausente vai como [a confirmar: <o que falta>].',
    '- Refira-se às pessoas apenas pelo papel ou pela unidade, nunca pelo nome.',
    '- Seções narrativas só quando pedidas: a introdução apresenta o objetivo do mapa, a metodologia explica a avaliação probabilidade × impacto e os critérios de tratamento; a seção opcional pode ser omitida.',
    '- Formato dos riscos na resposta: "risks":[{"title":"...","description":"...","categoryCode":"...","phase":"PLANNING","cause":"...","consequence":"...","probability":3,"impact":4,"rationale":"...","treatments":[{"type":"PREVENTIVE","description":"..."}]}].',
  ].join('\n'),
};
