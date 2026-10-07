---
id: FT-048
title: "Arquitetura base da API"
epic: EP-015
mvp: 1
priority: P0
stories: [US-080, US-081, US-082, US-083]
status: Especificada
---

# FT-048 — Arquitetura base da API

## Título
Arquitetura base da API

## Épico
EP-015 — Fundação técnica

## Descrição
Entrega o esqueleto modular da API NestJS (DEC-040/041) com os mecanismos transversais de requisição (erro RFC 9457, guards, `RequestContext`, idempotência, *throttling*, paginação, OpenAPI — US-080); a camada de persistência Prisma com RLS, FKs compostas por tenant e concorrência otimista (US-081); a emissão de eventos de domínio via outbox transacional com relay e fan-out (US-082); e o worker standalone que consome as filas, trata falhas e expõe administração via Bull Board (US-083).

Juntas, essas quatro stories formam o "miolo" da API sobre o qual toda regra de negócio do MVP 1 é implementada: nenhuma tabela, rota ou evento de produto existe antes desta feature.

## Valor para o usuário e para o órgão
- Garante isolamento de tenant por construção (RLS + FKs compostas), reduzindo o risco de vazamento de dados entre órgãos a zero por padrão, não por disciplina de código.
- Garante que toda mudança de estado de negócio seja auditável e propagável de forma confiável (outbox transacional, entrega *at-least-once* com deduplicação).
- Garante consistência de contrato de erro/paginação entre todas as ~100 rotas de negócio futuras, reduzindo retrabalho de integração do frontend.

## Personas
- Pessoa desenvolvedora backend (`equipe de engenharia`) — constrói cada módulo de negócio sobre este esqueleto.
- Pessoa desenvolvedora frontend — consome o contrato de erro/paginação já estável.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-080 | Esqueleto da API modular | P0 | L | US-077 |
| US-081 | Persistência com Prisma e concorrência otimista | P0 | M | US-078, US-080 |
| US-082 | Eventos de domínio com outbox transacional | P0 | L | US-081 |
| US-083 | Worker com filas, retries e dead letter | P0 | M | US-082 |

## Escopo
- Módulos de DEC-040 com as quatro camadas de DEC-041 (vazios, registrados); filtro de erro, guards (autenticação/tenant/vínculo), `AsyncLocalStorage`, idempotência, *throttling*, paginação, geração de OpenAPI.
- Prisma com `@map`, UUIDv7, `Decimal`, coluna `version` para concorrência otimista, `TenantTransaction` (`set_config` local), SQL bruto para RLS/triggers/partições, papéis de banco (`cf_owner`, `cf_app`, `cf_worker`, `cf_relay`).
- `OutboxWriter`, envelope de evento (DEC-160), handlers síncronos (timeline, `ProcessAccess`), relay com líder único e `SKIP LOCKED`, fan-out por `routingKey`, purga.
- Worker standalone, contrato de job (`meta`+`payload`), classificação de erro, `dead-letter`, *schedulers* únicos, Bull Board.

## Fora de escopo
- Qualquer entidade, regra ou endpoint de negócio de produto (EP-001 a EP-014) — usam este esqueleto, não o estendem aqui.
- Observabilidade de logs/tracing/métricas sobre este esqueleto — FT-049.

## Regras de negócio da feature
- RN-FND-29 a RN-FND-38 (US-080): módulos/camadas, config validada, filtro de erro, validação Zod, ordem dos guards, `RequestContext`, idempotência, *throttling*, paginação, OpenAPI determinístico.
- RN-FND-39 a RN-FND-48 (US-081): UUIDv7, `@map`, `Decimal`+`decimal.js`, coluna `version`, `TenantTransaction`, proibição de `set_config` de sessão, RLS por migração, papéis de banco, SQL bruto versionado, pool compatível com `PgBouncer`.
- RN-FND-49 a RN-FND-60 (US-082): escrita na mesma transação, envelope DEC-160, nomes especializados sem linha própria, handlers síncronos restritos, auditoria independente do outbox, líder único, lote `SKIP LOCKED`, papel `cf_relay`, backoff e `FAILED` após 10 tentativas, fan-out idempotente, purga, garantia *at-least-once*.
- RN-FND-61 a RN-FND-70 (US-083): worker standalone, política padrão de filas (DEC-163), contrato de job (DEC-164), `runJob`, limite de 16 KB sem dado sensível, classificação de erro, `dead-letter` antes de relançar, *schedulers* únicos, Bull Board com `PLATFORM_QUEUE_ADMIN` + MFA, métricas mínimas por fila.

## Telas
Não aplicável — feature de backend puro, sem interface própria.

## Endpoints
Não aplicável como endpoints de negócio — esta feature não cria nenhum ID do catálogo `api.md` §3; entrega os mecanismos que todo endpoint futuro usa.

## Entidades
- `OutboxEvent` (dono, módulo `platform`) — única tabela de negócio desta feature.
- Módulos de DEC-040 registrados como esqueleto (sem tabela própria ainda).

## Eventos
Mecanismo de evento de domínio (envelope DEC-160, fan-out) pronto para uso; nenhum evento de produto é emitido por esta feature.

## Permissões
- `PLATFORM_QUEUE_ADMIN` — acesso ao Bull Board (US-083).

## Dependências
- Depende de FT-047 (monorepo, ambiente, CI). Habilita FT-049 (observabilidade instrumenta este esqueleto) e FT-050 (frontend consome o contrato de erro/paginação); habilita, por transitividade, toda feature de produto do MVP 1.

## Critérios de aceite da feature
```gherkin
Feature: Arquitetura base da API
  Scenario: Jornada ponta a ponta do esqueleto ao worker
    Given que a API sobe com todos os módulos de DEC-040 registrados
    When uma rota de exemplo disparar um evento de domínio de teste
    Then o evento deve ser gravado no outbox na mesma transação
    And o relay deve publicá-lo e o worker deve processá-lo com sucesso
```

## Métricas de sucesso
- Overhead do pipeline de requisição (guards + contexto + throttler): < 10 ms p95 sobre rota vazia (KPI do épico).
- Lag do outbox (item mais antigo pendente): sob o limite do alerta A05 desde o primeiro dia de uso em homologação.

## Riscos
- RLS mal configurada em alguma tabela futura permite leitura cross-tenant — mitigado por checagem de catálogo no CI (RN-FND-45) e pela suíte "tenant leak" (US-079).
- Relay com líder único sob falha do processo líder atrasa todo o fan-out — mitigado por alertas A05–A07 e runbook RB-01.

## Definition of Done da feature
- [ ] Todas as stories (US-080 a US-083) concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (rota de exemplo → outbox → relay → worker)
- [ ] Documentação atualizada (`architecture.md` §5–§7, `queues.md`, `multi-tenancy.md`)
