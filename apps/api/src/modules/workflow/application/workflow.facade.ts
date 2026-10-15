import type { WorkflowValidationResult } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { WorkflowVersionPublisher } from './workflow-version.publisher.js';
import type {
  PublishWorkflowVersionInput,
  PublishWorkflowVersionResult,
} from './workflow-version.publisher.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

export type {
  PublishWorkflowVersionInput,
  PublishWorkflowVersionResult,
} from './workflow-version.publisher.js';
export type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

/**
 * API pública do módulo `workflow` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-040: validação completa, publicação interna (seeder — US-042;
 * WF-21 — US-045) e a definição publicada para o motor (US-041). A autorização é de quem chama.
 */
@Injectable()
export class WorkflowFacade {
  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly publisher: WorkflowVersionPublisher,
  ) {}

  /** `WorkflowDefinitionValidator.validate(versionId)`: todos os erros e avisos (V-11). */
  validate(versionId: string): Promise<WorkflowValidationResult> {
    return this.definitions.validate(versionId);
  }

  /** Publica numa transação própria (422 `WORKFLOW_INVALID` com os problemas). */
  publish(input: PublishWorkflowVersionInput): Promise<PublishWorkflowVersionResult> {
    return this.publisher.publish(input);
  }

  /** Publica no `tx` do chamador (seeder dos workflows padrão — US-042). */
  publishIn(
    tx: TenantTx,
    input: PublishWorkflowVersionInput,
  ): Promise<PublishWorkflowVersionResult> {
    return this.publisher.publishIn(tx, input);
  }

  /** Snapshot da versão publicada/aposentada (cache imutável; Redis fora → banco). */
  publishedDefinition(versionId: string): Promise<WorkflowSnapshot | null> {
    return this.definitions.publishedDefinition(versionId);
  }
}
