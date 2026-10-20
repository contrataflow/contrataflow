import type { FieldError, WorkflowStageFields } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import type { DocumentTypeCodes } from '#shared/document/document-type-catalog.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { WorkflowDefinition } from '../domain/workflow-definition.js';
import type {
  DepartmentReference,
  RoleReference,
  WorkflowReferences,
} from '../domain/workflow-definition.validator.js';

const NOT_FOUND = 'Selecione um valor válido.';
const INACTIVE = 'O valor selecionado está inativo.';

const notFound = (field: string): FieldError => ({
  field,
  code: 'REFERENCE_NOT_FOUND',
  message: NOT_FOUND,
});
const inactive = (field: string): FieldError => ({
  field,
  code: 'REFERENCE_INACTIVE',
  message: INACTIVE,
});

type StageReferenceField =
  | 'fixedDepartmentId'
  | 'approverFixedDepartmentId'
  | 'approverUserId'
  | 'approverRoleId'
  | 'approvalDocumentTypeCodes'
  | 'documentTypeCodes';

/**
 * Referências externas da definição (US-040 · V-05 · RN-WF-15/16): unidades (`organization`),
 * usuários (`identity`), perfis (`access`) e códigos de tipo de documento (porta
 * `DocumentTypeCatalog`), sempre lidos no `tx` do caso de uso — de outro tenant = inexistente.
 * Na escrita, recusa referência inexistente ou inativa (422); na validação completa, monta os
 * catálogos que o `WorkflowDefinitionValidator` consome.
 */
@Injectable()
export class WorkflowReferenceService {
  constructor(
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly documentTypes: DocumentTypeCatalog,
  ) {}

  /** Erros de referência dos campos da etapa informados (`fields`). */
  async stageReferenceErrors(
    tx: TenantTx,
    stage: WorkflowStageFields,
    fields: ReadonlySet<string>,
    now: Date,
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    const wants = (field: StageReferenceField) => fields.has(field);
    for (const field of ['fixedDepartmentId', 'approverFixedDepartmentId'] as const) {
      const departmentId = stage[field];
      if (!wants(field) || !departmentId) continue;
      const department = await this.organization.findDepartmentForApproval(tx, departmentId);
      if (!department) errors.push(notFound(field));
      else if (!department.isActive) errors.push(inactive(field));
    }
    if (wants('approverUserId') && stage.approverUserId) {
      const [member] = await this.identity.membersInTenant(tx, [stage.approverUserId]);
      if (!member) errors.push(notFound('approverUserId'));
      else if (!isActiveMember(member, now)) errors.push(inactive('approverUserId'));
    }
    if (wants('approverRoleId') && stage.approverRoleId) {
      const role = await this.access.findRoleForApproval(tx, stage.approverRoleId);
      if (!role) errors.push(notFound('approverRoleId'));
      else if (!role.isActive || !role.canDecideApprovals) errors.push(inactive('approverRoleId'));
    }
    const codesFields = (['approvalDocumentTypeCodes', 'documentTypeCodes'] as const).filter(
      (field) => wants(field) && stage[field].length > 0,
    );
    if (codesFields.length > 0) {
      const catalog = await this.documentTypes.codesOf(tx);
      for (const field of codesFields) {
        const error = codesError(field, stage[field], catalog);
        if (error) errors.push(error);
      }
    }
    return errors;
  }

  /** Código de tipo de documento existente e ativo (`REQUIRED_DOCUMENT` — RN-WF-15). */
  async documentTypeCodeError(
    tx: TenantTx,
    code: string,
    field: string,
  ): Promise<FieldError | null> {
    return codesError(field, [code], await this.documentTypes.codesOf(tx));
  }

  /** Catálogos para a validação completa da versão. */
  async resolve(
    tx: TenantTx,
    definition: WorkflowDefinition,
    now: Date,
  ): Promise<WorkflowReferences> {
    const departmentIds = new Set<string>();
    const userIds = new Set<string>();
    const roleIds = new Set<string>();
    for (const stage of definition.stages) {
      if (stage.fixedDepartmentId) departmentIds.add(stage.fixedDepartmentId);
      if (stage.approverFixedDepartmentId) departmentIds.add(stage.approverFixedDepartmentId);
      if (stage.approverUserId) userIds.add(stage.approverUserId);
      if (stage.approverRoleId) roleIds.add(stage.approverRoleId);
    }
    const departments = new Map<string, DepartmentReference>();
    for (const id of departmentIds) {
      const department = await this.organization.findDepartmentForApproval(tx, id);
      if (department) departments.set(id, department);
    }
    const roles = new Map<string, RoleReference>();
    for (const id of roleIds) {
      const role = await this.access.findRoleForApproval(tx, id);
      if (role) roles.set(id, role);
    }
    const members = userIds.size > 0 ? await this.identity.membersInTenant(tx, [...userIds]) : [];
    const catalog = await this.documentTypes.codesOf(tx);
    return {
      activeDocumentTypeCodes: catalog.active,
      departments,
      roles,
      activeUserIds: new Set(
        members.filter((member) => isActiveMember(member, now)).map((member) => member.userId),
      ),
    };
  }
}

function isActiveMember(
  member: { readonly status: string; readonly expiresAt: Date | null },
  now: Date,
): boolean {
  return (
    member.status === 'ACTIVE' &&
    (member.expiresAt === null || member.expiresAt.getTime() > now.getTime())
  );
}

function codesError(
  field: string,
  codes: readonly string[],
  catalog: DocumentTypeCodes,
): FieldError | null {
  if (codes.some((code) => !catalog.active.has(code) && !catalog.inactive.has(code))) {
    return { field, code: 'REFERENCE_NOT_FOUND', message: 'Tipo de documento não encontrado.' };
  }
  if (codes.some((code) => catalog.inactive.has(code))) {
    return {
      field,
      code: 'REFERENCE_INACTIVE',
      message: 'Este tipo de documento está desativado.',
    };
  }
  return null;
}
