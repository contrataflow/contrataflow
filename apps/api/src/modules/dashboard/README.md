# `dashboard`

Indicadores operacionais — somente consultas agregadas sobre views publicadas (DEC-040, DEC-088).

- **US-076 (DSH-01/DSH-02):** `DashboardController` → `GetDashboardSummaryHandler` /
  `GetDashboardWidgetHandler`. Um resolvedor por `DashboardWidgetKey` em `DashboardWidgetRegistry`
  (`application/dashboard-widgets.ts`); cada um faz UMA leitura do `DashboardReader` e resolve os
  nomes por lote (`WorkflowFacade.releasedStages`, `OrganizationFacade.departmentNames`).
- **Regras puras** em `domain/dashboard.ts` (RN-DASH-04..08 e POL-09 nos agregados), repetidas
  predicado a predicado pelo SQL de `infrastructure/dashboard.sql.ts` sobre as views
  `security_invoker` da migração `20261020090000_dashboard_views` (`v_dashboard_processes`,
  `v_dashboard_stage_passages`, `v_dashboard_timeline`). Toda instrução compõe o predicado de
  visibilidade único (`buildVisibilityPredicate` — DEC-024) e o recorte dos filtros; POL-09 pelo
  predicado compartilhado `buildConfidentialBudgetPredicate`.
- **Pendências (`PENDING_ITEMS` e `pendingCount`):** `InboxFacade.countersIn` — os mesmos
  predicados e a mesma instrução de TSK-02 (RN-DASH-03), com o recorte dos filtros. Exceção de nível
  `dashboard → inbox` registrada em DEC-088 e em `tools/module-levels.json`.
- **Filtros (`DashboardContextResolver.scopeOf`):** unidade solicitante — secretaria
  (`SECRETARIAT`/`BOARD` ou raiz) e setor com a subárvore (`OrganizationFacade.subtreeDepartmentIds`);
  validados ANTES do cache (422 nunca vem do cache).
- **Cache (`DashboardCache`):** `TenantCache`, chave `{userId}:{widget}:{sha256 dos filtros}`, TTL
  60 s; `meta.cache.hit`/`expiresAt` na resposta. Redis fora → `warn dashboard.cache_unavailable` e
  cálculo direto no banco.
- **Observabilidade:** `info dashboard.widget_served`, `warn dashboard.widget_slow` (> 800 ms),
  `error dashboard.widget_failed`; métricas `cf_dashboard_widget_duration_ms{widget,outcome,cache}` e
  `cf_dashboard_cache_lookups_total{widget,result}`. Nunca valores monetários nem títulos.
- **Índices (decisão do DoD):** `process_stages_exited_idx` e
  `process_timeline_entries_tenant_recent_idx` (DEC-088).
- **Testes:** `domain/*.spec.ts`, `application/*.spec.ts`, `presentation/dashboard.routes.spec.ts`
  (8 categorias do Gherkin pelo pipeline HTTP, leitor em memória) e
  `test/tenant-leak/dashboard.spec.ts` (PostgreSQL real: SQL, RLS das views, POL-09, consistência com
  TSK-02 e concorrência).
