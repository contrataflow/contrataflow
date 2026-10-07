---
id: FT-049
title: "Observabilidade"
epic: EP-015
mvp: 1
priority: P0
stories: [US-084, US-085]
status: Especificada
---

# FT-049 — Observabilidade

## Título
Observabilidade

## Épico
EP-015 — Fundação técnica

## Descrição
Entrega a capacidade de diagnosticar qualquer incidente da plataforma a partir de um único `correlationId`: logs estruturados, propagação de `correlationId`/`traceparent` e tracing distribuído via OpenTelemetry (US-084); e a capacidade de observar a saúde agregada da plataforma: health checks por dependência, métricas RED/USE em `/metrics`, dashboards técnicos como código e os alertas de maior severidade (US-085).

## Valor para o usuário e para o órgão
- Reduz o tempo médio de diagnóstico de incidente (MTTR) ao permitir que o suporte peça só o `correlationId` ao usuário.
- Reduz o risco de vazamento de dado pessoal/sigiloso em log ou métrica (redação automática, sem label de tenant).
- Dá à operação visibilidade proativa (dashboards/alertas) antes que um incidente afete o usuário final.

## Personas
- Pessoa desenvolvedora backend — instrumenta logs/spans de negócio sobre a base desta feature.
- Pessoa operadora/SRE — consome dashboards, recebe alertas, diagnostica pelo `correlationId`.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-084 | Logs estruturados, correlationId e tracing | P0 | M | US-080 |
| US-085 | Health checks, métricas e dashboards técnicos | P1 | M | US-080, US-083 |

## Escopo
- pino (JSON/stdout) com campos obrigatórios e redação (DEC-138); `correlationId` validado/gerado e propagado ponta a ponta; OpenTelemetry SDK com instrumentações e *tail sampling*; spans de negócio manuais.
- `/health/live` e `/health/ready` por aplicação com matriz de criticidade (CA-T-07); `/metrics` em Prometheus sem label de tenant; dashboards D1–D3; alertas A01/A02/A04.

## Fora de escopo
- Logs de auditoria de negócio (`AuditLog`) — não são trilha de auditoria; ficam a cargo de cada módulo de negócio (ADR-009).
- Dashboards D4–D7 (documentos/PDF, autenticação real, negócio, por tenant) — entram com as stories que introduzirem cada domínio.

## Regras de negócio da feature
- RN-FND-71 a RN-FND-78 (US-084): formato pino, níveis, redação DEC-138, `correlationId`, SDK OpenTelemetry, propagação W3C, amostragem, spans de negócio.
- RN-FND-79 a RN-FND-86 (US-085): `/health/live`/`/health/ready`, formato `health+json`, matriz de criticidade, `/metrics` sem label de tenant, catálogo mínimo RED/USE, dashboards como código, investigação por tenant só via logs/traces, alertas A01/A02/A04.

## Telas
Não aplicável — dashboards técnicos (Grafana) não fazem parte de `apps/web`.

## Endpoints
- HLT-01 `GET /health/live` — processo vivo.
- HLT-02 `GET /health/ready` — pronto para tráfego, por dependência.
- HLT-03 `GET /metrics` — métricas Prometheus (porta interna).

## Entidades
Não aplicável — nenhuma tabela de negócio nesta feature.

## Eventos
Não aplicável — a observabilidade consome o que as demais features já emitem (logs/métricas/traces); não produz evento de domínio.

## Permissões
Não aplicável — `/health/*` e `/metrics` são de rede interna, sem RBAC de aplicação.

## Dependências
- Depende de FT-048 (pipeline de requisição da US-080 e worker/filas da US-083). Habilita a operação confiável de toda feature de produto a partir do MVP 1 e dá a FT-050 o mesmo padrão de `correlationId` do lado do cliente.

## Critérios de aceite da feature
```gherkin
Feature: Observabilidade
  Scenario: Jornada ponta a ponta de diagnóstico por correlationId
    Given que uma requisição de exemplo dispara um job assíncrono
    When o operador buscar pelo "correlationId" da requisição
    Then devem ser encontrados o log da requisição, o log do job e o trace que os liga
    And o painel "Visão geral da API" deve refletir a mesma requisição nas métricas RED
```

## Métricas de sucesso
- 100% das requisições de exemplo e jobs de teste correlacionáveis por `correlationId`/`traceId`.
- Zero série de métrica com label de tenant (teste de regressão de cardinalidade, contínuo no CI).

## Riscos
- Exportador de traces/métricas indisponível mascara um incidente real por falta de dado — mitigado por log `warn` local de falha de exportação e por acompanhamento operacional de ausência de dado.
- Health check agressivo do orquestrador sem cache sobrecarrega dependências — mitigado pelo cache de 5 s (RN-FND-80).

## Definition of Done da feature
- [ ] Story P0 (US-084) concluída e aceita; US-085 (P1) concluída e aceita
- [ ] Jornada E2E da feature automatizada (correlationId ponta a ponta + dashboards D1–D3)
- [ ] Documentação atualizada (`observability.md`, checklist de observabilidade §14 referenciado pelas stories seguintes)
