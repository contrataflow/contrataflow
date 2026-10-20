import type { CatalogType, ItemKind } from '@contrataflow/types';
import type { PriceSourceRequiredField } from '@contrataflow/validation';

/*
 * Catálogo-base da plataforma (entities.md §7 · US-104 · seeder `catalog.items`): os 84 itens de
 * sistema copiados para cada tenant no provisionamento. O `code` é a chave estável usada em regras
 * e integrações; rótulos e `metadata` (entities.md §5.9) podem ser editados pelo administrador.
 * `metadata` precisa passar no schema do tipo — conferido em `catalog-seed.spec.ts`.
 */

export interface CatalogSeedItem {
  readonly code: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const LAW = 'Lei 14.133/2021';

const ALL_KINDS: readonly ItemKind[] = ['GOOD', 'SERVICE', 'ENGINEERING_SERVICE', 'WORK'];

const contractingType = (
  code: string,
  label: string,
  itemKinds: readonly ItemKind[],
  isContinuous?: boolean,
): CatalogSeedItem => ({
  code,
  label,
  metadata: { itemKinds, ...(isContinuous === undefined ? {} : { isContinuous }) },
});

const modality = (
  code: string,
  label: string,
  article: string,
  isDirectContracting: boolean,
): CatalogSeedItem => ({
  code,
  label,
  metadata: { legalBasis: `${LAW}, ${article}`, isDirectContracting },
});

const plain = (code: string, label: string): CatalogSeedItem => ({ code, label, metadata: {} });

const unit = (
  code: string,
  label: string,
  abbreviation: string,
  allowsDecimal: boolean,
): CatalogSeedItem => ({ code, label, metadata: { abbreviation, allowsDecimal } });

const priceSource = (
  code: string,
  label: string,
  inciso: string,
  requiredFields: readonly PriceSourceRequiredField[],
  maxAgeDays?: number,
): CatalogSeedItem => ({
  code,
  label,
  metadata: {
    legalBasis: `${LAW}, art. 23, § 1º, ${inciso}`,
    requiredFields,
    ...(maxAgeDays === undefined ? {} : { maxAgeDays, ageReference: 'quoteDate' }),
  },
});

const criterion = (code: string, label: string, inciso: string): CatalogSeedItem => ({
  code,
  label,
  metadata: { legalBasis: `${LAW}, art. 33, ${inciso}` },
});

export const CATALOG_SEED: Readonly<Record<CatalogType, readonly CatalogSeedItem[]>> = {
  CONTRACTING_TYPE: [
    contractingType('AQUISICAO_BENS', 'Aquisição de bens', ['GOOD']),
    contractingType('SERVICO_COMUM', 'Serviço comum', ['SERVICE']),
    contractingType('SERVICO_ESPECIAL', 'Serviço especial', ['SERVICE']),
    contractingType(
      'SERVICO_CONTINUO_SEM_DEDICACAO',
      'Serviço contínuo sem dedicação exclusiva de mão de obra',
      ['SERVICE'],
      true,
    ),
    contractingType(
      'SERVICO_CONTINUO_COM_DEDICACAO',
      'Serviço contínuo com dedicação exclusiva de mão de obra',
      ['SERVICE'],
      true,
    ),
    contractingType('SERVICO_ENGENHARIA_COMUM', 'Serviço comum de engenharia', [
      'ENGINEERING_SERVICE',
    ]),
    contractingType('SERVICO_ENGENHARIA_ESPECIAL', 'Serviço especial de engenharia', [
      'ENGINEERING_SERVICE',
    ]),
    contractingType('OBRA', 'Obra', ['WORK']),
    contractingType('LOCACAO_IMOVEL', 'Locação de imóvel', ['SERVICE']),
    contractingType('SOLUCAO_TIC', 'Solução de TIC', ['GOOD', 'SERVICE']),
    contractingType('OUTRO', 'Outro', ALL_KINDS),
  ],
  MODALITY: [
    modality('PREGAO', 'Pregão', 'art. 28, I', false),
    modality('CONCORRENCIA', 'Concorrência', 'art. 28, II', false),
    modality('CONCURSO', 'Concurso', 'art. 28, III', false),
    modality('LEILAO', 'Leilão', 'art. 28, IV', false),
    modality('DIALOGO_COMPETITIVO', 'Diálogo competitivo', 'art. 28, V', false),
    modality('DISPENSA', 'Dispensa de licitação', 'art. 75', true),
    modality('INEXIGIBILIDADE', 'Inexigibilidade de licitação', 'art. 74', true),
  ],
  PROCESS_ORIGIN: [
    {
      code: 'PCA',
      label: 'Plano de Contratações Anual',
      metadata: { requiresPcaStatus: 'PLANNED' },
    },
    {
      code: 'DEMANDA_NAO_PREVISTA',
      label: 'Demanda não prevista no PCA',
      metadata: { requiresPcaStatus: 'NOT_PLANNED' },
    },
    plain('RENOVACAO_CONTRATO', 'Renovação de contrato'),
    plain('EMERGENCIAL', 'Emergencial'),
    plain('DETERMINACAO_LEGAL_JUDICIAL', 'Determinação legal ou judicial'),
    plain('OUTRA', 'Outra'),
  ],
  UNIT_OF_MEASURE: [
    unit('UN', 'Unidade', 'un', false),
    unit('CX', 'Caixa', 'cx', false),
    unit('PCT', 'Pacote', 'pct', false),
    unit('KIT', 'Kit', 'kit', false),
    unit('PAR', 'Par', 'par', false),
    unit('RESMA', 'Resma', 'resma', false),
    unit('ROLO', 'Rolo', 'rolo', false),
    unit('FRASCO', 'Frasco', 'frasco', false),
    unit('AMPOLA', 'Ampola', 'amp', false),
    unit('COMPRIMIDO', 'Comprimido', 'comp', false),
    unit('KG', 'Quilograma', 'kg', true),
    unit('G', 'Grama', 'g', true),
    unit('T', 'Tonelada', 't', true),
    unit('L', 'Litro', 'l', true),
    unit('ML', 'Mililitro', 'ml', true),
    unit('M', 'Metro', 'm', true),
    unit('M2', 'Metro quadrado', 'm²', true),
    unit('M3', 'Metro cúbico', 'm³', true),
    unit('KM', 'Quilômetro', 'km', true),
    unit('HORA', 'Hora', 'h', true),
    unit('DIA', 'Dia', 'dia', false),
    unit('DIARIA', 'Diária', 'diária', false),
    unit('MES', 'Mês', 'mês', false),
    unit('ANO', 'Ano', 'ano', false),
    unit('SERVICO', 'Serviço', 'serv', false),
    unit('GLOBAL', 'Global', 'gl', false),
  ],
  RISK_CATEGORY: [
    plain('PLANEJAMENTO', 'Planejamento'),
    plain('ORCAMENTARIO_FINANCEIRO', 'Orçamentário e financeiro'),
    plain('MERCADO_FORNECEDOR', 'Mercado e fornecedor'),
    plain('TECNICO_OPERACIONAL', 'Técnico e operacional'),
    plain('LEGAL_CONFORMIDADE', 'Legal e de conformidade'),
    plain('PRAZO', 'Prazo'),
    plain('AMBIENTAL', 'Ambiental'),
    plain('REPUTACIONAL', 'Reputacional'),
    plain('SEGURANCA_INFORMACAO', 'Segurança da informação'),
    plain('OUTRO', 'Outro'),
  ],
  PRICE_SOURCE_TYPE: [
    priceSource('PAINEL_PRECOS_PNCP', 'Painel de Preços / PNCP (art. 23, § 1º, I)', 'I', [
      'accessedAt',
    ]),
    priceSource(
      'CONTRATACAO_SIMILAR',
      'Contratação similar (art. 23, § 1º, II)',
      'II',
      ['referenceOrganization', 'referenceDocument', 'quoteDate'],
      365,
    ),
    priceSource('MIDIA_ESPECIALIZADA', 'Mídia especializada (art. 23, § 1º, III)', 'III', [
      'url',
      'accessedAt',
    ]),
    priceSource('SITIO_ELETRONICO', 'Sítio eletrônico especializado (art. 23, § 1º, III)', 'III', [
      'url',
      'accessedAt',
    ]),
    priceSource('TABELA_REFERENCIA', 'Tabela de referência (art. 23, § 1º, III)', 'III', [
      'referenceDocument',
    ]),
    priceSource(
      'PESQUISA_DIRETA_FORNECEDOR',
      'Pesquisa direta com fornecedor (art. 23, § 1º, IV)',
      'IV',
      ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'],
      180,
    ),
    priceSource('NOTA_FISCAL_ELETRONICA', 'Nota fiscal eletrônica (art. 23, § 1º, V)', 'V', [
      'referenceDocument',
      'quoteDate',
    ]),
    {
      code: 'OUTRA',
      label: 'Outra',
      metadata: { legalBasis: `${LAW}, art. 23, § 1º`, requiredFields: [] },
    },
  ],
  JUDGMENT_CRITERION: [
    criterion('MENOR_PRECO', 'Menor preço', 'I'),
    criterion('MAIOR_DESCONTO', 'Maior desconto', 'II'),
    criterion('MELHOR_TECNICA_CONTEUDO_ARTISTICO', 'Melhor técnica ou conteúdo artístico', 'III'),
    criterion('TECNICA_E_PRECO', 'Técnica e preço', 'IV'),
    criterion('MAIOR_LANCE', 'Maior lance', 'V'),
    criterion('MAIOR_RETORNO_ECONOMICO', 'Maior retorno econômico', 'VI'),
  ],
  ATTACHMENT_CATEGORY: [
    plain('ORCAMENTO', 'Orçamento'),
    plain('PROPOSTA', 'Proposta'),
    plain('NOTA_TECNICA', 'Nota técnica'),
    plain('PARECER', 'Parecer'),
    plain('OFICIO', 'Ofício'),
    plain('PLANILHA', 'Planilha'),
    plain('FOTO', 'Foto'),
    plain('PROJETO', 'Projeto'),
    plain('CERTIDAO', 'Certidão'),
    plain('OUTRO', 'Outro'),
  ],
};

/** Total de itens de sistema do catálogo-base (entities.md §7). */
export const CATALOG_SEED_TOTAL = Object.values(CATALOG_SEED).reduce(
  (sum, items) => sum + items.length,
  0,
);
