import { SAVED_VIEW_LIMIT } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  applySavedViewPatch,
  canCreateSavedView,
  isSavedViewNameTaken,
  restoreSavedViewCriteria,
  savedViewAccess,
  savedViewNameKey,
} from './saved-view.js';
import type { SavedView } from './saved-view.js';

const OWNER = '0192d003-0000-7000-8000-0000000000c1';
const OTHER = '0192d003-0000-7000-8000-0000000000c2';
const AT = new Date('2026-10-05T12:00:00.000Z');

const view = (overrides: Partial<SavedView> = {}): SavedView => ({
  id: '0192d003-0000-7000-8000-0000000000d1',
  tenantId: '0192d003-0000-7000-8000-0000000000e1',
  ownerId: OWNER,
  scope: 'PROCESS_LIST',
  name: 'Atrasados por prioridade',
  filters: { v: 1, overdue: true },
  sort: '-priority',
  columns: ['code', 'title', 'status'],
  isShared: false,
  isDefault: false,
  createdAt: AT,
  updatedAt: AT,
  createdById: OWNER,
  updatedById: OWNER,
  version: 3,
  ...overrides,
});

describe('SavedView — invariantes (RN-PROC-34..38)', () => {
  it('nome único por dono e escopo sem diferenciar maiúsculas (ignora o próprio registro)', () => {
    expect(savedViewNameKey('  Atrasados  ')).toBe('atrasados');
    const views = [view()];
    expect(isSavedViewNameTaken(views, 'atrasados por PRIORIDADE')).toBe(true);
    expect(isSavedViewNameTaken(views, 'atrasados por PRIORIDADE', view().id)).toBe(false);
    expect(isSavedViewNameTaken(views, 'Outra')).toBe(false);
  });

  it('limite de 20 visões', () => {
    expect(canCreateSavedView(SAVED_VIEW_LIMIT - 1)).toBe(true);
    expect(canCreateSavedView(SAVED_VIEW_LIMIT)).toBe(false);
  });

  it('posse: dono altera; compartilhada de outro é leitura; privada de outro não existe', () => {
    expect(savedViewAccess(view(), OWNER)).toBe('OWNER');
    expect(savedViewAccess(view({ isShared: true }), OTHER)).toBe('SHARED');
    expect(savedViewAccess(view(), OTHER)).toBe('HIDDEN');
  });

  it('restauração: upcaster dos filtros e colunas desconhecidas descartadas', () => {
    expect(
      restoreSavedViewCriteria({
        filters: { v: 1, year: [2026] },
        columns: ['code', 'x', 'title'],
      }),
    ).toEqual({ filters: { v: 1, year: [2026] }, columns: ['code', 'title'] });
    expect(restoreSavedViewCriteria({ filters: { v: 7 }, columns: null })).toEqual({
      filters: { v: 1 },
      columns: [],
    });
  });
});

describe('applySavedViewPatch (PRC-37)', () => {
  it('aplica os campos informados com nova versão e autoria', () => {
    const later = new Date('2026-10-06T12:00:00.000Z');
    const result = applySavedViewPatch(
      view(),
      {
        name: 'Novo',
        isDefault: true,
        isShared: true,
        sort: null,
        columns: ['code', 'title'],
        filters: { v: 1 },
      },
      { at: later, userId: OWNER },
    );
    expect(result.changed).toBe(true);
    expect(result.view).toMatchObject({
      name: 'Novo',
      isDefault: true,
      isShared: true,
      sort: null,
      columns: ['code', 'title'],
      filters: { v: 1 },
      version: 4,
      updatedAt: later,
    });
  });

  it('PATCH idêntico não muda nada (sem nova versão)', () => {
    const current = view();
    const result = applySavedViewPatch(
      current,
      { name: current.name, filters: { v: 1, overdue: true }, sort: '-priority' },
      { at: new Date(), userId: OWNER },
    );
    expect(result).toEqual({ view: current, changed: false });
  });
});
