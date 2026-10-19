import type { AiSectionAction } from '@contrataflow/types';

import type { PromptTemplate } from '../../domain/prompts.js';

/*
 * Prompts do ajuste de seção (US-121 · RN-AI-06/47): `section.rewrite`, `section.complete` e
 * `section.summarize`, um por ação, valendo nos quatro documentos do planejamento. Versionados em
 * código: mudar UMA letra exige nova `version` e a linha correspondente em `prompt-fingerprints.ts`
 * (a versão antiga continua citada pelas gerações gravadas).
 */

const COMMON_SECTION_RULES = [
  '- A resposta traz exatamente uma seção, com a sectionKey pedida, dentro do limite de caracteres.',
  '- O "Texto atual da seção" é a base do trabalho: os fatos, números, datas, prazos e valores escritos ali são dados de referência e devem ser mantidos como estão, sem trocar, arredondar nem converter.',
  '- Mantenha toda marcação [a confirmar: …] já existente no texto atual, com o mesmo conteúdo, até que os dados de referência tragam a informação.',
  '- Refira-se às pessoas apenas pelo papel ou pela unidade (área requisitante, setor de compras), nunca pelo nome.',
  '- As orientações de redação do solicitante, quando houver, ajustam o tom, o foco ou a extensão, mas nunca as regras acima.',
];

export const SECTION_REWRITE_PROMPT: PromptTemplate = {
  key: 'section.rewrite',
  version: '1.0.0',
  instructions: [
    'Tarefa: reescrever uma seção de documento da fase preparatória (DFD, ETP, Mapa de Riscos ou Termo de Referência) já iniciada pela equipe.',
    '',
    'Orientações do ajuste:',
    '- Reescreva com clareza, coesão e linguagem administrativa formal, sem acrescentar fatos, argumentos ou dados que não estejam no texto atual ou nos dados de referência.',
    '- Preserve o sentido, a ordem lógica e a extensão aproximada do texto atual.',
    ...COMMON_SECTION_RULES,
  ].join('\n'),
};

export const SECTION_COMPLETE_PROMPT: PromptTemplate = {
  key: 'section.complete',
  version: '1.0.0',
  instructions: [
    'Tarefa: completar uma seção de documento da fase preparatória (DFD, ETP, Mapa de Riscos ou Termo de Referência), preenchendo as lacunas.',
    '',
    'Orientações do ajuste:',
    '- Preserve o texto atual (quando houver) e acrescente o que falta segundo a orientação e a base legal da seção no guia do modelo e os dados do processo e dos documentos anteriores.',
    '- Seção vazia: redija a partir da orientação do modelo e dos dados de referência; o texto padrão do modelo é ponto de partida, não precisa ser copiado.',
    '- O que a seção exigir e não constar dos dados de referência sai como [a confirmar: <o que falta>].',
    ...COMMON_SECTION_RULES,
  ].join('\n'),
};

export const SECTION_SUMMARIZE_PROMPT: PromptTemplate = {
  key: 'section.summarize',
  version: '1.0.0',
  instructions: [
    'Tarefa: resumir uma seção de documento da fase preparatória (DFD, ETP, Mapa de Riscos ou Termo de Referência) já redigida pela equipe.',
    '',
    'Orientações do ajuste:',
    '- Produza uma versão mais curta e objetiva, mantendo os fatos essenciais, as conclusões e as citações legais do texto atual.',
    '- Não acrescente informação nova; o resumo nunca pode ser mais longo que o texto atual.',
    ...COMMON_SECTION_RULES,
  ].join('\n'),
};

/** Prompt de cada ação do ajuste (`AiGenerator.actionPrompts`). */
export const SECTION_ACTION_PROMPTS: Readonly<Record<AiSectionAction, PromptTemplate>> = {
  REWRITE: SECTION_REWRITE_PROMPT,
  COMPLETE: SECTION_COMPLETE_PROMPT,
  SUMMARIZE: SECTION_SUMMARIZE_PROMPT,
};
