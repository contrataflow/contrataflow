import type {
  RuleSeverity,
  RuleType,
  StageAssignmentPolicy,
  StageDepartmentResolution,
  StageType,
  TransitionAction,
} from '@contrataflow/validation';

import type {
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
} from './workflow-definition.js';

/*
 * Workflows semeados no provisionamento (US-042 · DEC-015 · entities.md §7): "Fase preparatória —
 * Lei 14.133/2021" (padrão, 7 etapas) e "Contratação direta — Lei 14.133/2021, art. 72" (aplicável
 * a DISPENSA/INEXIGIBILIDADE, 5 etapas). Conteúdo de configuração, não código de regra (DEC-016):
 * etapas, transições, SLAs sugeridos (dias úteis) e regras de saída. `PESQUISA_PRECOS` nasce com
 * `CHOSEN_ON_FORWARD` até o administrador configurar a unidade de Compras (o tenant novo não tem
 * unidades). Mudou o conteúdo → nova `DEFAULT_WORKFLOWS_VERSION` (o seeder nunca sobrescreve o que
 * já existe — RN-WF-34).
 */

export const DEFAULT_WORKFLOWS_VERSION = '2026.10.1';

/** Chaves estáveis dos workflows semeados (RN-WF-34 · DEC-001). */
export const DEFAULT_PREPARATORY_KEY = 'DEFAULT_PREPARATORY';
export const DIRECT_CONTRACTING_KEY = 'DIRECT_CONTRACTING_ART72';

/** Perfil aprovador das etapas da autoridade competente (DEC-015 · DEC-022). */
export const AUTHORITY_ROLE_KEY = 'AUTORIDADE_COMPETENTE';

/** Modalidades do rito de contratação direta (catálogo `MODALITY` — US-104). */
export const DIRECT_CONTRACTING_MODALITIES = ['DISPENSA', 'INEXIGIBILIDADE'] as const;

type Approver =
  | { readonly type: 'DEPARTMENT_HEAD'; readonly departmentResolution: 'REQUESTING_SECRETARIAT' }
  | { readonly type: 'ROLE'; readonly roleKey: string };

interface SeedStage {
  readonly key: string;
  readonly name: string;
  readonly type: StageType;
  readonly instructions: string;
  readonly departmentResolution: StageDepartmentResolution;
  readonly assignmentPolicy: StageAssignmentPolicy;
  readonly approver: Approver | null;
  readonly approvalDocumentTypeCodes: readonly string[];
  readonly documentTypeCodes: readonly string[];
  readonly slaDays: number | null;
}

interface SeedTransition {
  readonly key: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly action: TransitionAction;
  readonly isPrimary: boolean;
}

interface SeedRule {
  readonly stage: string;
  readonly type: RuleType;
  readonly name: string;
  readonly severity: RuleSeverity;
  readonly config: Readonly<Record<string, unknown>>;
  readonly message: string;
}

export interface SeedWorkflow {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly applicabilityPriority: number;
  readonly applicabilityRule: Readonly<Record<string, unknown>> | null;
  readonly stages: readonly SeedStage[];
  readonly transitions: readonly SeedTransition[];
  readonly rules: readonly SeedRule[];
}

const task = (
  key: string,
  name: string,
  slaDays: number,
  documentTypeCodes: readonly string[],
  instructions: string,
): SeedStage => ({
  key,
  name,
  type: 'TASK',
  instructions,
  departmentResolution: 'CHOSEN_ON_FORWARD',
  assignmentPolicy: 'UNASSIGNED',
  approver: null,
  approvalDocumentTypeCodes: [],
  documentTypeCodes,
  slaDays,
});

const ABERTURA: SeedStage = {
  key: 'ABERTURA',
  name: 'Formalização da demanda',
  type: 'START',
  instructions:
    'Preencha o **Documento de Formalização da Demanda (DFD)** com a necessidade, a justificativa e a estimativa preliminar (Lei 14.133/2021, art. 12, VII). Encaminhe para aprovação quando o DFD estiver completo.',
  departmentResolution: 'REQUESTING_DEPARTMENT',
  assignmentPolicy: 'CREATOR',
  approver: null,
  approvalDocumentTypeCodes: [],
  documentTypeCodes: ['DFD'],
  slaDays: 5,
};

const APROVACAO_DFD: SeedStage = {
  key: 'APROVACAO_DFD',
  name: 'Aprovação da demanda',
  type: 'APPROVAL',
  instructions:
    'O titular da secretaria solicitante analisa o DFD e decide: aprovar, devolver para ajustes ou indeferir a demanda.',
  departmentResolution: 'REQUESTING_SECRETARIAT',
  assignmentPolicy: 'UNASSIGNED',
  approver: { type: 'DEPARTMENT_HEAD', departmentResolution: 'REQUESTING_SECRETARIAT' },
  approvalDocumentTypeCodes: ['DFD'],
  documentTypeCodes: [],
  slaDays: 3,
};

const CONCLUSAO: SeedStage = {
  key: 'CONCLUSAO',
  name: 'Planejamento da contratação concluído',
  type: 'END',
  instructions:
    'Os artefatos do planejamento (art. 18) foram aprovados pela autoridade competente. O processo segue para a próxima fase fora do sistema.',
  departmentResolution: 'REQUESTING_DEPARTMENT',
  assignmentPolicy: 'UNASSIGNED',
  approver: null,
  approvalDocumentTypeCodes: [],
  documentTypeCodes: [],
  slaDays: null,
};

const authorityApproval = (
  key: string,
  name: string,
  approvalDocumentTypeCodes: readonly string[],
  instructions: string,
): SeedStage => ({
  key,
  name,
  type: 'APPROVAL',
  instructions,
  departmentResolution: 'REQUESTING_SECRETARIAT',
  assignmentPolicy: 'UNASSIGNED',
  approver: { type: 'ROLE', roleKey: AUTHORITY_ROLE_KEY },
  approvalDocumentTypeCodes,
  documentTypeCodes: [],
  slaDays: 5,
});

const edge = (
  key: string,
  name: string,
  from: string,
  to: string,
  action: TransitionAction,
): SeedTransition => ({ key, name, from, to, action, isPrimary: action === 'FORWARD' });

const documentRule = (
  stage: string,
  documentTypeCode: string,
  minStatus: 'EXISTS' | 'COMPLETE',
  severity: RuleSeverity,
  name: string,
  message: string,
): SeedRule => ({
  stage,
  type: 'REQUIRED_DOCUMENT',
  name,
  severity,
  config: { documentTypeCode, minStatus },
  message,
});

const priceResearchCompleted = (stage: string, message: string): SeedRule => ({
  stage,
  type: 'CONDITION',
  name: 'Pesquisa de preços concluída',
  severity: 'BLOCKING',
  config: { expression: { '==': [{ var: 'priceResearch.completed' }, true] } },
  message,
});

const DEFAULT_PREPARATORY: SeedWorkflow = {
  key: DEFAULT_PREPARATORY_KEY,
  name: 'Fase preparatória — Lei 14.133/2021',
  description:
    'Planejamento da contratação (art. 18): DFD, ETP e mapa de riscos, pesquisa de preços, Termo de Referência e aprovação da autoridade competente.',
  isDefault: true,
  applicabilityPriority: 100,
  applicabilityRule: null,
  stages: [
    ABERTURA,
    APROVACAO_DFD,
    task(
      'ESTUDOS_PRELIMINARES',
      'ETP e mapa de riscos',
      15,
      ['ETP', 'RISK_MAP'],
      'Elabore o **Estudo Técnico Preliminar** com os elementos do art. 18, § 1º, e o **mapa de riscos** da contratação.',
    ),
    task(
      'PESQUISA_PRECOS',
      'Pesquisa de preços',
      10,
      ['PRICE_RESEARCH'],
      'Realize a pesquisa de preços pelos parâmetros do art. 23 e conclua-a com a memória de cálculo. Configure a unidade de Compras nesta etapa quando a estrutura do órgão estiver cadastrada.',
    ),
    task(
      'TERMO_REFERENCIA',
      'Termo de Referência',
      10,
      ['TR'],
      'Elabore o **Termo de Referência** com os elementos do art. 6º, XXIII, a partir do ETP e da pesquisa de preços.',
    ),
    authorityApproval(
      'APROVACAO_AUTORIDADE',
      'Aprovação da autoridade competente',
      ['ETP', 'RISK_MAP', 'PRICE_RESEARCH', 'TR'],
      'A autoridade competente analisa ETP, mapa de riscos, pesquisa de preços e TR e decide: aprovar, devolver a uma etapa anterior ou indeferir.',
    ),
    CONCLUSAO,
  ],
  transitions: [
    edge(
      'ENVIAR_APROVACAO_DFD',
      'Enviar para aprovação da demanda',
      'ABERTURA',
      'APROVACAO_DFD',
      'FORWARD',
    ),
    edge('APROVAR_DFD', 'Aprovar a demanda', 'APROVACAO_DFD', 'ESTUDOS_PRELIMINARES', 'APPROVE'),
    edge('DEVOLVER_DFD', 'Devolver para ajustes no DFD', 'APROVACAO_DFD', 'ABERTURA', 'RETURN'),
    edge('INDEFERIR_DFD', 'Indeferir a demanda', 'APROVACAO_DFD', 'ABERTURA', 'REJECT'),
    edge(
      'ENVIAR_PESQUISA',
      'Enviar para pesquisa de preços',
      'ESTUDOS_PRELIMINARES',
      'PESQUISA_PRECOS',
      'FORWARD',
    ),
    edge(
      'DEVOLVER_ESTUDOS_ABERTURA',
      'Devolver à formalização da demanda',
      'ESTUDOS_PRELIMINARES',
      'ABERTURA',
      'RETURN',
    ),
    edge(
      'ENVIAR_TR',
      'Enviar para o Termo de Referência',
      'PESQUISA_PRECOS',
      'TERMO_REFERENCIA',
      'FORWARD',
    ),
    edge(
      'DEVOLVER_PESQUISA_ESTUDOS',
      'Devolver ao ETP e mapa de riscos',
      'PESQUISA_PRECOS',
      'ESTUDOS_PRELIMINARES',
      'RETURN',
    ),
    edge(
      'DEVOLVER_PESQUISA_ABERTURA',
      'Devolver à formalização da demanda',
      'PESQUISA_PRECOS',
      'ABERTURA',
      'RETURN',
    ),
    edge(
      'ENVIAR_AUTORIDADE',
      'Enviar para a autoridade competente',
      'TERMO_REFERENCIA',
      'APROVACAO_AUTORIDADE',
      'FORWARD',
    ),
    edge(
      'DEVOLVER_TR_PESQUISA',
      'Devolver à pesquisa de preços',
      'TERMO_REFERENCIA',
      'PESQUISA_PRECOS',
      'RETURN',
    ),
    edge(
      'DEVOLVER_TR_ESTUDOS',
      'Devolver ao ETP e mapa de riscos',
      'TERMO_REFERENCIA',
      'ESTUDOS_PRELIMINARES',
      'RETURN',
    ),
    edge(
      'DEVOLVER_TR_ABERTURA',
      'Devolver à formalização da demanda',
      'TERMO_REFERENCIA',
      'ABERTURA',
      'RETURN',
    ),
    edge(
      'APROVAR_PLANEJAMENTO',
      'Aprovar o planejamento',
      'APROVACAO_AUTORIDADE',
      'CONCLUSAO',
      'APPROVE',
    ),
    edge(
      'DEVOLVER_AUTORIDADE_TR',
      'Devolver ao Termo de Referência',
      'APROVACAO_AUTORIDADE',
      'TERMO_REFERENCIA',
      'RETURN',
    ),
    edge(
      'DEVOLVER_AUTORIDADE_PESQUISA',
      'Devolver à pesquisa de preços',
      'APROVACAO_AUTORIDADE',
      'PESQUISA_PRECOS',
      'RETURN',
    ),
    edge(
      'DEVOLVER_AUTORIDADE_ESTUDOS',
      'Devolver ao ETP e mapa de riscos',
      'APROVACAO_AUTORIDADE',
      'ESTUDOS_PRELIMINARES',
      'RETURN',
    ),
    edge(
      'DEVOLVER_AUTORIDADE_ABERTURA',
      'Devolver à formalização da demanda',
      'APROVACAO_AUTORIDADE',
      'ABERTURA',
      'RETURN',
    ),
    edge(
      'INDEFERIR_PLANEJAMENTO',
      'Indeferir a contratação',
      'APROVACAO_AUTORIDADE',
      'ABERTURA',
      'REJECT',
    ),
  ],
  rules: [
    documentRule(
      'ABERTURA',
      'DFD',
      'COMPLETE',
      'BLOCKING',
      'DFD completo',
      'O DFD deve estar completo.',
    ),
    documentRule(
      'ESTUDOS_PRELIMINARES',
      'ETP',
      'COMPLETE',
      'BLOCKING',
      'ETP completo',
      'Conclua o ETP antes de seguir para a pesquisa de preços.',
    ),
    documentRule(
      'ESTUDOS_PRELIMINARES',
      'RISK_MAP',
      'EXISTS',
      'WARNING',
      'Mapa de riscos existente',
      'O processo ainda não tem mapa de riscos. Confirme se deseja seguir sem ele.',
    ),
    priceResearchCompleted(
      'PESQUISA_PRECOS',
      'Conclua a pesquisa de preços antes de seguir para o Termo de Referência.',
    ),
    documentRule(
      'TERMO_REFERENCIA',
      'TR',
      'COMPLETE',
      'BLOCKING',
      'TR completo',
      'Conclua o Termo de Referência antes de enviar à autoridade competente.',
    ),
  ],
};

const DIRECT_CONTRACTING: SeedWorkflow = {
  key: DIRECT_CONTRACTING_KEY,
  name: 'Contratação direta — Lei 14.133/2021, art. 72',
  description:
    'Instrução de dispensa (art. 75) e inexigibilidade (art. 74) conforme o art. 72: DFD, instrução com ETP/TR quando cabíveis, pesquisa de preços e justificativas, e autorização da autoridade competente.',
  isDefault: false,
  applicabilityPriority: 50,
  applicabilityRule: {
    in: [{ var: 'process.modalityCode' }, [...DIRECT_CONTRACTING_MODALITIES]],
  },
  stages: [
    ABERTURA,
    APROVACAO_DFD,
    task(
      'INSTRUCAO',
      'Instrução da contratação direta',
      15,
      ['ETP', 'TR', 'PRICE_RESEARCH', 'NOTA_TECNICA'],
      'Instrua o processo conforme o art. 72: ETP e TR quando cabíveis (I), pesquisa de preços (II) e a justificativa da escolha do fornecedor e do preço em **Nota Técnica** (VI e VII).',
    ),
    authorityApproval(
      'AUTORIZACAO',
      'Autorização da autoridade competente',
      ['ETP', 'TR', 'PRICE_RESEARCH', 'NOTA_TECNICA'],
      'A autoridade competente analisa a instrução e autoriza a contratação direta (art. 72, VIII), devolve para ajustes ou indefere.',
    ),
    CONCLUSAO,
  ],
  transitions: [
    edge(
      'ENVIAR_APROVACAO_DFD',
      'Enviar para aprovação da demanda',
      'ABERTURA',
      'APROVACAO_DFD',
      'FORWARD',
    ),
    edge('APROVAR_DFD', 'Aprovar a demanda', 'APROVACAO_DFD', 'INSTRUCAO', 'APPROVE'),
    edge('DEVOLVER_DFD', 'Devolver para ajustes no DFD', 'APROVACAO_DFD', 'ABERTURA', 'RETURN'),
    edge('INDEFERIR_DFD', 'Indeferir a demanda', 'APROVACAO_DFD', 'ABERTURA', 'REJECT'),
    edge('ENVIAR_AUTORIZACAO', 'Enviar para autorização', 'INSTRUCAO', 'AUTORIZACAO', 'FORWARD'),
    edge(
      'DEVOLVER_INSTRUCAO_ABERTURA',
      'Devolver à formalização da demanda',
      'INSTRUCAO',
      'ABERTURA',
      'RETURN',
    ),
    edge('AUTORIZAR', 'Autorizar a contratação direta', 'AUTORIZACAO', 'CONCLUSAO', 'APPROVE'),
    edge(
      'DEVOLVER_AUTORIZACAO_INSTRUCAO',
      'Devolver à instrução',
      'AUTORIZACAO',
      'INSTRUCAO',
      'RETURN',
    ),
    edge(
      'DEVOLVER_AUTORIZACAO_ABERTURA',
      'Devolver à formalização da demanda',
      'AUTORIZACAO',
      'ABERTURA',
      'RETURN',
    ),
    edge(
      'INDEFERIR_AUTORIZACAO',
      'Indeferir a contratação direta',
      'AUTORIZACAO',
      'ABERTURA',
      'REJECT',
    ),
  ],
  rules: [
    documentRule(
      'ABERTURA',
      'DFD',
      'COMPLETE',
      'BLOCKING',
      'DFD completo',
      'O DFD deve estar completo.',
    ),
    {
      stage: 'INSTRUCAO',
      type: 'CONDITION',
      name: 'TR ou ETP (art. 72, I)',
      severity: 'WARNING',
      config: {
        expression: { or: [{ var: 'documents.TR.exists' }, { var: 'documents.ETP.exists' }] },
      },
      message:
        'O processo não tem TR nem ETP. Confirme que, neste caso, eles não são cabíveis (art. 72, I).',
    },
    priceResearchCompleted(
      'INSTRUCAO',
      'Conclua a pesquisa de preços antes de enviar para autorização (art. 72, II).',
    ),
  ],
};

/** Os dois workflows semeados, na ordem de criação (o padrão primeiro). */
export const DEFAULT_WORKFLOWS: readonly SeedWorkflow[] = Object.freeze([
  DEFAULT_PREPARATORY,
  DIRECT_CONTRACTING,
]);

export interface SeedDefinitionContext {
  readonly tenantId: string;
  readonly workflowVersionId: string;
  readonly now: Date;
  readonly newId: () => string;
  /** Id do perfil aprovador pela chave (`AUTORIDADE_COMPETENTE`) no tenant. */
  readonly roleIdOf: (roleKey: string) => string;
}

/**
 * Materializa a definição de um workflow semeado na versão informada: ids novos, referências de
 * transição/regra resolvidas pela chave da etapa e colunas de controle do ator `SYSTEM` (`null`).
 */
export function materializeSeedDefinition(
  spec: SeedWorkflow,
  context: SeedDefinitionContext,
): WorkflowDefinition {
  const control = {
    tenantId: context.tenantId,
    workflowVersionId: context.workflowVersionId,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: null,
    updatedById: null,
    version: 1,
  };
  const stageIds = new Map(spec.stages.map((stage) => [stage.key, context.newId()]));
  const stageId = (key: string) => {
    const id = stageIds.get(key);
    if (id === undefined) throw new Error(`Etapa ${key} inexistente no workflow ${spec.key}.`);
    return id;
  };
  const stages: WorkflowStage[] = spec.stages.map((stage, index) => ({
    ...control,
    id: stageId(stage.key),
    key: stage.key,
    name: stage.name,
    instructions: stage.instructions,
    type: stage.type,
    groupLabel: null,
    displayOrder: (index + 1) * 10,
    departmentResolution: stage.departmentResolution,
    fixedDepartmentId: null,
    assignmentPolicy: stage.assignmentPolicy,
    approverType: stage.approver?.type ?? null,
    approverUserId: null,
    approverRoleId:
      stage.approver?.type === 'ROLE' ? context.roleIdOf(stage.approver.roleKey) : null,
    approverDepartmentResolution:
      stage.approver?.type === 'DEPARTMENT_HEAD' ? stage.approver.departmentResolution : null,
    approverFixedDepartmentId: null,
    allowDeputy: true,
    approvalDocumentTypeCodes: [...stage.approvalDocumentTypeCodes],
    documentTypeCodes: [...stage.documentTypeCodes],
    slaDays: stage.slaDays,
    slaType: 'BUSINESS',
    color: null,
  }));
  const transitions: WorkflowTransition[] = spec.transitions.map((transition, index) => ({
    ...control,
    id: context.newId(),
    key: transition.key,
    name: transition.name,
    description: null,
    fromStageId: stageId(transition.from),
    toStageId: stageId(transition.to),
    action: transition.action,
    displayOrder: index * 10,
    isPrimary: transition.isPrimary,
    // RN-WF-09: devolver e indeferir sempre pedem comentário.
    requiresComment: transition.action === 'RETURN' || transition.action === 'REJECT',
    allowDueDateOverride: true,
  }));
  const rules: WorkflowRule[] = spec.rules.map((rule, index) => ({
    ...control,
    id: context.newId(),
    scope: 'STAGE_EXIT',
    stageId: stageId(rule.stage),
    transitionId: null,
    type: rule.type,
    name: rule.name,
    description: null,
    severity: rule.severity,
    config: { ...rule.config },
    message: rule.message,
    isActive: true,
    displayOrder: index * 10,
  }));
  return { stages, transitions, rules };
}
