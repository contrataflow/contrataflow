// US-085 — verificação estática da observabilidade versionada: dashboards D1–D3 (RN-FND-84),
// recording rules e alertas A01/A02/A04 com severidade/canal/dono/runbook (RN-FND-86), inibições
// contra cascata, `/metrics` coletado só nas portas internas (V-03) e nenhuma consulta por tenant
// em métrica (RN-FND-85 · "[Tenant incorreto]").
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { REPO_ROOT } from '../lib/workspace.js';

const OBS = 'infra/observability';
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

interface Rule {
  readonly record?: string;
  readonly alert?: string;
  readonly expr: string;
  readonly for?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
}

interface RuleFile {
  readonly groups: readonly { readonly name: string; readonly rules: readonly Rule[] }[];
}

interface Target {
  readonly expr?: string;
}

interface Panel {
  readonly type: string;
  readonly title: string;
  readonly targets?: readonly Target[];
  readonly gridPos: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly editable: boolean;
  readonly annotations: {
    readonly list: readonly { readonly name: string; readonly expr: string }[];
  };
  readonly panels: readonly Panel[];
}

const rules = (file: string) =>
  (parse(read(`${OBS}/rules/${file}`)) as RuleFile).groups.flatMap((g) => g.rules);
const recording = rules('slo.rules.yml');
const alerts = rules('alerts.rules.yml');

const dashboardFiles = readdirSync(path.join(REPO_ROOT, OBS, 'grafana/dashboards')).filter((f) =>
  f.endsWith('.json'),
);
const dashboards = dashboardFiles.map(
  (file) => JSON.parse(read(`${OBS}/grafana/dashboards/${file}`)) as Dashboard,
);

/** Rótulos de cardinalidade aberta proibidos em consultas de métrica (RN-FND-82/85). */
const FORBIDDEN_IN_PROMQL = /tenant|user_?id|e-?mail|process_?id|event_?id/i;

describe('dashboards como código (RN-FND-84)', () => {
  it('D1, D2 e D3 existem, com uid único e somente leitura', () => {
    const titles = dashboards.map((d) => d.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'D1 — Visão geral da API',
        'D2 — Banco de dados',
        'D3 — Filas e Outbox',
      ]),
    );
    expect(new Set(dashboards.map((d) => d.uid)).size).toBe(dashboards.length);
    for (const dashboard of dashboards) expect(dashboard.editable).toBe(false);
  });

  it('todo dashboard tem a anotação de deploy (cf_build_info)', () => {
    for (const dashboard of dashboards) {
      expect(dashboard.annotations.list.map((a) => a.name)).toContain('Deploys');
      expect(dashboard.annotations.list[0]?.expr).toContain('cf_build_info');
    }
  });

  it('[Tenant incorreto] nenhum painel consulta métrica por tenant, usuário ou e-mail', () => {
    for (const dashboard of dashboards) {
      for (const panel of dashboard.panels) {
        for (const target of panel.targets ?? []) {
          expect(target.expr ?? '', `${dashboard.uid} · ${panel.title}`).not.toMatch(
            FORBIDDEN_IN_PROMQL,
          );
        }
      }
    }
  });

  it('painéis com consulta e dentro da grade de 24 colunas', () => {
    for (const dashboard of dashboards) {
      const panels = dashboard.panels.filter((p) => p.type !== 'row');
      expect(panels.length).toBeGreaterThan(5);
      for (const panel of panels) {
        expect(panel.targets?.length, panel.title).toBeGreaterThan(0);
        expect(panel.gridPos.x + panel.gridPos.w).toBeLessThanOrEqual(24);
      }
    }
  });

  it('D1 cobre SLI, orçamento, queima, RED por classe, BFF × API e readiness', () => {
    const d1 = dashboards.find((d) => d.uid === 'cf-d1-api');
    const exprs = d1?.panels.flatMap((p) => p.targets ?? []).map((t) => t.expr ?? '') ?? [];
    for (const needle of [
      'cf:slo_availability_errors:ratio_rate1h',
      'cf:slo_latency_p95',
      'slo_class',
      'http_client_request_duration_seconds',
      'cf:health_ready:ratio',
      'nodejs_eventloop_delay_p99_seconds',
    ]) {
      expect(
        exprs.some((expr) => expr.includes(needle)),
        needle,
      ).toBe(true);
    }
  });
});

describe('recording rules e alertas (RN-FND-83/86)', () => {
  it('registra o p95 por classe e as janelas de erro do SLO-01', () => {
    const names = recording.map((r) => r.record);
    expect(names).toEqual(
      expect.arrayContaining([
        'cf:slo_latency_p95',
        'cf:slo_availability_errors:ratio_rate5m',
        'cf:slo_availability_errors:ratio_rate1h',
        'cf:slo_availability_errors:ratio_rate6h',
        'cf:health_ready:ratio',
      ]),
    );
  });

  it('A01, A02 e A04 configurados com severidade, canal, dono e runbook RB-06', () => {
    const doc = read('docs/architecture/observability.md');
    const byId = (id: string) => alerts.filter((a) => a.labels?.alert_id === id);
    expect(byId('A01')[0]?.labels).toMatchObject({ severity: 'critical', channel: 'oncall' });
    expect(byId('A02')[0]?.labels).toMatchObject({ severity: 'high', channel: 'oncall' });
    expect(byId('A04').map((a) => a.labels?.severity)).toEqual(['critical', 'critical']);
    for (const alert of alerts) {
      expect(alert.labels?.owner, alert.alert).toBeTruthy();
      expect(alert.for, alert.alert).toBeTruthy();
      const runbook = alert.annotations?.runbook_url ?? '';
      expect(runbook).toMatch(/^docs\/architecture\/observability\.md#rb-06--/);
      expect(doc).toContain('### RB-06 — Indisponibilidade ou 5xx da API');
    }
    expect(byId('A01')[0]?.expr).toMatch(/14\.4 \* 0\.005[\s\S]*14\.4 \* 0\.005/);
    expect(byId('A04')[0]?.expr).toContain('< 0.5');
    expect(byId('A04')[0]?.for).toBe('3m');
  });

  it('[Tenant incorreto] nenhuma regra agrega por tenant', () => {
    for (const rule of [...recording, ...alerts])
      expect(rule.expr).not.toMatch(FORBIDDEN_IN_PROMQL);
  });

  it('inibições: A01 cala A02; PostgreSQL fora cala os alertas de fila e outbox', () => {
    const config = parse(read(`${OBS}/alertmanager.yml`)) as {
      readonly inhibit_rules: readonly {
        readonly source_matchers: readonly string[];
        readonly target_matchers: readonly string[];
      }[];
      readonly route: {
        readonly routes: readonly {
          readonly matchers: readonly string[];
          readonly receiver: string;
        }[];
      };
    };
    const rulesText = config.inhibit_rules.map((r) => JSON.stringify(r));
    expect(rulesText.some((r) => r.includes('A01') && r.includes('A02'))).toBe(true);
    expect(rulesText.some((r) => r.includes('postgresql') && r.includes('A05'))).toBe(true);
    expect(
      config.route.routes.find((r) => r.matchers.includes('severity="critical"'))?.receiver,
    ).toBe('oncall-24x7');
  });
});

describe('coleta de /metrics (RN-FND-82 · V-03)', () => {
  const prometheus = parse(read(`${OBS}/prometheus.yml`)) as {
    readonly global: { readonly scrape_interval: string };
    readonly rule_files: readonly string[];
    readonly scrape_configs: readonly {
      readonly job_name: string;
      readonly static_configs: readonly { readonly targets: readonly string[] }[];
    }[];
  };

  it('coleta a cada 15 s, carrega as regras e usa só as portas internas METRICS_PORT', () => {
    expect(prometheus.global.scrape_interval).toBe('15s');
    expect(prometheus.rule_files).toEqual(['/etc/prometheus/rules/*.yml']);
    const targets = Object.fromEntries(
      prometheus.scrape_configs
        .filter((job) => job.job_name.startsWith('contrataflow-'))
        .map((job) => [job.job_name, job.static_configs.flatMap((c) => c.targets)]),
    );
    expect(targets).toEqual({
      'contrataflow-api': ['host.docker.internal:9464'],
      'contrataflow-worker': ['host.docker.internal:9465'],
      'contrataflow-web': ['host.docker.internal:9466'],
    });
  });

  it('o Compose monta as regras no Prometheus local', () => {
    expect(read('infra/compose/observability.yml')).toContain(
      './observability/rules:/etc/prometheus/rules:ro',
    );
  });
});
