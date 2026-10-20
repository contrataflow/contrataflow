import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  MandatoryChannelError,
  effectivePreferences,
  planPreferenceChanges,
} from './notification-preference.js';
import type { StoredPreference } from './notification-preference.js';

const find = (
  list: ReturnType<typeof effectivePreferences>,
  notificationType: string,
  channel: string,
) => list.find((item) => item.notificationType === notificationType && item.channel === channel);

describe('Preferências de notificação — resolução do padrão (RN-NTF-22 · FA-03)', () => {
  it('sem linha salva, toda combinação vale o padrão do registro', () => {
    const list = effectivePreferences([]);
    expect(list).toHaveLength(NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length);
    expect(find(list, 'PROCESS_RECEIVED', 'EMAIL')).toMatchObject({ enabled: true });
    expect(find(list, 'COMMENT_REPLY', 'EMAIL')).toMatchObject({ enabled: false });
    expect(find(list, 'COMMENT_REPLY', 'IN_APP')).toMatchObject({ enabled: true, editable: true });
  });

  it('a preferência salva vence o padrão, só na combinação a que se refere', () => {
    const stored: StoredPreference[] = [
      { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: true },
      { notificationType: 'MENTIONED', channel: 'IN_APP', enabled: false },
    ];
    const list = effectivePreferences(stored);
    expect(find(list, 'COMMENT_REPLY', 'EMAIL')?.enabled).toBe(true);
    expect(find(list, 'COMMENT_REPLY', 'IN_APP')?.enabled).toBe(true);
    expect(find(list, 'MENTIONED', 'IN_APP')?.enabled).toBe(false);
    expect(find(list, 'MENTIONED', 'EMAIL')?.enabled).toBe(true);
  });

  it('o in-app dos tipos obrigatórios fica ligado e não editável, mesmo com linha antiga desligada', () => {
    const list = effectivePreferences([
      { notificationType: 'APPROVAL_REQUESTED', channel: 'IN_APP', enabled: false },
    ]);
    for (const type of ['APPROVAL_REQUESTED', 'ATTACHMENT_REJECTED', 'ROLE_CHANGED']) {
      expect(find(list, type, 'IN_APP')).toMatchObject({ enabled: true, editable: false });
      expect(find(list, type, 'EMAIL')?.editable).toBe(true);
    }
  });
});

describe('Preferências de notificação — merge e trava (RN-NTF-23/25)', () => {
  it('registra de/para do estado salvo, com null = padrão do registro', () => {
    const deltas = planPreferenceChanges(
      [{ notificationType: 'MENTIONED', channel: 'EMAIL', enabled: false }],
      [
        { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
        { notificationType: 'MENTIONED', channel: 'EMAIL', enabled: null },
      ],
    );
    expect(deltas).toEqual([
      { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', from: null, to: false },
      { notificationType: 'MENTIONED', channel: 'EMAIL', from: false, to: null },
    ]);
  });

  it('reenviar o que já está salvo (ou o padrão sem linha) não altera nada', () => {
    const stored: StoredPreference[] = [
      { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
    ];
    expect(
      planPreferenceChanges(stored, [
        { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
        { notificationType: 'MENTIONED', channel: 'EMAIL', enabled: null },
      ]),
    ).toEqual([]);
  });

  it('desligar o in-app de tipo obrigatório é recusado e aponta o item do corpo', () => {
    const attempt = () =>
      planPreferenceChanges(
        [],
        [
          { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
          { notificationType: 'APPROVAL_REQUESTED', channel: 'IN_APP', enabled: false },
        ],
      );
    expect(attempt).toThrow(MandatoryChannelError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ notificationType: 'APPROVAL_REQUESTED', index: 1 });
    }
  });

  it('ligar ou restaurar o padrão de canal travado é no-op; o e-mail do tipo obrigatório é editável', () => {
    expect(
      planPreferenceChanges(
        [],
        [
          { notificationType: 'ROLE_CHANGED', channel: 'IN_APP', enabled: true },
          { notificationType: 'ROLE_CHANGED', channel: 'IN_APP', enabled: null },
        ],
      ),
    ).toEqual([]);
    expect(
      planPreferenceChanges(
        [],
        [{ notificationType: 'ROLE_CHANGED', channel: 'EMAIL', enabled: false }],
      ),
    ).toEqual([{ notificationType: 'ROLE_CHANGED', channel: 'EMAIL', from: null, to: false }]);
  });
});
