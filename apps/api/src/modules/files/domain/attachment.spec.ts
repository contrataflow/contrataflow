import { ATTACHMENT_STATUSES } from '@contrataflow/types';
import type { AttachmentStatus } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  AttachmentTransitionError,
  canClaimScan,
  canTransition,
  claimedAttempt,
  confirmUpload,
  createAttachment,
  deleteAttachment,
  markAvailable,
  markRejected,
  reasonCodeOf,
  releaseScan,
  startScanning,
} from './attachment.js';
import type { Attachment } from './attachment.js';

const T0 = new Date('2026-10-17T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const USER = '0192a000-0000-7000-8000-0000000000a1';
const SHA = 'a'.repeat(64);

function pending(sizeBytes = 100): Attachment {
  return createAttachment({
    id: '0192a000-0000-7000-8000-0000000000b1',
    tenantId: '0192a000-0000-7000-8000-00000000000a',
    processId: '0192a000-0000-7000-8000-0000000000c1',
    targetType: 'DOCUMENT',
    targetId: '0192a000-0000-7000-8000-0000000000d1',
    categoryId: null,
    fileName: 'ata.pdf',
    extension: 'pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes,
    storageKey: 'tenants/x/processes/y/attachments/z/ata.pdf',
    quarantineKey: 'tenants/x/uploads/z',
    description: null,
    uploadedById: USER,
    now: T0,
  });
}

const inStatus = (status: AttachmentStatus): Attachment => ({ ...pending(), status });

describe('Attachment — máquina de estados (storage.md §5.1)', () => {
  it('nasce PENDING_UPLOAD, versão 1, sem hash nem varredura', () => {
    expect(pending()).toMatchObject({
      status: 'PENDING_UPLOAD',
      version: 1,
      sha256: null,
      scannedAt: null,
      uploadedAt: null,
    });
  });

  it.each([
    ['PENDING_UPLOAD', ['UPLOADED', 'REJECTED', 'DELETED']],
    ['UPLOADED', ['SCANNING']],
    ['SCANNING', ['SCANNING', 'AVAILABLE', 'INFECTED', 'REJECTED']],
    ['AVAILABLE', ['DELETED']],
    ['INFECTED', []],
    ['REJECTED', []],
    ['DELETED', []],
  ] as const)('%s só vai para %j', (from, allowed) => {
    for (const to of ATTACHMENT_STATUSES) {
      expect(canTransition(from, to)).toBe((allowed as readonly string[]).includes(to));
    }
  });

  it('confirmação: tamanho igual → UPLOADED; divergente → REJECTED SIZE_MISMATCH (RN-DOC-73)', () => {
    const ok = confirmUpload(pending(100), 100, later(1), USER);
    expect(ok).toMatchObject({ status: 'UPLOADED', uploadedAt: later(1), version: 2 });
    const bad = confirmUpload(pending(100), 99, later(1), USER);
    expect(bad).toMatchObject({ status: 'REJECTED', scanResult: { reasonCode: 'SIZE_MISMATCH' } });
    expect(reasonCodeOf(bad)).toBe('SIZE_MISMATCH');
    expect(() => confirmUpload(ok, 100, later(2), USER)).toThrow(AttachmentTransitionError);
  });

  it('AVAILABLE só a partir de SCANNING, com hash, MIME detectado e data da varredura (P3)', () => {
    const scan = { sha256: SHA, detectedMimeType: 'application/pdf', scanResult: {} };
    expect(() => markAvailable(inStatus('UPLOADED'), scan, T0)).toThrow(AttachmentTransitionError);
    expect(() => markAvailable(inStatus('PENDING_UPLOAD'), scan, T0)).toThrow(
      AttachmentTransitionError,
    );
    const scanning = startScanning(inStatus('UPLOADED'), 1, T0);
    expect(markAvailable(scanning, scan, later(5))).toMatchObject({
      status: 'AVAILABLE',
      sha256: SHA,
      detectedMimeType: 'application/pdf',
      scannedAt: later(5),
    });
  });

  it('rejeições guardam o motivo; INFECTED expõe só INFECTED (sem assinatura)', () => {
    const scanning = startScanning(inStatus('UPLOADED'), 1, T0);
    const infected = markRejected(
      scanning,
      'INFECTED',
      { sha256: SHA, scanResult: { signature: 'Eicar-Test-Signature', reasonCode: 'INFECTED' } },
      T0,
    );
    expect(reasonCodeOf(infected)).toBe('INFECTED');
    const rejected = markRejected(
      scanning,
      'REJECTED',
      { sha256: null, scanResult: { reasonCode: 'TYPE_MISMATCH', detectedMimeType: null } },
      T0,
    );
    expect(reasonCodeOf(rejected)).toBe('TYPE_MISMATCH');
    expect(reasonCodeOf({ ...rejected, scanResult: null })).toBe('STRUCTURAL_CHECK_FAILED');
    expect(reasonCodeOf(inStatus('AVAILABLE'))).toBeNull();
  });

  it('exclusão lógica só de AVAILABLE/PENDING_UPLOAD, com motivo e autor (DEC-034)', () => {
    expect(deleteAttachment(inStatus('AVAILABLE'), 'duplicado', T0, USER)).toMatchObject({
      status: 'DELETED',
      deletionReason: 'duplicado',
      deletedAt: T0,
      deletedById: USER,
    });
    expect(() => deleteAttachment(inStatus('SCANNING'), 'x', T0, USER)).toThrow(
      AttachmentTransitionError,
    );
  });
});

describe('trava da varredura (RN-DOC-74)', () => {
  const LEASE = 90_000;

  it('UPLOADED: qualquer tentativa assume; terminal ou pendente: nenhuma', () => {
    expect(canClaimScan(inStatus('UPLOADED'), 1, T0, LEASE)).toBe(true);
    for (const status of [
      'PENDING_UPLOAD',
      'AVAILABLE',
      'INFECTED',
      'REJECTED',
      'DELETED',
    ] as const) {
      expect(canClaimScan(inStatus(status), 1, T0, LEASE)).toBe(false);
    }
  });

  it('SCANNING: a mesma tentativa não assume de novo; a seguinte ou a trava vencida sim', () => {
    const scanning = startScanning(inStatus('UPLOADED'), 1, T0);
    expect(claimedAttempt(scanning)).toBe(1);
    expect(canClaimScan(scanning, 1, later(1_000), LEASE)).toBe(false);
    expect(canClaimScan(scanning, 2, later(1_000), LEASE)).toBe(true);
    expect(canClaimScan(scanning, 1, later(LEASE), LEASE)).toBe(true);
  });

  it('devolver a trava mantém SCANNING e libera a mesma tentativa (FA-05)', () => {
    const scanning = startScanning(inStatus('UPLOADED'), 3, T0);
    const released = releaseScan(scanning, 3, later(1));
    expect(released.status).toBe('SCANNING');
    expect(claimedAttempt(released)).toBe(2);
    expect(canClaimScan(released, 3, later(2), LEASE)).toBe(true);
    expect(claimedAttempt(pending())).toBe(0);
  });
});
