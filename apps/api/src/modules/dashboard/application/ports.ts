import type { ProcessStatus } from '@contrataflow/validation';

import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  DashboardActivityRow,
  DashboardBudgetViewer,
  DashboardProcessCounts,
  DashboardScope,
  DashboardWindow,
  SecretariatValue,
  StageDuration,
} from '../domain/dashboard.js';

/*
 * Portas do módulo `dashboard` (US-076): a leitura agregada (`DashboardReader` — SQL sobre
 * PostgreSQL ou memória no modo fake), a transação de leitura e o relógio.
 */

/** Quem consulta, resolvido uma vez por requisição (DEC-024 + POL-09). */
export interface DashboardViewer {
  readonly userId: string;
  readonly visibility: ProcessVisibilityScope;
  readonly historicalDepartmentsCanView: boolean;
  readonly budget: DashboardBudgetViewer;
}

/** Uma consulta de indicador: quem, o recorte e os instantes de referência. */
export interface DashboardSearch {
  readonly viewer: DashboardViewer;
  readonly scope: DashboardScope;
  readonly window: DashboardWindow;
}

/** Contagem por chave (etapa, secretaria, mês…). */
export interface KeyedCount {
  readonly key: string;
  readonly value: number;
}

export type DashboardActivity = DashboardActivityRow & { readonly processCode: string | null };

/** Cada método é UMA instrução, sempre sobre os processos visíveis e recortados (RN-DASH-01/09). */
export interface DashboardReader {
  /** DSH-01: atrasados, a vencer e abertos (mesmo snapshot). */
  processCounts(tx: TenantTx, search: DashboardSearch): Promise<DashboardProcessCounts>;
  /** `BY_STATUS`: contagem por status (os ausentes ficam de fora). */
  countByStatus(tx: TenantTx, search: DashboardSearch): Promise<Map<ProcessStatus, number>>;
  /** `BY_STAGE`: abertos por etapa atual. */
  countByStage(tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]>;
  /** `OVERDUE`/`DUE_SOON`: por secretaria solicitante. */
  countDeadlinesBySecretariat(
    tx: TenantTx,
    search: DashboardSearch,
    kind: 'OVERDUE' | 'DUE_SOON',
  ): Promise<KeyedCount[]>;
  /** `AVG_STAGE_DURATION` (RN-DASH-05). */
  averageStageDurations(tx: TenantTx, search: DashboardSearch): Promise<StageDuration[]>;
  /** `OPENED_BY_MONTH` (RN-DASH-06): só os meses com processos (`key` = `YYYY-MM`). */
  openedByMonth(tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]>;
  /** `VALUE_BY_SECRETARIAT` (RN-DASH-07 · POL-09). */
  valueBySecretariat(tx: TenantTx, search: DashboardSearch): Promise<SecretariatValue[]>;
  /** `RECENT_ACTIVITY` (RN-DASH-08): as `limit` mais recentes, já sem as restritas não visíveis. */
  recentActivity(
    tx: TenantTx,
    search: DashboardSearch,
    limit: number,
  ): Promise<DashboardActivity[]>;
}

export interface DashboardTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export type DashboardClock = () => Date;

export const DASHBOARD_READER = Symbol('DashboardReader');
export const DASHBOARD_TRANSACTIONS = Symbol('DashboardTransactions');
export const DASHBOARD_CLOCK = Symbol('DashboardClock');
