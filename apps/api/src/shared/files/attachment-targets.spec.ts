import { describe, expect, it } from 'vitest';

import { AttachmentTargetRegistry } from './attachment-targets.js';
import type { AttachmentTarget, AttachmentTargetReader } from './attachment-targets.js';
import type { TenantTx } from '../database/prisma.js';

/*
 * `AttachmentTargetRegistry` com mais de um dono por tipo (US-109): `TENANT_ASSET` enviado a partir
 * do rascunho de template (`document`) ou do órgão (US-101). O primeiro que reconhece o alvo o
 * carrega e é ele quem confere a regra de edição; sem leitor, falha fechado.
 */

const tx = {} as TenantTx;

function reader(known: string, calls: string[]): AttachmentTargetReader {
  return {
    targetTypes: ['TENANT_ASSET'],
    load: (_tx, ref) =>
      Promise.resolve(ref.targetId === known ? { ...ref, processId: null, process: null } : null),
    assertAttachable: (_tx, target: AttachmentTarget) => {
      calls.push(`${known}:${target.targetId}`);
      return Promise.resolve();
    },
  };
}

describe('AttachmentTargetRegistry (vários donos por tipo — US-109)', () => {
  it('o leitor que reconhece o alvo o carrega e confere a regra de edição', async () => {
    const calls: string[] = [];
    const registry = new AttachmentTargetRegistry();
    const template = reader('template', calls);
    registry.register(template);
    registry.register(reader('organization', calls));
    registry.register(template);

    const target = await registry.load(tx, {
      targetType: 'TENANT_ASSET',
      targetId: 'organization',
    });
    expect(target).not.toBeNull();
    if (target === null) return;
    await registry.assertAttachable(tx, target);
    expect(calls).toEqual(['organization:organization']);
    expect(
      await registry.load(tx, { targetType: 'TENANT_ASSET', targetId: 'desconhecido' }),
    ).toBeNull();
    expect(
      await registry.confidentiality(tx, { targetType: 'TENANT_ASSET', targetId: 'x' }),
    ).toEqual({
      restricted: false,
      allowed: true,
    });
  });

  it('sem leitor para o tipo: alvo inexistente e sigilo fechado', async () => {
    const registry = new AttachmentTargetRegistry();
    expect(registry.supports('RISK')).toBe(false);
    expect(await registry.load(tx, { targetType: 'RISK', targetId: 'x' })).toBeNull();
    expect(await registry.confidentiality(tx, { targetType: 'RISK', targetId: 'x' })).toEqual({
      restricted: true,
      allowed: false,
    });
    await expect(
      registry.assertAttachable(tx, {
        targetType: 'RISK',
        targetId: 'x',
        processId: null,
        process: null,
      }),
    ).rejects.toThrow(/sem leitor/);
  });
});
