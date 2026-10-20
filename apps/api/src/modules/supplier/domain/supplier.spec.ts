import { describe, expect, it } from 'vitest';

import { createAuditChanges, createSupplier, updateSupplier } from './supplier.js';
import type { ProtectedDocument } from './supplier.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date('2026-10-16T13:00:00.000Z');
const HASH = 'a'.repeat(64);

const cnpjDocument: ProtectedDocument = {
  normalized: '11222333000181',
  encrypted: null,
  hash: HASH,
};
const cpfDocument: ProtectedDocument = {
  normalized: '11144477735',
  encrypted: Buffer.from('cifrado'),
  hash: 'b'.repeat(64),
};

const context = (document: ProtectedDocument) => ({
  id: '0192a000-0000-7000-8000-0000000100a1',
  tenantId: '0192a000-0000-7000-8000-00000000000a',
  document,
  now: NOW,
  userId: '0192a000-0000-7000-8000-0000000000f1',
});

describe('createSupplier (RN-PRICE-14/16)', () => {
  it('cria ativo, versão 1, com os opcionais nulos e o CNPJ em claro', () => {
    const supplier = createSupplier(
      { documentType: 'CNPJ', documentNumber: '11.222.333/0001-81', legalName: 'ABC Ltda' },
      context(cnpjDocument),
    );

    expect(supplier).toMatchObject({
      documentType: 'CNPJ',
      documentNumber: '11222333000181',
      documentNumberEncrypted: null,
      documentNumberHash: HASH,
      legalName: 'ABC Ltda',
      tradeName: null,
      email: null,
      notes: null,
      isActive: true,
      version: 1,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('CPF fica mascarado e carrega o número cifrado', () => {
    const supplier = createSupplier(
      { documentType: 'CPF', documentNumber: '111.444.777-35', legalName: 'João' },
      context(cpfDocument),
    );

    expect(supplier.documentNumber).toBe('***.444.777-**');
    expect(supplier.documentNumberEncrypted?.toString()).toBe('cifrado');
    expect(JSON.stringify({ ...supplier, documentNumberEncrypted: null })).not.toContain(
      '11144477735',
    );
  });

  it('auditoria da criação: CNPJ em claro; CPF só pelo hash; sem contato', () => {
    const cnpj = createSupplier(
      {
        documentType: 'CNPJ',
        documentNumber: '11222333000181',
        legalName: 'ABC',
        email: 'a@b.com',
      },
      context(cnpjDocument),
    );
    const cpf = createSupplier(
      { documentType: 'CPF', documentNumber: '11144477735', legalName: 'João', tradeName: 'JS' },
      context(cpfDocument),
    );

    expect(createAuditChanges(cnpj)).toEqual([
      { path: 'documentType', old: null, new: 'CNPJ' },
      { path: 'documentNumber', old: null, new: '11222333000181' },
      { path: 'legalName', old: null, new: 'ABC' },
    ]);
    expect(createAuditChanges(cpf)).toEqual([
      { path: 'documentType', old: null, new: 'CPF' },
      { path: 'documentNumberHash', old: null, new: 'b'.repeat(64) },
      { path: 'legalName', old: null, new: 'João' },
      { path: 'tradeName', old: null, new: 'JS' },
    ]);
  });
});

describe('updateSupplier (FA-01/FA-02 · RN-PRICE-20)', () => {
  const current = createSupplier(
    {
      documentType: 'CNPJ',
      documentNumber: '11222333000181',
      legalName: 'ABC Ltda',
      phone: '4833',
    },
    context(cnpjDocument),
  );

  it('aplica o patch, limpa com null e mantém o documento e o que não veio', () => {
    const result = updateSupplier(
      current,
      { legalName: 'ABC Brasil', phone: null },
      {
        now: LATER,
        userId: 'u1',
      },
    );

    expect(result.changedFields).toEqual(['legalName', 'phone']);
    expect(result.next).toMatchObject({
      legalName: 'ABC Brasil',
      phone: null,
      documentNumber: '11222333000181',
      documentNumberHash: HASH,
      updatedAt: LATER,
      updatedById: 'u1',
      version: 1,
    });
    expect(result.changes).toEqual([
      { path: 'legalName', old: 'ABC Ltda', new: 'ABC Brasil' },
      { path: 'phone', old: '[alterado]', new: '[alterado]' },
    ]);
  });

  it('sem mudança: devolve o mesmo registro e nenhum campo alterado', () => {
    const result = updateSupplier(
      current,
      { legalName: 'ABC Ltda', phone: '4833' },
      {
        now: LATER,
        userId: 'u1',
      },
    );

    expect(result.changedFields).toEqual([]);
    expect(result.next).toBe(current);
    expect(updateSupplier(current, {}, { now: LATER, userId: 'u1' }).changedFields).toEqual([]);
  });

  it('inativar e reativar mudam só isActive', () => {
    const off = updateSupplier(current, { isActive: false }, { now: LATER, userId: 'u1' });
    expect(off.changedFields).toEqual(['isActive']);
    expect(off.changes).toEqual([{ path: 'isActive', old: true, new: false }]);
    const on = updateSupplier(off.next, { isActive: true }, { now: LATER, userId: 'u1' });
    expect(on.next.isActive).toBe(true);
  });
});
