// Dataset do seed local (US-078 · RN-FND-18): dois tenants completos para exercitar isolamento
// multi-tenant desde o primeiro dia. Fonte única para o SQL do seed (`sql.ts`) e para o blueprint
// de usuários do Authentik (`blueprint.ts` → infra/authentik/blueprints/20-contrataflow-dev-users.yaml).
// Valores de entities.md §7 (seeds do provisionamento), DEC-035 (perfis) e DEC-015 (workflows).
import { createHash } from 'node:crypto';

/** Namespace fixo dos ids do seed: ids determinísticos tornam o seed idempotente (RN-FND-18). */
const SEED_NAMESPACE = 'contrataflow.dev-seed.v1';

/** UUID determinístico (versão 8, RFC 9562) derivado de SHA-256 do namespace + partes. */
export function seedId(...parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update([SEED_NAMESPACE, ...parts].join('\u001f'))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// Perfis (DEC-035)
// ---------------------------------------------------------------------------------------------

export const PERSONA_KEYS = [
  'ADMIN_ORGAO',
  'GESTOR_CONTRATACOES',
  'REQUISITANTE',
  'PLANEJAMENTO',
  'COMPRAS',
  'LICITACOES',
  'CONTABILIDADE',
  'JURIDICO',
  'CONTROLE_INTERNO',
  'AUTORIDADE_COMPETENTE',
  'FISCAL_CONTRATO',
  'GESTOR_CONTRATO',
  'AUDITOR',
  'SOMENTE_LEITURA',
  'CONSULTOR_EXTERNO',
] as const;

export type PersonaKey = (typeof PERSONA_KEYS)[number];

export interface RoleTemplate {
  readonly key: PersonaKey;
  readonly name: string;
  /** `ADMIN_ORGAO`: permissões de administração não removíveis (DEC-035). */
  readonly isProtected: boolean;
  /** POL-15: atribuível a vínculos EXTERNAL. */
  readonly allowExternalAssignment: boolean;
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'ADMIN_ORGAO', name: 'Administrador do órgão' },
  { key: 'GESTOR_CONTRATACOES', name: 'Gestor de contratações' },
  { key: 'REQUISITANTE', name: 'Área requisitante' },
  { key: 'PLANEJAMENTO', name: 'Planejamento' },
  { key: 'COMPRAS', name: 'Compras' },
  { key: 'LICITACOES', name: 'Licitações' },
  { key: 'CONTABILIDADE', name: 'Contabilidade' },
  { key: 'JURIDICO', name: 'Jurídico / Procuradoria' },
  { key: 'CONTROLE_INTERNO', name: 'Controle Interno' },
  { key: 'AUTORIDADE_COMPETENTE', name: 'Autoridade competente' },
  { key: 'FISCAL_CONTRATO', name: 'Fiscal de contrato' },
  { key: 'GESTOR_CONTRATO', name: 'Gestor de contrato' },
  { key: 'AUDITOR', name: 'Auditor' },
  { key: 'SOMENTE_LEITURA', name: 'Usuário somente leitura' },
  { key: 'CONSULTOR_EXTERNO', name: 'Consultoria externa' },
].map(({ key, name }) => ({
  key: key as PersonaKey,
  name,
  isProtected: key === 'ADMIN_ORGAO',
  allowExternalAssignment: key === 'AUDITOR' || key === 'CONSULTOR_EXTERNO',
}));

/** Parte do login: `REQUISITANTE` → `requisitante`, `ADMIN_ORGAO` → `admin-orgao`. */
export function personaSlug(key: PersonaKey): string {
  return key.toLowerCase().replaceAll('_', '-');
}

// ---------------------------------------------------------------------------------------------
// Estrutura organizacional (entities.md §7: "Gabinete", "Secretaria de Administração" → "Setor
// de Compras", mais as unidades usadas pelas personas)
// ---------------------------------------------------------------------------------------------

export type DepartmentKey = 'GAB' | 'SEAD' | 'COMPRAS' | 'CONTAB' | 'SESAU' | 'PGM' | 'CGM';

export interface DepartmentSeed {
  readonly key: DepartmentKey;
  readonly name: string;
  readonly acronym: string;
  readonly type: 'SECRETARIAT' | 'BOARD' | 'DEPARTMENT' | 'SECTOR';
  readonly parent?: DepartmentKey;
}

export const DEPARTMENTS: readonly DepartmentSeed[] = [
  { key: 'GAB', name: 'Gabinete do Prefeito', acronym: 'GAB', type: 'SECRETARIAT' },
  { key: 'SEAD', name: 'Secretaria de Administração', acronym: 'SEAD', type: 'SECRETARIAT' },
  { key: 'COMPRAS', name: 'Setor de Compras', acronym: 'SCOMP', type: 'SECTOR', parent: 'SEAD' },
  {
    key: 'CONTAB',
    name: 'Departamento de Contabilidade',
    acronym: 'DCONT',
    type: 'DEPARTMENT',
    parent: 'SEAD',
  },
  { key: 'SESAU', name: 'Secretaria de Saúde', acronym: 'SESAU', type: 'SECRETARIAT' },
  { key: 'PGM', name: 'Procuradoria-Geral do Município', acronym: 'PGM', type: 'BOARD' },
  { key: 'CGM', name: 'Controladoria-Geral do Município', acronym: 'CGM', type: 'BOARD' },
];

/** Lotação principal de cada persona. */
export const PERSONA_DEPARTMENT: Readonly<Record<PersonaKey, DepartmentKey>> = {
  ADMIN_ORGAO: 'SEAD',
  GESTOR_CONTRATACOES: 'SEAD',
  REQUISITANTE: 'SESAU',
  PLANEJAMENTO: 'SEAD',
  COMPRAS: 'COMPRAS',
  LICITACOES: 'COMPRAS',
  CONTABILIDADE: 'CONTAB',
  JURIDICO: 'PGM',
  CONTROLE_INTERNO: 'CGM',
  AUTORIDADE_COMPETENTE: 'GAB',
  FISCAL_CONTRATO: 'SESAU',
  GESTOR_CONTRATO: 'SESAU',
  AUDITOR: 'CGM',
  SOMENTE_LEITURA: 'SEAD',
  CONSULTOR_EXTERNO: 'COMPRAS',
};

/**
 * Escopo da atribuição de perfil (DEC-134): o requisitante enxerga as próprias unidades e o chefe
 * do Executivo decide pela organização inteira (DEC-015 — autoridade); os demais, o tenant.
 */
export function personaScope(key: PersonaKey): 'TENANT' | 'ORGANIZATION' | 'OWN_DEPARTMENTS' {
  if (key === 'REQUISITANTE') return 'OWN_DEPARTMENTS';
  if (key === 'AUTORIDADE_COMPETENTE') return 'ORGANIZATION';
  return 'TENANT';
}

// ---------------------------------------------------------------------------------------------
// Tenants e usuários (um por persona em cada tenant)
// ---------------------------------------------------------------------------------------------

export interface TenantSeed {
  /** Sufixo do login (`requisitante.a`). */
  readonly code: 'a' | 'b';
  readonly slug: string;
  readonly name: string;
  readonly legalName: string;
  readonly stateCode: string;
  readonly organization: {
    readonly name: string;
    readonly shortName: string;
    /** CNPJ fictício com dígitos verificadores válidos. */
    readonly cnpj: string;
    readonly email: string;
  };
  /** Nome civil da pessoa de cada persona. */
  readonly people: Readonly<Record<PersonaKey, string>>;
}

export const TENANTS: readonly TenantSeed[] = [
  {
    code: 'a',
    slug: 'prefeitura-a',
    name: 'Prefeitura A',
    legalName: 'Município de Alfa (dados fictícios de desenvolvimento)',
    stateCode: 'SP',
    organization: {
      name: 'Prefeitura Municipal de Alfa',
      shortName: 'PMA',
      cnpj: '11222333000181',
      email: 'contato@prefeitura-a.test',
    },
    people: {
      ADMIN_ORGAO: 'Carla Mendes',
      GESTOR_CONTRATACOES: 'Gustavo Lima',
      REQUISITANTE: 'Ana Ribeiro',
      PLANEJAMENTO: 'Paulo Teixeira',
      COMPRAS: 'Fábio Moreira',
      LICITACOES: 'Larissa Campos',
      CONTABILIDADE: 'Cláudio Nunes',
      JURIDICO: 'Juliana Prado',
      CONTROLE_INTERNO: 'Ingrid Costa',
      AUTORIDADE_COMPETENTE: 'Roberto Azevedo',
      FISCAL_CONTRATO: 'Felipe Rocha',
      GESTOR_CONTRATO: 'Gabriela Souza',
      AUDITOR: 'Augusto Dias',
      SOMENTE_LEITURA: 'Sérgio Leite',
      CONSULTOR_EXTERNO: 'Eduarda Farias',
    },
  },
  {
    code: 'b',
    slug: 'prefeitura-b',
    name: 'Prefeitura B',
    legalName: 'Município de Beta (dados fictícios de desenvolvimento)',
    stateCode: 'MG',
    organization: {
      name: 'Prefeitura Municipal de Beta',
      shortName: 'PMB',
      cnpj: '44555666000181',
      email: 'contato@prefeitura-b.test',
    },
    people: {
      ADMIN_ORGAO: 'Beatriz Alves',
      GESTOR_CONTRATACOES: 'Henrique Barros',
      REQUISITANTE: 'Bruno Carvalho',
      PLANEJAMENTO: 'Patrícia Gomes',
      COMPRAS: 'Marcos Pinto',
      LICITACOES: 'Lúcia Martins',
      CONTABILIDADE: 'Vitor Cardoso',
      JURIDICO: 'Renata Freitas',
      CONTROLE_INTERNO: 'Otávio Ramos',
      AUTORIDADE_COMPETENTE: 'Helena Duarte',
      FISCAL_CONTRATO: 'Igor Monteiro',
      GESTOR_CONTRATO: 'Mariana Lopes',
      AUDITOR: 'Tiago Correia',
      SOMENTE_LEITURA: 'Sofia Batista',
      CONSULTOR_EXTERNO: 'Daniel Vieira',
    },
  },
];

export interface SeedUser {
  readonly id: string;
  /** Login no Authentik: `<perfil>.<a|b>` (ex.: `requisitante.a`). */
  readonly username: string;
  readonly email: string;
  readonly name: string;
  readonly persona: PersonaKey;
  readonly tenant: TenantSeed;
}

export function seedUsers(): SeedUser[] {
  return TENANTS.flatMap((tenant) =>
    PERSONA_KEYS.map((persona) => {
      const username = `${personaSlug(persona)}.${tenant.code}`;
      return {
        id: seedId('user', username),
        username,
        email: `${username}@${tenant.slug}.test`,
        name: tenant.people[persona],
        persona,
        tenant,
      };
    }),
  );
}

/** Configurações do tenant semeadas fora do padrão (entities.md §6). */
export const TENANT_SETTINGS: Readonly<Record<string, unknown>> = {
  // Story US-078 — Permissões: MFA desligado nos tenants semeados para agilizar o desenvolvimento.
  'security.mfaPolicy': 'NONE',
};

// ---------------------------------------------------------------------------------------------
// Catálogos (entities.md §7)
// ---------------------------------------------------------------------------------------------

export type CatalogType =
  | 'CONTRACTING_TYPE'
  | 'MODALITY'
  | 'PROCESS_ORIGIN'
  | 'UNIT_OF_MEASURE'
  | 'RISK_CATEGORY'
  | 'PRICE_SOURCE_TYPE'
  | 'JUDGMENT_CRITERION'
  | 'ATTACHMENT_CATEGORY';

export const CATALOGS: Readonly<Record<CatalogType, readonly (readonly [string, string])[]>> = {
  CONTRACTING_TYPE: [
    ['AQUISICAO_BENS', 'Aquisição de bens'],
    ['SERVICO_COMUM', 'Serviço comum'],
    ['SERVICO_ESPECIAL', 'Serviço especial'],
    ['SERVICO_CONTINUO_SEM_DEDICACAO', 'Serviço contínuo sem dedicação exclusiva de mão de obra'],
    ['SERVICO_CONTINUO_COM_DEDICACAO', 'Serviço contínuo com dedicação exclusiva de mão de obra'],
    ['SERVICO_ENGENHARIA_COMUM', 'Serviço comum de engenharia'],
    ['SERVICO_ENGENHARIA_ESPECIAL', 'Serviço especial de engenharia'],
    ['OBRA', 'Obra'],
    ['LOCACAO_IMOVEL', 'Locação de imóvel'],
    ['SOLUCAO_TIC', 'Solução de TIC'],
    ['OUTRO', 'Outro'],
  ],
  MODALITY: [
    ['PREGAO', 'Pregão'],
    ['CONCORRENCIA', 'Concorrência'],
    ['CONCURSO', 'Concurso'],
    ['LEILAO', 'Leilão'],
    ['DIALOGO_COMPETITIVO', 'Diálogo competitivo'],
    ['DISPENSA', 'Dispensa de licitação'],
    ['INEXIGIBILIDADE', 'Inexigibilidade de licitação'],
  ],
  PROCESS_ORIGIN: [
    ['PCA', 'Plano de Contratações Anual'],
    ['DEMANDA_NAO_PREVISTA', 'Demanda não prevista no PCA'],
    ['RENOVACAO_CONTRATO', 'Renovação de contrato'],
    ['EMERGENCIAL', 'Emergencial'],
    ['DETERMINACAO_LEGAL_JUDICIAL', 'Determinação legal ou judicial'],
    ['OUTRA', 'Outra'],
  ],
  UNIT_OF_MEASURE: [
    ['UN', 'Unidade'],
    ['CX', 'Caixa'],
    ['PCT', 'Pacote'],
    ['KIT', 'Kit'],
    ['PAR', 'Par'],
    ['RESMA', 'Resma'],
    ['ROLO', 'Rolo'],
    ['FRASCO', 'Frasco'],
    ['AMPOLA', 'Ampola'],
    ['COMPRIMIDO', 'Comprimido'],
    ['KG', 'Quilograma'],
    ['G', 'Grama'],
    ['T', 'Tonelada'],
    ['L', 'Litro'],
    ['ML', 'Mililitro'],
    ['M', 'Metro'],
    ['M2', 'Metro quadrado'],
    ['M3', 'Metro cúbico'],
    ['KM', 'Quilômetro'],
    ['HORA', 'Hora'],
    ['DIA', 'Dia'],
    ['DIARIA', 'Diária'],
    ['MES', 'Mês'],
    ['ANO', 'Ano'],
    ['SERVICO', 'Serviço'],
    ['GLOBAL', 'Global'],
  ],
  RISK_CATEGORY: [
    ['PLANEJAMENTO', 'Planejamento'],
    ['ORCAMENTARIO_FINANCEIRO', 'Orçamentário e financeiro'],
    ['MERCADO_FORNECEDOR', 'Mercado e fornecedor'],
    ['TECNICO_OPERACIONAL', 'Técnico e operacional'],
    ['LEGAL_CONFORMIDADE', 'Legal e de conformidade'],
    ['PRAZO', 'Prazo'],
    ['AMBIENTAL', 'Ambiental'],
    ['REPUTACIONAL', 'Reputacional'],
    ['SEGURANCA_INFORMACAO', 'Segurança da informação'],
    ['OUTRO', 'Outro'],
  ],
  PRICE_SOURCE_TYPE: [
    ['PAINEL_PRECOS_PNCP', 'Painel de Preços / PNCP (art. 23, § 1º, I)'],
    ['CONTRATACAO_SIMILAR', 'Contratação similar (art. 23, § 1º, II)'],
    ['MIDIA_ESPECIALIZADA', 'Mídia especializada (art. 23, § 1º, III)'],
    ['SITIO_ELETRONICO', 'Sítio eletrônico especializado (art. 23, § 1º, III)'],
    ['TABELA_REFERENCIA', 'Tabela de referência (art. 23, § 1º, III)'],
    ['PESQUISA_DIRETA_FORNECEDOR', 'Pesquisa direta com fornecedor (art. 23, § 1º, IV)'],
    ['NOTA_FISCAL_ELETRONICA', 'Nota fiscal eletrônica (art. 23, § 1º, V)'],
    ['OUTRA', 'Outra'],
  ],
  JUDGMENT_CRITERION: [
    ['MENOR_PRECO', 'Menor preço'],
    ['MAIOR_DESCONTO', 'Maior desconto'],
    ['MELHOR_TECNICA_CONTEUDO_ARTISTICO', 'Melhor técnica ou conteúdo artístico'],
    ['TECNICA_E_PRECO', 'Técnica e preço'],
    ['MAIOR_LANCE', 'Maior lance'],
    ['MAIOR_RETORNO_ECONOMICO', 'Maior retorno econômico'],
  ],
  ATTACHMENT_CATEGORY: [
    ['ORCAMENTO', 'Orçamento'],
    ['PROPOSTA', 'Proposta'],
    ['NOTA_TECNICA', 'Nota técnica'],
    ['PARECER', 'Parecer'],
    ['OFICIO', 'Ofício'],
    ['PLANILHA', 'Planilha'],
    ['FOTO', 'Foto'],
    ['PROJETO', 'Projeto'],
    ['CERTIDAO', 'Certidão'],
    ['OUTRO', 'Outro'],
  ],
};

// ---------------------------------------------------------------------------------------------
// Workflows publicados (DEC-015 · RN-WF-34..38). Definição de demonstração: a carga real, com
// regras completas e instruções, é do seeder `workflow.seedWorkflows` (US-042).
// ---------------------------------------------------------------------------------------------

export interface WorkflowStageSeed {
  readonly key: string;
  readonly name: string;
  readonly type: 'START' | 'TASK' | 'APPROVAL' | 'END';
  readonly departmentResolution:
    'FIXED' | 'REQUESTING_DEPARTMENT' | 'REQUESTING_SECRETARIAT' | 'CHOSEN_ON_FORWARD';
  readonly approverType?: 'ROLE' | 'DEPARTMENT_HEAD';
  readonly approverRoleKey?: PersonaKey;
  readonly approvalDocumentTypeCodes?: readonly string[];
  /** Dias úteis (RN-WF-37). */
  readonly slaDays?: number;
}

export interface WorkflowRuleSeed {
  readonly stage: string;
  readonly type: 'REQUIRED_DOCUMENT' | 'REQUIRED_FIELD' | 'REQUIRED_APPROVAL' | 'CONDITION';
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly message: string;
}

export interface WorkflowSeed {
  readonly key: 'DEFAULT_PREPARATORY' | 'DIRECT_CONTRACTING_ART72';
  readonly name: string;
  readonly isDefault: boolean;
  readonly applicabilityPriority: number;
  readonly applicabilityRule: Readonly<Record<string, unknown>> | null;
  readonly stages: readonly WorkflowStageSeed[];
  readonly rules: readonly WorkflowRuleSeed[];
}

export const WORKFLOWS: readonly WorkflowSeed[] = [
  {
    key: 'DEFAULT_PREPARATORY',
    name: 'Fase preparatória — Lei 14.133/2021',
    isDefault: true,
    applicabilityPriority: 100,
    applicabilityRule: null,
    stages: [
      {
        key: 'ABERTURA',
        name: 'Formalização da demanda',
        type: 'START',
        departmentResolution: 'REQUESTING_DEPARTMENT',
        slaDays: 5,
      },
      {
        key: 'APROVACAO_DFD',
        name: 'Aprovação da demanda',
        type: 'APPROVAL',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'DEPARTMENT_HEAD',
        approvalDocumentTypeCodes: ['DFD'],
        slaDays: 3,
      },
      {
        key: 'ESTUDOS_PRELIMINARES',
        name: 'ETP e mapa de riscos',
        type: 'TASK',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 15,
      },
      {
        key: 'PESQUISA_PRECOS',
        name: 'Pesquisa de preços',
        type: 'TASK',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 10,
      },
      {
        key: 'TERMO_REFERENCIA',
        name: 'Termo de Referência',
        type: 'TASK',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 10,
      },
      {
        key: 'APROVACAO_AUTORIDADE',
        name: 'Aprovação da autoridade competente',
        type: 'APPROVAL',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'ROLE',
        approverRoleKey: 'AUTORIDADE_COMPETENTE',
        approvalDocumentTypeCodes: ['ETP', 'RISK_MAP', 'PRICE_RESEARCH', 'TR'],
        slaDays: 5,
      },
      {
        key: 'CONCLUSAO',
        name: 'Planejamento da contratação concluído',
        type: 'END',
        departmentResolution: 'REQUESTING_DEPARTMENT',
      },
    ],
    rules: [
      {
        stage: 'ABERTURA',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua o DFD antes de encaminhar.',
      },
      {
        stage: 'ESTUDOS_PRELIMINARES',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua o ETP antes de encaminhar.',
      },
      {
        stage: 'ESTUDOS_PRELIMINARES',
        type: 'REQUIRED_DOCUMENT',
        severity: 'WARNING',
        message: 'O processo ainda não tem mapa de riscos.',
      },
      {
        stage: 'PESQUISA_PRECOS',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua a pesquisa de preços antes de encaminhar.',
      },
      {
        stage: 'TERMO_REFERENCIA',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua o Termo de Referência antes de encaminhar.',
      },
    ],
  },
  {
    key: 'DIRECT_CONTRACTING_ART72',
    name: 'Contratação direta — Lei 14.133/2021, art. 72',
    isDefault: false,
    applicabilityPriority: 50,
    applicabilityRule: { in: [{ var: 'process.modalityCode' }, ['DISPENSA', 'INEXIGIBILIDADE']] },
    stages: [
      {
        key: 'ABERTURA',
        name: 'Formalização da demanda',
        type: 'START',
        departmentResolution: 'REQUESTING_DEPARTMENT',
        slaDays: 5,
      },
      {
        key: 'APROVACAO_DFD',
        name: 'Aprovação da demanda',
        type: 'APPROVAL',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'DEPARTMENT_HEAD',
        approvalDocumentTypeCodes: ['DFD'],
        slaDays: 3,
      },
      {
        key: 'INSTRUCAO',
        name: 'Instrução da contratação direta',
        type: 'TASK',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 15,
      },
      {
        key: 'AUTORIZACAO',
        name: 'Autorização da autoridade competente',
        type: 'APPROVAL',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'ROLE',
        approverRoleKey: 'AUTORIDADE_COMPETENTE',
        approvalDocumentTypeCodes: ['ETP', 'TR', 'PRICE_RESEARCH', 'NOTA_TECNICA'],
        slaDays: 5,
      },
      {
        key: 'CONCLUSAO',
        name: 'Contratação direta autorizada',
        type: 'END',
        departmentResolution: 'REQUESTING_DEPARTMENT',
      },
    ],
    rules: [
      {
        stage: 'ABERTURA',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua o DFD antes de encaminhar.',
      },
      {
        stage: 'INSTRUCAO',
        type: 'REQUIRED_DOCUMENT',
        severity: 'WARNING',
        message: 'Anexe o TR ou o ETP, se for o caso (art. 72, I).',
      },
      {
        stage: 'INSTRUCAO',
        type: 'REQUIRED_DOCUMENT',
        severity: 'BLOCKING',
        message: 'Conclua a pesquisa de preços (art. 72, II).',
      },
    ],
  },
];

/** Transições padrão: encaminhar em sequência, aprovar nas etapas de aprovação, devolver para trás. */
export function workflowTransitions(workflow: WorkflowSeed): {
  key: string;
  from: string;
  to: string;
  action: 'FORWARD' | 'APPROVE' | 'RETURN' | 'COMPLETE';
  isPrimary: boolean;
}[] {
  const transitions: ReturnType<typeof workflowTransitions> = [];
  workflow.stages.forEach((stage, index) => {
    const next = workflow.stages[index + 1];
    if (next) {
      const action =
        stage.type === 'APPROVAL' ? 'APPROVE' : next.type === 'END' ? 'COMPLETE' : 'FORWARD';
      transitions.push({
        key: `${stage.key}__${action}__${next.key}`,
        from: stage.key,
        to: next.key,
        action,
        isPrimary: true,
      });
    }
    if (stage.type !== 'START' && stage.type !== 'END') {
      for (const previous of workflow.stages.slice(0, index)) {
        transitions.push({
          key: `${stage.key}__RETURN__${previous.key}`,
          from: stage.key,
          to: previous.key,
          action: 'RETURN',
          isPrimary: false,
        });
      }
    }
  });
  return transitions;
}
