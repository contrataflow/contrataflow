# Dashboards do Grafana

Dashboards como código (JSON), carregados pelo provisionamento de
`../provisioning/dashboards/dashboards.yaml`. São os mesmos de produção (observability.md §9 e §11.1).

| Arquivo                 | Dashboard                                                                    | Story  |
| ----------------------- | ---------------------------------------------------------------------------- | ------ |
| `d1-api-overview.json`  | D1 — Visão geral da API (SLO, RED por classe, BFF × API, readiness, runtime) | US-085 |
| `d2-database.json`      | D2 — Banco de dados (pool, saúde do PostgreSQL, pg_stat_*, RDS)              | US-085 |
| `d3-queues-outbox.json` | D3 — Filas e Outbox (lag, FAILED, líder, filas, DLQ, breakers, schedulers)   | US-085 |

D4–D7 chegam com os domínios que os alimentam. Regras: consultas só por rótulos de conjunto
fechado — nunca tenant, usuário ou e-mail (`tools/test/observability-as-code.test.ts`); painel
"por tenant" (D7) consulta Loki/Tempo, nunca Prometheus. Edite o JSON aqui (o Grafana provisionado
não aceita alterações pela interface).
