// Carga dos testes de rota do encaminhamento (US-047) em memória: o titular de unidade (aprovador
// `DEPARTMENT_HEAD` e política `DEPARTMENT_HEAD`), um contribuidor de teste do `RuleContext` para
// os tipos cujos módulos donos ainda não registram o seu (ETP — US-019, mapa de riscos — US-035) e
// o rascunho completo do DFD (o autosave é da US-015). Fica fora de `src/modules` porque os specs de
// um módulo não importam internos de outro (DEC-041 · dependency-cruiser).
import { InMemoryDfdRepository } from '#modules/dfd/infrastructure/dfd.repositories.js';
import { InMemoryDepartmentRepository } from '#modules/organization/infrastructure/in-memory-department.repository.js';
import { WorkflowFacade } from '#modules/workflow/application/workflow.facade.js';
import type {
  RuleContextContribution,
  RuleContextContributor,
  RuleContextRequest,
  RuleDocumentFact,
} from '#modules/workflow/application/workflow.facade.js';
import { InMemoryWorkflowRepository } from '#modules/workflow/infrastructure/in-memory-workflow.repository.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TestApi } from './api-test-app.js';
import { documentRepositoryOf, filledSection } from './document-fixtures.js';

/**
 * Titular (`headUserId`) e, se informado, substituto (`deputyUserId`) da unidade em memória;
 * `null` = sem titular (aprovador não resolvível).
 */
export function setDepartmentHead(
  api: TestApi,
  departmentId: string,
  headUserId: string | null,
  deputyUserId?: string | null,
): void {
  const repository = api.app.get(InMemoryDepartmentRepository, { strict: false });
  const department = repository.snapshot().find((candidate) => candidate.id === departmentId);
  if (!department) throw new Error(`unidade ${departmentId} ausente`);
  repository.seed({
    ...department,
    headUserId,
    ...(deputyUserId === undefined ? {} : { deputyUserId }),
  });
}

/**
 * Workflow publicado em memória fora da aplicabilidade (inativo): os processos novos continuam no
 * workflow padrão e a versão fixada pelo teste segue legível pelo motor (snapshot imutável).
 */
export async function deactivateWorkflow(
  api: TestApi,
  tenantId: string,
  key: string,
): Promise<void> {
  const workflows = api.app.get(InMemoryWorkflowRepository, { strict: false });
  await runAsSystem({ name: 'test.seed', tenantId }, () =>
    runSimulatedTransaction(async (tx) => {
      const workflow = await workflows.findWorkflowByKey(tx, key);
      if (!workflow) throw new Error(`workflow ${key} ausente`);
      await workflows.updateWorkflow(tx, { ...workflow, isActive: false }, workflow.version);
    }),
  );
}

/**
 * Fatos de documentos por processo para o `RuleContext` (os mesmos que o módulo dono do tipo
 * entregará): substituem os da semente para os códigos informados.
 */
export class TestDocumentFacts implements RuleContextContributor {
  readonly name = 'test-forward-documents';
  private readonly facts = new Map<string, readonly RuleDocumentFact[]>();

  set(processId: string, documents: readonly RuleDocumentFact[]): void {
    this.facts.set(processId, documents);
  }

  contribute(_tx: TenantTx, request: RuleContextRequest): Promise<RuleContextContribution> {
    const documents = this.facts.get(request.processId);
    return Promise.resolve(documents === undefined ? {} : { documents });
  }
}

export function registerTestDocumentFacts(api: TestApi): TestDocumentFacts {
  const facts = new TestDocumentFacts();
  api.app.get(WorkflowFacade, { strict: false }).registerRuleContextContributor(facts);
  return facts;
}

/** Rascunho do DFD com as seções e o cabeçalho informados, direto nos repositórios em memória. */
export function fillDfdDraft(
  api: TestApi,
  dfd: { readonly id: string; readonly documentId: string },
  sections: Readonly<Record<string, string>>,
  header: Readonly<Record<string, unknown>>,
): void {
  const documents = documentRepositoryOf(api);
  const document = documents.allDocuments().find((candidate) => candidate.id === dfd.documentId);
  if (!document) throw new Error('documento do DFD ausente');
  const next = { ...document.draftContent.sections };
  for (const [key, text] of Object.entries(sections)) next[key] = filledSection(text);
  documents.seed({ ...document, draftContent: { sections: next } });
  const store = api.app.get(InMemoryDfdRepository, { strict: false });
  const stored = store.snapshot().find((candidate) => candidate.id === dfd.id);
  if (!stored) throw new Error('DFD ausente');
  store.seed({ ...stored, ...header });
}
