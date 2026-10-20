import type { ApprovalPolicy } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  createCustomDocumentType,
  DocumentTypeRuleError,
  editableFieldsOf,
  normalizeApprovalPolicy,
  updateDocumentType,
} from './document-type.js';
import type { CreateCustomInput, DocumentType } from './document-type.js';
import { buildSystemDocumentTypes, SYSTEM_DOCUMENT_TYPES } from './system-document-types.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-15T13:00:00.000Z');

let sequence = 0;
const nextId = () => `0192f000-0000-7000-8000-${String(++sequence).padStart(12, '0')}`;

const input: CreateCustomInput = {
  kind: 'FREE_TEXT',
  code: 'PARECER_TECNICO',
  name: '  Parecer técnico ',
  allowMultiplePerProcess: true,
  numberingEnabled: true,
  numberingMask: 'PT {seq:3}/{year}',
  requiresApproval: false,
  defaultConfidentiality: 'INTERNAL',
};

const custom = (patch: Partial<CreateCustomInput> = {}): DocumentType =>
  createCustomDocumentType(
    { ...input, ...patch },
    { id: nextId(), tenantId: TENANT, now: NOW, userId: USER },
  );

const system = (code: string): DocumentType => {
  const type = buildSystemDocumentTypes(TENANT, NOW, nextId).find((item) => item.code === code);
  if (!type) throw new Error(`tipo semeado ${code} inexistente`);
  return type;
};

const policy: ApprovalPolicy = {
  approverType: 'DEPARTMENT_HEAD',
  approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
  allowDeputy: true,
  slaDays: 3,
  slaType: 'BUSINESS',
};

const ctx = { now: LATER, userId: USER, documentsCount: 0 };

function violationsOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof DocumentTypeRuleError) return error.violations;
    throw error;
  }
  throw new Error('não lançou DocumentTypeRuleError');
}

describe('createCustomDocumentType (RN-DOC-01/02/05/06)', () => {
  it('cria tipo personalizado ativo, não de sistema, versão 1', () => {
    const type = custom();
    expect(type).toMatchObject({
      isSystem: false,
      isActive: true,
      systemModule: null,
      defaultTemplateId: null,
      version: 1,
      name: 'Parecer técnico',
      numberingMask: 'PT {seq:3}/{year}',
      createdById: USER,
      sortOrder: 0,
    });
  });

  it('máscara vazia vira nula (usa a padrão do tenant)', () => {
    expect(custom({ numberingMask: '   ' }).numberingMask).toBeNull();
    expect(custom({ numberingMask: null }).numberingMask).toBeNull();
  });

  it.each(['PT {seq:3}', 'PT {year}', 'PT {seq:3}/{ano}', 'PT {seq:3}/{year', '{seq:9}{year}'])(
    'recusa a máscara %s (V-06)',
    (numberingMask) => {
      expect(violationsOf(() => custom({ numberingMask }))).toEqual([
        expect.objectContaining({ kind: 'NUMBERING_MASK', field: 'numberingMask' }),
      ]);
    },
  );

  it('aprovação avulsa exige a política (RN-DOC-06 · V-07)', () => {
    expect(violationsOf(() => custom({ requiresApproval: true }))).toEqual([
      expect.objectContaining({ field: 'approvalPolicy', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    expect(custom({ requiresApproval: true, approvalPolicy: policy }).approvalPolicy).toEqual(
      policy,
    );
  });
});

describe('normalizeApprovalPolicy', () => {
  it('mantém só os campos do tipo de aprovador e o slaType padrão BUSINESS', () => {
    expect(
      normalizeApprovalPolicy({
        approverType: 'USER',
        approverUserId: USER,
        approverRoleId: '0192f000-0000-7000-8000-0000000000b2',
        approverDepartmentResolution: 'FIXED',
        allowDeputy: false,
        slaDays: 5,
      }),
    ).toEqual({
      approverType: 'USER',
      approverUserId: USER,
      allowDeputy: false,
      slaDays: 5,
      slaType: 'BUSINESS',
    });
  });

  it('unidade fixa só com resolução FIXED; sem prazo não há slaType', () => {
    expect(
      normalizeApprovalPolicy({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
        approverFixedDepartmentId: USER,
        allowDeputy: true,
      }),
    ).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_DEPARTMENT',
      allowDeputy: true,
    });
  });
});

describe('editableFieldsOf (RN-DOC-03/04)', () => {
  it('tipo personalizado edita os dez campos permitidos', () => {
    expect(editableFieldsOf(custom())).toHaveLength(10);
  });

  it('tipo de sistema FREE_TEXT/UPLOADED: sem allowMultiplePerProcess, com isActive', () => {
    const fields = editableFieldsOf(system('OFICIO'));
    expect(fields).toContain('isActive');
    expect(fields).toContain('numberingMask');
    expect(fields).not.toContain('allowMultiplePerProcess');
    expect(editableFieldsOf(system('DOCUMENTO_EXTERNO'))).toContain('isActive');
  });

  it('tipo STRUCTURED não se desativa', () => {
    const fields = editableFieldsOf(system('DFD'));
    expect(fields).not.toContain('isActive');
    expect(fields).not.toContain('allowMultiplePerProcess');
    expect(fields).toContain('requiresApproval');
  });
});

describe('updateDocumentType', () => {
  it('altera campos, soma a versão e lista só o que mudou (campo a campo)', () => {
    const current = custom();
    const result = updateDocumentType(
      current,
      { name: 'Parecer jurídico', numberingMask: 'PJ {seq:4}/{year}', sortOrder: 0 },
      ctx,
    );
    expect(result.next).toMatchObject({
      name: 'Parecer jurídico',
      numberingMask: 'PJ {seq:4}/{year}',
      version: 2,
      updatedAt: LATER,
      updatedById: USER,
    });
    expect(result.changedFields).toEqual(['name', 'numberingMask']);
    expect(result.changes).toEqual([
      { path: 'name', old: 'Parecer técnico', new: 'Parecer jurídico' },
      { path: 'numberingMask', old: 'PT {seq:3}/{year}', new: 'PJ {seq:4}/{year}' },
    ]);
  });

  it('valor igual ao atual não é alteração: nada muda, versão intacta', () => {
    const current = custom();
    const result = updateDocumentType(current, { name: 'Parecer técnico' }, ctx);
    expect(result.changedFields).toEqual([]);
    expect(result.next).toBe(current);
  });

  it('liga a aprovação avulsa em tipo de sistema (Gherkin) e pede validar o aprovador', () => {
    const current = system('NOTA_TECNICA');
    const result = updateDocumentType(
      current,
      { requiresApproval: true, approvalPolicy: policy },
      ctx,
    );
    expect(result.next).toMatchObject({ requiresApproval: true, approvalPolicy: policy });
    expect(result.policyNeedsValidation).toBe(true);
    expect(result.changedFields).toEqual(['requiresApproval', 'approvalPolicy']);
    expect(result.changes.map((change) => change.path)).toEqual([
      'requiresApproval',
      'approvalPolicy.allowDeputy',
      'approvalPolicy.approverDepartmentResolution',
      'approvalPolicy.approverType',
      'approvalPolicy.slaDays',
      'approvalPolicy.slaType',
    ]);
  });

  it('desligar a aprovação mantém a última política para o histórico (RN-DOC-06)', () => {
    const current = custom({ requiresApproval: true, approvalPolicy: policy });
    const result = updateDocumentType(current, { requiresApproval: false }, ctx);
    expect(result.next).toMatchObject({ requiresApproval: false, approvalPolicy: policy });
    expect(result.policyNeedsValidation).toBe(false);
  });

  it('ligar a aprovação sem política → CONDITIONAL_REQUIRED; limpar a política com a aprovação ligada também', () => {
    expect(
      violationsOf(() => updateDocumentType(custom(), { requiresApproval: true }, ctx)),
    ).toEqual([expect.objectContaining({ field: 'approvalPolicy', code: 'CONDITIONAL_REQUIRED' })]);
    const approving = custom({ requiresApproval: true, approvalPolicy: policy });
    expect(
      violationsOf(() => updateDocumentType(approving, { approvalPolicy: null }, ctx)),
    ).toEqual([expect.objectContaining({ field: 'approvalPolicy', code: 'CONDITIONAL_REQUIRED' })]);
  });

  it('máscara inválida na edição → violação de máscara (V-06)', () => {
    expect(
      violationsOf(() => updateDocumentType(custom(), { numberingMask: 'PT {seq:3}' }, ctx)),
    ).toEqual([expect.objectContaining({ kind: 'NUMBERING_MASK' })]);
  });

  it('tipo STRUCTURED: isActive e allowMultiplePerProcess são NOT_ALLOWED (V-04/V-12)', () => {
    const violations = violationsOf(() =>
      updateDocumentType(system('DFD'), { isActive: false, allowMultiplePerProcess: true }, ctx),
    );
    expect(violations).toEqual([
      expect.objectContaining({ field: 'isActive', code: 'NOT_ALLOWED' }),
      expect.objectContaining({ field: 'allowMultiplePerProcess', code: 'NOT_ALLOWED' }),
    ]);
  });

  it('tipo de sistema aceita nome, numeração e aprovação, e pode ser desativado se não for STRUCTURED', () => {
    const result = updateDocumentType(
      system('OFICIO'),
      { name: 'Ofício externo', isActive: false },
      ctx,
    );
    expect(result.deactivates).toBe(true);
    expect(result.next).toMatchObject({ name: 'Ofício externo', isActive: false, isSystem: true });
  });

  it('allowMultiplePerProcess muda sem documentos e é bloqueado com documentos (V-14)', () => {
    const current = custom();
    expect(
      updateDocumentType(current, { allowMultiplePerProcess: false }, ctx).next
        .allowMultiplePerProcess,
    ).toBe(false);
    expect(
      violationsOf(() =>
        updateDocumentType(
          current,
          { allowMultiplePerProcess: false },
          { ...ctx, documentsCount: 4 },
        ),
      ),
    ).toEqual([expect.objectContaining({ field: 'allowMultiplePerProcess', code: 'NOT_ALLOWED' })]);
    // Mesmo valor com documentos: não é alteração.
    expect(
      updateDocumentType(current, { allowMultiplePerProcess: true }, { ...ctx, documentsCount: 4 })
        .changedFields,
    ).toEqual([]);
  });

  it('ativar de novo não é desativação; reativar altera isActive', () => {
    const inactive = updateDocumentType(custom(), { isActive: false }, ctx).next;
    const reactivated = updateDocumentType(inactive, { isActive: true }, ctx);
    expect(reactivated.next.isActive).toBe(true);
    expect(reactivated.deactivates).toBe(false);
  });
});

describe('tipos semeados (entities.md §7)', () => {
  const seeded = buildSystemDocumentTypes(TENANT, NOW, nextId);

  it('onze tipos de sistema, nenhum com aprovação avulsa (DEC-018), códigos válidos e únicos', () => {
    expect(seeded).toHaveLength(11);
    expect(new Set(seeded.map((type) => type.code)).size).toBe(11);
    expect(seeded.every((type) => type.isSystem && !type.requiresApproval && type.isActive)).toBe(
      true,
    );
    expect(seeded.every((type) => /^[A-Z][A-Z0-9_]{1,39}$/.test(type.code))).toBe(true);
    expect(seeded.map((type) => type.sortOrder)).toEqual(
      SYSTEM_DOCUMENT_TYPES.map((_spec, index) => (index + 1) * 10),
    );
  });

  it('STRUCTURED ⇔ systemModule, único por processo (check do banco espelhado)', () => {
    for (const type of seeded) {
      expect(type.kind === 'STRUCTURED').toBe(type.systemModule !== null);
      if (type.kind === 'STRUCTURED') expect(type.allowMultiplePerProcess).toBe(false);
    }
    expect(seeded.find((type) => type.code === 'TR')?.systemModule).toBe('TERM_OF_REFERENCE');
  });

  it('máscaras da lacuna 2; DOCUMENTO_EXTERNO sem numeração; as demais usam a padrão', () => {
    const mask = (code: string) => seeded.find((type) => type.code === code)?.numberingMask;
    expect(mask('RISK_MAP')).toBe('MR {seq:4}/{year}');
    expect(mask('PRICE_RESEARCH')).toBe('PP {seq:4}/{year}');
    expect(mask('NOTA_TECNICA')).toBe('NT {seq:4}/{year}');
    expect(mask('DFD')).toBeNull();
    expect(seeded.find((type) => type.code === 'DOCUMENTO_EXTERNO')?.numberingEnabled).toBe(false);
  });
});
