import { localDateOf } from '@contrataflow/types';
import { evaluateDfdCompleteness } from '@contrataflow/validation';
import type { Violation } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DFD_CLOCK, DFD_REPOSITORY } from './ports.js';
import type { DfdClock, DfdRepository } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from '../../document/application/document.facade.js';
import { FilesFacade } from '../../files/application/files.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { dfdHeaderValues } from '../domain/dfd.js';
import type { Dfd } from '../domain/dfd.js';

/*
 * `DfdDocumentValidator` (US-014 · RN-DFD-18/19 · porta `DocumentValidator` da US-065): o módulo
 * `dfd` só fornece o cabeçalho e as regras; o `document` compõe as genéricas com estas num único
 * `violations[]` — DOC-08, a conclusão (US-016) e o `RuleContext` usam o mesmo registro. A função é
 * a de `packages/validation` (`evaluateDfdCompleteness`), alimentada aqui com os dados atuais: itens
 * do documento, vínculo do responsável, setor e anexos em verificação. Tudo no `tx` do caso de uso.
 */

@Injectable()
export class DfdDocumentValidator implements DocumentValidator {
  readonly module = 'DFD' as const;
  private readonly logger = new Logger('Dfd');

  constructor(
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    @Inject(DFD_CLOCK) private readonly clock: DfdClock,
    private readonly documents: DocumentFacade,
    private readonly files: FilesFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
    private readonly numbering: NumberingFacade,
  ) {}

  async validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]> {
    const startedAt = performance.now();
    const dfd = await this.dfds.findById(tx, subject.document.id);
    if (dfd === null) return [];
    const now = this.clock();
    const [items, pendingAttachments, membership, departments, settings] = [
      await this.documents.documentItemsIn(tx, subject.document.id),
      await this.files.scanPendingCount(tx, {
        processId: subject.document.processId,
        targetType: 'DOCUMENT',
        targetId: subject.document.id,
      }),
      await this.identity.membershipOfUser(tx, dfd.responsibleId),
      await this.organization.departmentReferences(tx, [dfd.requestingDepartmentId]),
      await this.numbering.settingsOf(tx),
    ];
    const violations = evaluateDfdCompleteness({
      header: dfdHeaderValues(dfd),
      sections: subject.document.draftContent.sections,
      sectionDefinitions: subject.template?.sections ?? [],
      fieldConfig: subject.template?.fieldConfig ?? {},
      items,
      pendingAttachments,
      responsibleActive:
        membership !== null &&
        membership.status === 'ACTIVE' &&
        (membership.expiresAt === null || membership.expiresAt.getTime() > now.getTime()),
      departmentActive: departments.get(dfd.requestingDepartmentId)?.isActive === true,
      today: localDateOf(now, settings.timezone),
    });
    this.logger.debug(
      {
        event: 'document.validation_evaluated',
        documentId: subject.document.id,
        blockingCount: violations.filter((item) => item.severity === 'BLOCKING').length,
        warningCount: violations.filter((item) => item.severity === 'WARNING').length,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'document.validation_evaluated',
    );
    return violations;
  }

  /** Resumo do cartão do painel e de `DocumentFinalized` (RN-DOC-17/52); POL-09 é de quem lê. */
  async typedSummary(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const dfd = await this.dfds.findById(tx, subject.document.id);
    if (dfd === null) return null;
    const items = await this.documents.documentItemsIn(tx, subject.document.id);
    return {
      requestDate: dfd.requestDate,
      priority: dfd.priority,
      expectedDate: dfd.expectedDate,
      estimatedValue: dfd.estimatedValue,
      itemsCount: items.length,
    };
  }

  /** Cabeçalho e itens congelados na versão e na prévia em PDF (entities.md §5.3.2). */
  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    const dfd = await this.dfds.findById(tx, subject.document.id);
    if (dfd === null) return { header: {}, collections: {} };
    const items = await this.documents.documentItemsIn(tx, subject.document.id);
    return {
      header: snapshotHeader(dfd),
      collections: {
        items: items.map((item) => ({
          processItemId: item.processItemId,
          quantity: item.quantity,
          notes: item.notes,
          sortOrder: item.sortOrder,
        })),
      },
    };
  }
}

function snapshotHeader(dfd: Dfd): Readonly<Record<string, unknown>> {
  return { ...dfdHeaderValues(dfd) };
}
