import {
  DEFAULT_TEMPLATE_LAYOUT,
  DEFAULT_TR_IMPORT_MAPPINGS,
  layoutDefinitionSchema,
  richTextFromPlainText,
  sectionDefinitionSchema,
  SYSTEM_MODULE_SECTION_KEYS,
  TYPED_HEADER_FIELDS,
} from '@contrataflow/validation';
import type {
  ImportMappings,
  LayoutDefinition,
  SectionDefinition,
  SectionDefinitionInput,
  Violation,
} from '@contrataflow/validation';
import { z } from 'zod';

import type { DocumentTemplate, DocumentTemplateVersion } from './document-template.js';
import { SYSTEM_DOCUMENT_TYPES } from './system-document-types.js';
import { FULL_VALIDATION, validateTemplateContent } from './template-content.validator.js';

/*
 * Biblioteca padrão de templates (US-110 · RN-TPL-28..34 · DEC-016/017): fixture versionado com o
 * release da plataforma — um modelo por tipo de documento semeado com template (todos menos
 * `DOCUMENTO_EXTERNO`, `kind = UPLOADED`), com as seções canônicas de entities.md, orientação ao
 * redator (`helpText`) e base legal (`legalBasis`) quando há dispositivo direto. Os textos-base são
 * redigidos para revisão pela Procuradoria do tenant; nada aqui fica travado (RN-TPL-32).
 *
 * `loadTemplateLibrary` é a validação de RN-TPL-34: o mesmo `sectionDefinitionSchema`/
 * `layoutDefinitionSchema` da API e o `TemplateContentValidator` com o escopo da publicação. Roda no
 * teste de unidade (o pipeline de build não avança com a biblioteca inválida) e de novo no seeder,
 * antes de qualquer escrita.
 */

/** Versão do conteúdo semeado, gravada no `seedVersions` da auditoria `tenant.provision`. */
export const TEMPLATE_LIBRARY_VERSION = '2026.10.4';

/** Definição de um modelo padrão (forma de entrada, antes dos padrões do schema). */
export interface TemplateLibraryEntry {
  readonly documentTypeCode: string;
  readonly name: string;
  readonly description: string;
  readonly sections: readonly SectionDefinitionInput[];
}

/** Modelo padrão conferido, pronto para virar a versão 1 publicada. */
export interface LoadedTemplateLibraryEntry {
  readonly documentTypeCode: string;
  readonly name: string;
  readonly description: string;
  readonly sections: readonly SectionDefinition[];
  readonly layout: LayoutDefinition;
  readonly fieldConfig: Record<string, never>;
  readonly importMappings: ImportMappings | null;
}

/**
 * V-01 (`TEMPLATE_INVALID`): a biblioteca não carrega ou viola as regras de publicação. Nunca chega
 * ao usuário do tenant — bloqueia o release (teste) ou a etapa `document.templateLibrary` (seeder).
 */
export class TemplateLibraryInvalidError extends Error {
  readonly code = 'TEMPLATE_INVALID';

  constructor(
    /** Tipo de documento cuja definição falhou (`#<posição>` quando nem o código é legível). */
    readonly documentTypeCode: string,
    /** Motivos: caminhos do schema ou códigos do `TemplateContentValidator`. */
    readonly problems: readonly string[],
    readonly violations: readonly Violation[] = [],
  ) {
    super(
      `A biblioteca padrão falhou na validação interna (${documentTypeCode}): ${problems.join('; ')}.`,
    );
    this.name = 'TemplateLibraryInvalidError';
  }
}

interface SectionSpec {
  readonly key: string;
  readonly title: string;
  readonly helpText: string;
  readonly legalBasis?: string;
  readonly requirement?: SectionDefinitionInput['requirement'];
  readonly render?: SectionDefinitionInput['render'];
  readonly allowNarrative?: boolean;
  readonly defaultContent?: string;
  readonly minChars?: number;
}

/** Seções na ordem da lista (`order` a partir de 1 — RN-TPL-04). */
function sections(specs: readonly SectionSpec[]): SectionDefinitionInput[] {
  return specs.map((spec, index) => ({
    key: spec.key,
    title: spec.title,
    order: index + 1,
    requirement: spec.requirement ?? 'REQUIRED',
    helpText: spec.helpText,
    ...(spec.legalBasis === undefined ? {} : { legalBasis: spec.legalBasis }),
    ...(spec.minChars === undefined ? {} : { minChars: spec.minChars }),
    ...(spec.defaultContent === undefined
      ? {}
      : { defaultContent: richTextFromPlainText(spec.defaultContent) }),
    render: spec.render ?? 'TEXT',
    allowNarrative: spec.allowNarrative ?? true,
  }));
}

const LEI = 'Lei 14.133/2021';
const ETP_BASE = `${LEI}, art. 18, §1º`;
const TR_BASE = `${LEI}, art. 6º, XXIII`;
const REVIEW_NOTE = 'Texto-base para revisão pela Procuradoria do órgão.';

/** Seção computada: o conteúdo vem do módulo na renderização, sem narrativa obrigatória. */
const computed = { requirement: 'OPTIONAL', allowNarrative: false } as const;

export const TEMPLATE_LIBRARY: readonly TemplateLibraryEntry[] = [
  {
    documentTypeCode: 'DFD',
    name: 'DFD — Modelo padrão',
    description: `Documento de Formalização da Demanda (Decreto 10.947/2022). ${REVIEW_NOTE}`,
    sections: sections([
      // US-014 · RN-DFD-07: chaves, títulos, base legal e `minChars` do DFD semeado.
      {
        key: 'JUSTIFICATION',
        title: 'Justificativa da necessidade',
        helpText:
          'Descreva a necessidade da contratação, o problema a resolver e o interesse público envolvido, considerando o planejamento do órgão.',
        legalBasis: `${LEI}, art. 12, VII; Decreto 10.947/2022, art. 8º, I`,
        minChars: 50,
      },
      {
        key: 'EXPECTED_RESULTS',
        title: 'Resultados esperados',
        helpText:
          'Indique os resultados esperados em termos de economicidade e de melhor aproveitamento dos recursos.',
        legalBasis: `Boa prática (insumo do ETP, ${LEI}, art. 18, § 1º, IX)`,
      },
      {
        key: 'NOTES',
        title: 'Observações',
        requirement: 'OPTIONAL',
        helpText:
          'Informações complementares: vinculação ou dependência com outras demandas (outro DFD), restrições de prazo e unidades envolvidas.',
        legalBasis: 'Decreto 10.947/2022, art. 8º, VII (dependências)',
      },
    ]),
  },
  {
    documentTypeCode: 'ETP',
    name: 'ETP — Modelo padrão',
    description: `Estudo Técnico Preliminar com os elementos do ${ETP_BASE}. ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'NEED_DESCRIPTION',
        title: 'Descrição da necessidade',
        helpText:
          'Descreva a necessidade da contratação, considerado o problema a ser resolvido sob a perspectiva do interesse público.',
        legalBasis: `${ETP_BASE}, I`,
      },
      {
        key: 'PROBLEM',
        title: 'Problema a ser resolvido',
        // RN-ETP-02 (US-019): PROBLEM e OBJECTIVE são opcionais.
        requirement: 'OPTIONAL',
        helpText: 'Detalhe o problema ou a deficiência que motiva a contratação e seus impactos.',
        legalBasis: `${ETP_BASE}, I`,
      },
      {
        key: 'OBJECTIVE',
        title: 'Objetivo da contratação',
        requirement: 'OPTIONAL',
        helpText: 'Indique o que se pretende alcançar com a contratação.',
      },
      {
        key: 'PCA_ALIGNMENT',
        title: 'Alinhamento ao plano de contratações anual',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Demonstre a previsão da contratação no plano de contratações anual, se houver, ou justifique a ausência.',
        legalBasis: `${ETP_BASE}, II`,
      },
      {
        key: 'REQUIREMENTS',
        title: 'Requisitos da contratação',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Liste os requisitos necessários e suficientes à escolha da solução, inclusive de sustentabilidade.',
        legalBasis: `${ETP_BASE}, III`,
      },
      {
        key: 'MARKET_SURVEY',
        title: 'Levantamento de mercado',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Registre as alternativas disponíveis no mercado e a justificativa técnica e econômica da escolha do tipo de solução.',
        legalBasis: `${ETP_BASE}, V`,
      },
      {
        key: 'ALTERNATIVES',
        title: 'Alternativas avaliadas',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText: 'Compare as alternativas consideradas, com vantagens e desvantagens de cada uma.',
        legalBasis: `${ETP_BASE}, V`,
      },
      {
        key: 'ESTIMATES',
        title: 'Estimativas das quantidades e do valor',
        helpText:
          'Apresente as estimativas das quantidades, com as memórias de cálculo, e a estimativa do valor da contratação.',
        legalBasis: `${ETP_BASE}, IV e VI`,
      },
      {
        key: 'RECOMMENDED_SOLUTION',
        title: 'Descrição da solução como um todo',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Descreva a solução recomendada, inclusive as exigências de manutenção e assistência técnica, quando for o caso.',
        legalBasis: `${ETP_BASE}, VII`,
      },
      {
        key: 'PARCELING',
        title: 'Parcelamento da solução',
        helpText: 'Justifique o parcelamento ou não da solução.',
        legalBasis: `${ETP_BASE}, VIII`,
      },
      {
        key: 'RELATED_CONTRACTS',
        title: 'Contratações correlatas e interdependentes',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText: 'Indique contratações correlatas ou interdependentes, se houver.',
        legalBasis: `${ETP_BASE}, XI`,
      },
      {
        key: 'EXPECTED_RESULTS',
        title: 'Resultados pretendidos',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Demonstre os resultados pretendidos em termos de economicidade e de melhor aproveitamento dos recursos.',
        legalBasis: `${ETP_BASE}, IX`,
      },
      {
        key: 'ENVIRONMENTAL_IMPACTS',
        title: 'Impactos ambientais',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Descreva os possíveis impactos ambientais e as medidas mitigadoras, incluídos requisitos de baixo consumo de energia e de logística reversa.',
        legalBasis: `${ETP_BASE}, XII`,
      },
      {
        key: 'PRIOR_MEASURES',
        title: 'Providências prévias à contratação',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Indique as providências a adotar antes da celebração do contrato, inclusive capacitação de servidores para fiscalização e gestão.',
        legalBasis: `${ETP_BASE}, X`,
      },
      {
        key: 'RISKS',
        title: 'Riscos da contratação',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Resuma os principais riscos identificados; o detalhamento fica no mapa de riscos do processo.',
        legalBasis: `${LEI}, art. 18, X`,
      },
      {
        key: 'CONCLUSION',
        title: 'Posicionamento conclusivo',
        helpText:
          'Apresente o posicionamento conclusivo sobre a adequação da contratação para o atendimento da necessidade.',
        legalBasis: `${ETP_BASE}, XIII`,
      },
    ]),
  },
  {
    documentTypeCode: 'TR',
    name: 'Termo de Referência — Modelo padrão',
    description: `Termo de Referência com os elementos do ${TR_BASE}. ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'OBJECT',
        title: 'Definição do objeto',
        helpText:
          'Defina o objeto, com natureza, quantitativos, prazo do contrato e, se for o caso, a possibilidade de prorrogação.',
        legalBasis: `${TR_BASE}, a`,
      },
      {
        key: 'JUSTIFICATION',
        title: 'Fundamentação da contratação',
        helpText:
          'Apresente a fundamentação da contratação, com referência aos estudos técnicos preliminares correspondentes.',
        legalBasis: `${TR_BASE}, b`,
      },
      {
        key: 'SPECIFICATIONS',
        title: 'Descrição da solução e especificações',
        // US-036: a tabela de itens do TR (US-038) com a narrativa das especificações.
        render: 'ITEMS_TABLE',
        helpText:
          'Descreva a solução como um todo, considerado todo o ciclo de vida do objeto, e as especificações técnicas.',
        legalBasis: `${TR_BASE}, c`,
      },
      {
        key: 'ACCEPTANCE_CRITERIA',
        title: 'Critérios de recebimento',
        helpText:
          'Defina os critérios de medição e de recebimento provisório e definitivo do objeto.',
        legalBasis: `${TR_BASE}, g`,
      },
      {
        key: 'CONTRACTOR_OBLIGATIONS',
        title: 'Obrigações da contratada',
        helpText: 'Liste as obrigações da contratada na execução do objeto.',
        legalBasis: `${TR_BASE}, e`,
      },
      {
        key: 'CONTRACTING_PARTY_OBLIGATIONS',
        title: 'Obrigações da contratante',
        helpText: 'Liste as obrigações da administração contratante.',
        legalBasis: `${TR_BASE}, e`,
      },
      {
        key: 'DEADLINES',
        title: 'Prazos de execução',
        helpText: 'Informe os prazos de início, de execução e de vigência do contrato.',
        legalBasis: `${TR_BASE}, a`,
      },
      {
        key: 'DELIVERY',
        title: 'Modelo de execução e entrega',
        // US-036: serviço remoto ou sem entrega física admite "não se aplica" justificado.
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Descreva como o contrato deverá produzir os resultados pretendidos: local, forma e condições de entrega ou de execução.',
        legalBasis: `${TR_BASE}, e`,
      },
      {
        key: 'PAYMENT',
        title: 'Critérios de pagamento',
        helpText: 'Defina os critérios de medição e de pagamento.',
        legalBasis: `${TR_BASE}, g`,
      },
      {
        key: 'OVERSIGHT',
        title: 'Gestão e fiscalização do contrato',
        helpText: 'Defina o modelo de gestão do contrato e como será fiscalizado.',
        legalBasis: `${TR_BASE}, f`,
      },
      {
        key: 'GUARANTEES',
        title: 'Garantias',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Indique a garantia do produto e a garantia contratual exigidas, se houver, ou justifique a dispensa.',
        legalBasis: `${LEI}, arts. 96 a 102`,
      },
      {
        key: 'SANCTIONS',
        title: 'Sanções administrativas',
        helpText: 'Relacione as infrações e as sanções aplicáveis à contratada.',
        legalBasis: `${LEI}, arts. 155 a 163`,
      },
      {
        key: 'SELECTION_CRITERIA',
        title: 'Forma e critérios de seleção do fornecedor',
        helpText: 'Indique a forma e os critérios de seleção do fornecedor.',
        legalBasis: `${TR_BASE}, h`,
      },
      {
        key: 'ESTIMATED_VALUE',
        title: 'Estimativa do valor da contratação',
        render: 'ESTIMATED_VALUE',
        helpText:
          'Apresente as estimativas do valor da contratação, acompanhadas dos preços unitários referenciais e das memórias de cálculo. Valor informado manualmente exige aqui a justificativa e a memória do valor.',
        legalBasis: `${TR_BASE}, i`,
      },
      {
        // US-036 (lacuna 1): alínea j — a dotação estruturada chega no MVP 2 (`BudgetAllocation`).
        key: 'BUDGET_ADEQUACY',
        title: 'Adequação orçamentária',
        requirement: 'REQUIRED_OR_JUSTIFY',
        helpText:
          'Indique a adequação orçamentária da contratação ou justifique por que ela não se aplica nesta fase.',
        legalBasis: `${TR_BASE}, j`,
      },
    ]),
  },
  {
    documentTypeCode: 'RISK_MAP',
    name: 'Mapa de Riscos — Modelo padrão',
    description: `Mapa de riscos da contratação (${LEI}, gestão de riscos). ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'INTRODUCTION',
        title: 'Introdução',
        helpText:
          'Apresente o objetivo do mapa de riscos e a fase da contratação a que ele se refere.',
        legalBasis: `${LEI}, art. 18, X`,
      },
      {
        key: 'METHODOLOGY',
        title: 'Metodologia',
        helpText:
          'Descreva o método de identificação e de avaliação dos riscos (probabilidade × impacto) e os critérios de tratamento.',
      },
      {
        key: 'RISK_MATRIX',
        title: 'Matriz de riscos',
        ...computed,
        render: 'RISK_MATRIX',
        helpText: 'Gerada a partir dos riscos cadastrados no mapa: não exige texto.',
      },
      {
        key: 'RISK_LIST',
        title: 'Riscos identificados',
        ...computed,
        render: 'RISK_LIST',
        helpText:
          'Gerada a partir dos riscos cadastrados, com causas, consequências e ações de tratamento.',
      },
      {
        key: 'NOTES',
        title: 'Observações',
        requirement: 'OPTIONAL',
        helpText: 'Registre premissas, limitações da análise e a periodicidade de revisão do mapa.',
      },
    ]),
  },
  {
    documentTypeCode: 'PRICE_RESEARCH',
    name: 'Pesquisa de Preços — Modelo padrão',
    description: `Pesquisa de preços e valor estimado (${LEI}, art. 23). ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'METHODOLOGY',
        title: 'Metodologia da pesquisa',
        helpText:
          'Descreva os parâmetros utilizados, as fontes consultadas e o método de cálculo do preço de referência.',
        legalBasis: `${LEI}, art. 23, §1º`,
      },
      {
        key: 'PRICE_SUMMARY',
        title: 'Mapa comparativo de preços',
        ...computed,
        render: 'PRICE_SUMMARY',
        helpText: 'Gerado a partir dos itens, das fontes e das cotações da pesquisa.',
      },
      {
        key: 'CONCLUSION',
        title: 'Conclusão',
        helpText:
          'Apresente o valor estimado da contratação e a justificativa de eventuais preços desconsiderados.',
        legalBasis: `${LEI}, art. 23`,
      },
    ]),
  },
  {
    documentTypeCode: 'DESPACHO',
    name: 'Despacho — Modelo padrão',
    description: `Despacho de encaminhamento ou decisão. ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'CONTENT',
        title: 'Conteúdo do despacho',
        helpText:
          'Indique o processo, o encaminhamento ou a decisão e a unidade destinatária, com a fundamentação pertinente.',
        legalBasis: `${LEI}, art. 40`,
        defaultContent:
          'Processo {{process.code}} — {{process.title}}.\n\nEncaminhem-se os autos para as providências cabíveis.\n\n{{organization.name}}, {{today}}.',
      },
    ]),
  },
  {
    documentTypeCode: 'OFICIO',
    name: 'Ofício — Modelo padrão',
    description: `Comunicação oficial do órgão. ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'CONTENT',
        title: 'Conteúdo do ofício',
        helpText: 'Identifique o destinatário, o assunto e a solicitação ou informação comunicada.',
        legalBasis: 'Base legal conforme o assunto tratado.',
        defaultContent:
          'Assunto: processo {{process.code}} — {{process.title}}.\n\nSenhor(a),\n\nCumprimentando-o(a), encaminhamos a presente comunicação para conhecimento e providências.\n\nAtenciosamente,\n\n{{organization.name}}',
      },
    ]),
  },
  {
    documentTypeCode: 'NOTA_TECNICA',
    name: 'Nota Técnica — Modelo padrão',
    description: `Nota técnica de instrução da contratação direta (${LEI}, art. 72). ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'CONTENT',
        title: 'Conteúdo da nota técnica',
        helpText:
          'Justifique a escolha do fornecedor e do preço na contratação direta, demonstrando a compatibilidade com o mercado e o atendimento aos requisitos de habilitação.',
        legalBasis: `${LEI}, art. 72, VI e VII`,
        defaultContent:
          'Processo {{process.code}} — {{process.object}}.\n\n1. Razão da escolha do contratado:\n\n2. Justificativa do preço:\n\n3. Conclusão:',
      },
    ]),
  },
  {
    documentTypeCode: 'AUTORIZACAO',
    name: 'Autorização — Modelo padrão',
    description: `Autorização da autoridade competente (${LEI}, art. 72). ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'CONTENT',
        title: 'Conteúdo da autorização',
        helpText:
          'Registre a autorização da autoridade competente, com o objeto, o fundamento legal e as condições.',
        legalBasis: `${LEI}, art. 72, VIII`,
        defaultContent:
          'Considerando o que consta do processo {{process.code}}, AUTORIZO a contratação de {{process.object}}, nos termos da legislação aplicável.\n\n{{organization.name}}, {{today}}.',
      },
    ]),
  },
  {
    documentTypeCode: 'DECLARACAO',
    name: 'Declaração — Modelo padrão',
    description: `Declaração em texto livre. ${REVIEW_NOTE}`,
    sections: sections([
      {
        key: 'CONTENT',
        title: 'Conteúdo da declaração',
        helpText: 'Indique quem declara, o que é declarado e a finalidade da declaração.',
        legalBasis: 'Base legal conforme o objeto da declaração.',
        defaultContent:
          'Declaro, para fins de instrução do processo {{process.code}}, que\n\n{{organization.name}}, {{today}}.',
      },
    ]),
  },
];

const entrySchema = z.strictObject({
  documentTypeCode: z.string().min(1),
  name: z.string().trim().min(3).max(150),
  description: z.string().trim().max(2000),
  sections: z.array(sectionDefinitionSchema).min(1),
});

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
}

function codeOf(raw: unknown, index: number): string {
  const code = (raw as { documentTypeCode?: unknown } | null)?.documentTypeCode;
  return typeof code === 'string' && code !== '' ? code : `#${index + 1}`;
}

const SYSTEM_TYPE_BY_CODE = new Map(SYSTEM_DOCUMENT_TYPES.map((spec) => [spec.code, spec]));

/** Tipos semeados que recebem template (RN-TPL-28): todos menos os `UPLOADED`. */
export const TEMPLATE_LIBRARY_TYPE_CODES: readonly string[] = SYSTEM_DOCUMENT_TYPES.filter(
  (spec) => spec.kind !== 'UPLOADED',
).map((spec) => spec.code);

/**
 * Carrega e confere a biblioteca (RN-TPL-34): estrutura, `sectionDefinitionSchema`, layout,
 * cobertura exata dos tipos com template e o `TemplateContentValidator` com o escopo completo (no
 * TR, o mapeamento padrão contra as seções do ETP da própria biblioteca). Devolve as entradas na
 * ordem da fixture.
 * @throws TemplateLibraryInvalidError — com o código do primeiro tipo que falhou
 */
export function loadTemplateLibrary(raw: unknown): LoadedTemplateLibraryEntry[] {
  if (!Array.isArray(raw)) {
    throw new TemplateLibraryInvalidError('(biblioteca)', ['a definição não é uma lista']);
  }
  const layout = layoutDefinitionSchema.safeParse(DEFAULT_TEMPLATE_LAYOUT);
  if (!layout.success) {
    throw new TemplateLibraryInvalidError('(layout)', issuesOf(layout.error));
  }

  const parsed = (raw as unknown[]).map((item, index) => {
    const result = entrySchema.safeParse(item);
    if (!result.success) {
      throw new TemplateLibraryInvalidError(codeOf(item, index), issuesOf(result.error));
    }
    return result.data;
  });

  const seen = new Set<string>();
  for (const entry of parsed) {
    const spec = SYSTEM_TYPE_BY_CODE.get(entry.documentTypeCode);
    if (!spec) throw new TemplateLibraryInvalidError(entry.documentTypeCode, ['tipo desconhecido']);
    if (spec.kind === 'UPLOADED') {
      throw new TemplateLibraryInvalidError(entry.documentTypeCode, ['tipo UPLOADED sem template']);
    }
    if (seen.has(entry.documentTypeCode)) {
      throw new TemplateLibraryInvalidError(entry.documentTypeCode, ['tipo repetido']);
    }
    seen.add(entry.documentTypeCode);
  }
  const missing = TEMPLATE_LIBRARY_TYPE_CODES.find((code) => !seen.has(code));
  if (missing) throw new TemplateLibraryInvalidError(missing, ['tipo sem modelo na biblioteca']);

  const etp = parsed.find((entry) => entry.documentTypeCode === 'ETP');
  const etpSectionKeys = etp
    ? etp.sections.map((section) => section.key)
    : SYSTEM_MODULE_SECTION_KEYS.ETP;

  return parsed.map((entry): LoadedTemplateLibraryEntry => {
    const spec = SYSTEM_TYPE_BY_CODE.get(entry.documentTypeCode);
    if (!spec) throw new TemplateLibraryInvalidError(entry.documentTypeCode, ['tipo desconhecido']);
    const isTermOfReference = spec.systemModule === 'TERM_OF_REFERENCE';
    const content = {
      sections: [...entry.sections].sort((a, b) => a.order - b.order),
      layout: structuredClone(layout.data),
      fieldConfig: {},
      importMappings: isTermOfReference ? structuredClone(DEFAULT_TR_IMPORT_MAPPINGS) : null,
    };
    const violations = validateTemplateContent(
      content,
      {
        documentType: { kind: spec.kind, systemModule: spec.systemModule },
        importSources: isTermOfReference
          ? { sectionKeys: etpSectionKeys, fieldKeys: TYPED_HEADER_FIELDS.ETP }
          : null,
      },
      FULL_VALIDATION,
    );
    if (violations.length > 0) {
      throw new TemplateLibraryInvalidError(
        entry.documentTypeCode,
        violations.map((v) => (v.sectionKey ? `${v.code} (${v.sectionKey})` : v.code)),
        violations,
      );
    }
    return {
      documentTypeCode: entry.documentTypeCode,
      name: entry.name,
      description: entry.description,
      ...content,
    };
  });
}

export interface SystemTemplateContext {
  readonly templateId: string;
  readonly versionId: string;
  readonly tenantId: string;
  readonly documentTypeId: string;
  readonly now: Date;
}

/**
 * RN-TPL-28/31: template `isSystem = true` com a versão 1 em `DRAFT` carregando o conteúdo da
 * biblioteca; o seeder a publica pela MESMA `publishTemplateVersion` do editor (RN-TPL-34), na
 * mesma transação — o rascunho nunca é visível. Ator `SYSTEM` (`createdById = null`).
 */
export function createSystemTemplate(
  entry: LoadedTemplateLibraryEntry,
  context: SystemTemplateContext,
): { readonly template: DocumentTemplate; readonly draft: DocumentTemplateVersion } {
  const audit = {
    createdAt: context.now,
    updatedAt: context.now,
    createdById: null,
    updatedById: null,
    version: 1,
  };
  return {
    template: {
      id: context.templateId,
      tenantId: context.tenantId,
      documentTypeId: context.documentTypeId,
      name: entry.name,
      description: entry.description,
      isActive: true,
      isSystem: true,
      currentPublishedVersionId: null,
      ...audit,
    },
    draft: {
      id: context.versionId,
      tenantId: context.tenantId,
      templateId: context.templateId,
      versionNumber: 1,
      status: 'DRAFT',
      sections: structuredClone(entry.sections),
      layout: structuredClone(entry.layout),
      fieldConfig: {},
      importMappings: entry.importMappings === null ? null : structuredClone(entry.importMappings),
      changeNotes: null,
      publishedAt: null,
      publishedById: null,
      retiredAt: null,
      retiredById: null,
      contentHash: null,
      ...audit,
    },
  };
}
