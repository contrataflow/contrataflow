import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_GROUP_WINDOW_MS,
  NOTIFICATION_MAX_GROUPED_EVENTS,
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TYPES,
  decideEmailStatus,
  decideNotificationGrouping,
  isNotificationType,
  isRelativeNotificationLink,
  notificationGroupKey,
  scrubNotificationText,
} from './notifications.js';
import type { GroupingCandidate, NotificationType } from './notifications.js';

const EVENTS_DOC = fileURLToPath(new URL('../../../docs/mvp-01/events.md', import.meta.url));

interface DocumentedType {
  readonly type: string;
  readonly origin: string;
  readonly email: boolean;
  readonly mandatory: boolean;
}

/**
 * Tipos de events.md §6 já especificados cujas stories produtoras ainda não foram implementadas
 * (EP-020 — IA): entram no registro com elas, que removem o tipo daqui.
 */
const PENDING_DOCUMENTED_TYPES: Readonly<Record<string, string>> = {
  AI_GENERATION_READY: 'US-115',
  AI_GENERATION_FAILED: 'US-115',
  AI_USAGE_LIMIT_WARNING: 'US-116',
};

/** Linhas da tabela de events.md §6 (fonte canônica do registro `NotificationType`). */
function documentedTypes(): DocumentedType[] {
  const doc = readFileSync(EVENTS_DOC, 'utf8');
  const section = doc.slice(
    doc.indexOf('## 6. Notificações derivadas de eventos'),
    doc.indexOf('## 7. Catálogo'),
  );
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return {
        type: (cells[1] ?? '').replaceAll('`', ''),
        origin: cells[2] ?? '',
        email: (cells[4] ?? '').includes('✔'),
        mandatory: (cells[5] ?? '').includes('sim'),
      };
    })
    .filter((row) => /^[A-Z_]+$/.test(row.type) && !(row.type in PENDING_DOCUMENTED_TYPES));
}

const EVENT = '0192f111-0000-7000-8000-00000000e001';
const OTHER = '0192f111-0000-7000-8000-00000000e002';
const NOW = new Date('2026-10-15T12:00:00Z');

function candidate(overrides: Partial<GroupingCandidate> = {}): GroupingCandidate {
  return {
    id: '0192f111-0000-7000-8000-0000000000a1',
    sourceEventId: OTHER,
    groupedEventIds: [],
    createdAt: new Date(NOW.getTime() - 2 * 60_000),
    archivedAt: null,
    ...overrides,
  };
}

describe('registro NotificationType (events.md §6 · US-111)', () => {
  it('cobre exatamente os tipos da tabela de events.md §6', () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      documentedTypes()
        .map((t) => t.type)
        .sort(),
    );
  });

  it.each(documentedTypes())('$type: e-mail padrão, obrigatoriedade e eventos de origem', (doc) => {
    const definition = NOTIFICATION_REGISTRY[doc.type as NotificationType];
    expect(definition.emailByDefault).toBe(doc.email);
    expect(definition.mandatory).toBe(doc.mandatory);
    // O documento abrevia irmãos (`ApprovalCompleted`/`Returned`): basta o sufixo depois do agregado.
    for (const eventType of definition.sourceEvents) {
      const suffix = eventType.replace(/^[A-Z][a-z]+/, '');
      expect(doc.origin.includes(`\`${eventType}\``) || doc.origin.includes(`\`${suffix}\``)).toBe(
        true,
      );
    }
  });

  it('lembretes de prazo ficam com a US-114; o resto é do dispatcher da US-111', () => {
    const deferred = NOTIFICATION_TYPES.filter(
      (type) => NOTIFICATION_REGISTRY[type].dispatchedBy === 'US-114',
    );
    expect(deferred).toEqual(['STAGE_DUE_SOON', 'STAGE_OVERDUE']);
  });

  it('valida o código e cabe em varchar(60)', () => {
    expect(isNotificationType('PROCESS_RETURNED')).toBe(true);
    expect(isNotificationType('process_returned')).toBe(false);
    expect(isNotificationType(42)).toBe(false);
    for (const type of NOTIFICATION_TYPES) expect(type.length).toBeLessThanOrEqual(60);
  });
});

describe('agrupamento de 5 minutos (RN-NTF-03/04)', () => {
  it('groupKey = {type}:{processId}; sem processo não agrupa', () => {
    expect(notificationGroupKey('COMMENT_REPLY', 'p-1')).toBe('COMMENT_REPLY:p-1');
    expect(notificationGroupKey('ROLE_CHANGED', null)).toBeNull();
  });

  it('sem candidata → nova linha', () => {
    expect(decideNotificationGrouping(null, EVENT, NOW)).toEqual({ kind: 'insert' });
  });

  it('candidata recente absorve o evento novo', () => {
    expect(decideNotificationGrouping(candidate(), EVENT, NOW)).toEqual({
      kind: 'group',
      notificationId: candidate().id,
    });
  });

  it('evento já presente (primeiro ou agrupado) é reentrega, mesmo fora da janela', () => {
    const old = { createdAt: new Date(NOW.getTime() - 60 * 60_000) };
    expect(
      decideNotificationGrouping(candidate({ sourceEventId: EVENT, ...old }), EVENT, NOW),
    ).toMatchObject({ kind: 'duplicate' });
    expect(
      decideNotificationGrouping(candidate({ groupedEventIds: [EVENT], ...old }), EVENT, NOW),
    ).toMatchObject({ kind: 'duplicate' });
  });

  it('fronteira: 4:59,999 agrupa; exatamente 5 min abre outra', () => {
    const at = (ms: number) => candidate({ createdAt: new Date(NOW.getTime() - ms) });
    expect(decideNotificationGrouping(at(NOTIFICATION_GROUP_WINDOW_MS - 1), EVENT, NOW).kind).toBe(
      'group',
    );
    expect(decideNotificationGrouping(at(NOTIFICATION_GROUP_WINDOW_MS), EVENT, NOW).kind).toBe(
      'insert',
    );
  });

  it('candidata arquivada, do futuro ou com o grupo cheio → nova linha', () => {
    expect(decideNotificationGrouping(candidate({ archivedAt: NOW }), EVENT, NOW).kind).toBe(
      'insert',
    );
    expect(
      decideNotificationGrouping(
        candidate({ createdAt: new Date(NOW.getTime() + 1_000) }),
        EVENT,
        NOW,
      ).kind,
    ).toBe('insert');
    const full = Array.from(
      { length: NOTIFICATION_MAX_GROUPED_EVENTS },
      (_, index) => `0192f111-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(decideNotificationGrouping(candidate({ groupedEventIds: full }), EVENT, NOW).kind).toBe(
      'insert',
    );
  });
});

describe('emailStatus (RN-NTF-05)', () => {
  it('preferência ausente segue o padrão do registro', () => {
    expect(
      decideEmailStatus({
        type: 'PROCESS_RETURNED',
        emailPreference: undefined,
        tenantEmailEnabled: true,
      }),
    ).toBe('PENDING');
    expect(
      decideEmailStatus({
        type: 'COMMENT_REPLY',
        emailPreference: undefined,
        tenantEmailEnabled: true,
      }),
    ).toBe('NOT_APPLICABLE');
  });

  it('preferência do usuário prevalece sobre o padrão', () => {
    expect(
      decideEmailStatus({ type: 'COMMENT_REPLY', emailPreference: true, tenantEmailEnabled: true }),
    ).toBe('PENDING');
    expect(
      decideEmailStatus({
        type: 'PROCESS_RETURNED',
        emailPreference: false,
        tenantEmailEnabled: true,
      }),
    ).toBe('NOT_APPLICABLE');
  });

  it('e-mail desligado no tenant → SKIPPED', () => {
    expect(
      decideEmailStatus({
        type: 'PROCESS_RETURNED',
        emailPreference: undefined,
        tenantEmailEnabled: false,
      }),
    ).toBe('SKIPPED');
  });
});

describe('conteúdo (RN-NTF-07/08)', () => {
  it('mascara valores monetários e corta no limite', () => {
    expect(scrubNotificationText('Valor estimado R$ 1.234.567,89 no ETP', 200)).toBe(
      'Valor estimado R$ ••• no ETP',
    );
    expect(scrubNotificationText('a'.repeat(30), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(scrubNotificationText('  curto  ', 10)).toBe('curto');
  });

  it('link só como rota relativa, sem esquema, query ou `//`', () => {
    expect(isRelativeNotificationLink('/processos/0192f111-0000-7000-8000-000000000001')).toBe(
      true,
    );
    expect(isRelativeNotificationLink('https://evil.test/x')).toBe(false);
    expect(isRelativeNotificationLink('//evil.test')).toBe(false);
    expect(isRelativeNotificationLink('/processos/1?token=abc')).toBe(false);
    expect(isRelativeNotificationLink(`/${'a'.repeat(600)}`)).toBe(false);
  });
});
