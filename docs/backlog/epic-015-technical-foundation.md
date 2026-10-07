---
id: EP-015
title: "Fundação técnica"
mvp: 1
priority: P0
features: [FT-047, FT-048, FT-049, FT-050]
status: Especificado
---

# EP-015 — Fundação técnica

## Título
Fundação técnica

## Objetivo
Entregar a base técnica (monorepo, ambiente local, CI, esqueleto da API, persistência, eventos de domínio, worker, observabilidade e shell web) sobre a qual toda story de negócio do MVP 1 (EP-001 a EP-014) e os demais épicos de plataforma (EP-016 a EP-019) são construídos, com os contratos transversais (erro, autenticação, multi-tenancy, concorrência, idempotência, logging, tracing, design system) já estáveis antes da primeira tela ou rota de negócio.

## Contexto e problema
Diferente dos épicos de produto, o EP-015 não nasce de uma dor relatada pelo usuário final: nasce da necessidade de todos os demais épicos (de produto e de plataforma) terem uma base técnica consistente para não reinventar, a cada story, como a API erra, autentica, isola tenant, controla concorrência e se observa — padrões já fixados em `architecture.md`, `decisions.md` (DEC-040, DEC-041, DEC-050, DEC-051, DEC-080 a DEC-108) e `security.md`. Sem esta fundação, cada módulo de negócio implementaria esses mecanismos de forma distinta, inviabilizando qualidade, segurança e velocidade a partir da segunda feature de produto. `mvp-01/epics.md` classifica EP-015 a EP-019 como "épicos de plataforma necessários para que os [épicos de produto] anteriores funcionem".

## Escopo
- Monorepo pnpm + Turborepo, padrões de código, lint, commits, e pipeline de CI com oito estágios de *quality gate* (FT-047).
- Ambiente local reprodutível via Docker Compose (PostgreSQL, Redis, MinIO, Authentik, Mailpit, Gotenberg, ClamAV).
- Esqueleto modular da API NestJS (DEC-040/041), persistência Prisma com RLS e concorrência otimista, eventos de domínio via outbox transacional, worker com filas/retries/dead-letter (FT-048).
- Logs estruturados, `correlationId`, tracing distribuído, health checks, métricas e dashboards técnicos (FT-049).
- Shell da aplicação web (App Router), design system (`packages/ui`), cliente de API (BFF) e páginas de erro globais (FT-050).

## Fora de escopo
- Qualquer tela ou regra de negócio de produto (EP-001 a EP-014) — construídas sobre esta fundação, não aqui.
- Autenticação real com Authentik (fluxo completo, MFA, convites, federação) — EP-016 Identidade, acesso e RBAC.
- Provisionamento e isolamento de tenant como produto (estrutura organizacional, catálogos, numeração, calendário) — EP-017 Tenant e estrutura organizacional.
- Central de notificações como produto (preferências, lembretes de prazo) — EP-019 Notificações.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Pessoa desenvolvedora backend | equipe de engenharia | Constrói cada módulo de negócio sobre o esqueleto da API, a persistência e os eventos |
| Pessoa desenvolvedora frontend | equipe de engenharia | Constrói cada tela sobre o shell, o design system e o cliente de API |
| Pessoa operadora/SRE | operação da plataforma | Opera e diagnostica a plataforma via logs, traces, métricas, health e dashboards |
| Pipeline de CI | automação | Garante os quality gates antes de qualquer merge |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-047 | Monorepo e ambiente | US-077, US-078, US-079 | P0 |
| FT-048 | Arquitetura base da API | US-080, US-081, US-082, US-083 | P0 |
| FT-049 | Observabilidade | US-084, US-085 | P0 |
| FT-050 | Frontend base | US-086 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-077 | Configurar monorepo e padrões de código | P0 | M | 5 |
| US-078 | Ambiente local com Docker Compose | P0 | M | 5 |
| US-079 | Pipeline de CI com quality gates | P0 | M | 5 |
| US-080 | Esqueleto da API modular | P0 | L | 8 |
| US-081 | Persistência com Prisma e concorrência otimista | P0 | M | 5 |
| US-082 | Eventos de domínio com outbox transacional | P0 | L | 8 |
| US-083 | Worker com filas, retries e dead letter | P0 | M | 5 |
| US-084 | Logs estruturados, correlationId e tracing | P0 | M | 5 |
| US-085 | Health checks, métricas e dashboards técnicos | P1 | M | 5 |
| US-086 | Shell da aplicação web, design system e cliente de API | P0 | L | 8 |
| **Total** | | | | **59** |

## Módulos e entidades
- Módulos: `platform` (dono de todos os mecanismos transversais desta fundação: `config`, `request-context`, `http`, `throttler`, `idempotency`, `pagination`, `openapi`, `observability`, outbox, filas); os demais módulos de DEC-040 nascem como esqueleto vazio, sem lógica de negócio.
- Entidades: `OutboxEvent` (dono, módulo `platform`) — única entidade de negócio criada por este épico; as demais tabelas de domínio (DEC-040) só ganham schema real a partir dos épicos de produto.

## Telas
- SCR-111 — Páginas de erro e estados globais (403, 404, 500, sessão expirada, manutenção, sem vínculo) — `/erro/*`.

## Integrações
- Internas: todo módulo de negócio futuro consome os mecanismos desta fundação (guards, `RequestContext`, `OutboxWriter`, filas, logger, `apiServerClient`) pela fachada pública, nunca por acesso direto a infraestrutura.
- Externas (infraestrutura de apoio, sem integração de negócio ainda): PostgreSQL, Redis (sessões e cache/filas), MinIO/S3, Authentik (OIDC — só `FakeJwksProvider` nesta fundação), Mailpit/SMTP, Gotenberg, ClamAV, Collector OpenTelemetry/Prometheus/Grafana/Loki/Tempo.

## Eventos principais
- Nenhum evento de domínio de produto — o épico entrega o **mecanismo** (envelope DEC-160, `OutboxWriter`, relay, fan-out) que os épicos de produto usam a partir do primeiro agregado real (US-001).

## Permissões envolvidas
- `PLATFORM_QUEUE_ADMIN` (Bull Board, US-083) — única permissão de catálogo introduzida por este épico; é de operação de plataforma, não de negócio de tenant.

## Regras configuráveis
- `features.<flag>` (DEC-059) — mecanismo de *feature flag* por tenant, sem nenhuma flag de produto definida ainda.
- Variáveis de ambiente de infraestrutura (uma por story, ver seção "Campos" de cada card) — não são `TenantSetting`; são configuração de plataforma (12-factor).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo de CI (PR até merge, estágios 1–7) | < 15 min p95 | Pipeline de CI (US-079) |
| Overhead do pipeline de requisição (guards + contexto + throttler) | < 10 ms p95 sobre rota vazia | US-080/US-084 |
| Cobertura de linha em `domain`+`application` do código novo | ≥ 80% (gate bloqueante) | Estágio Testes da CI (US-079) |
| Disponibilidade de `/health/ready` nas verificações do pipeline E2E | 100% | US-085 |
| Componentes do design system com zero violação séria/crítica de acessibilidade | 100% | Storybook + axe (US-086) |

## Dependências
- **Depende de:** nenhum épico — `mvp-01/epics.md` registra `depende de: —` para EP-015; é a base do MVP 1.
- **Habilita:** EP-010 Timeline, EP-011 Documentos, EP-013 Auditoria, EP-016 Identidade/acesso/RBAC, EP-017 Tenant e estrutura organizacional, EP-019 Notificações e, por padrão, todos os épicos de produto do MVP 1 (EP-001 a EP-014), que constroem sobre o esqueleto de API, persistência, eventos, observabilidade e shell entregue aqui.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Padrão transversal (erro, guards, cache, design system) definido errado na fundação propaga o erro às ~100 stories seguintes | Média | Alto | Revisão de CODEOWNERS (Tech Lead + segurança) em qualquer mudança de fronteira; rota/página de exemplo com teste automatizado antes de liberar cada story |
| Degradação mal calibrada entre dependência crítica × degradável (CA-T-07) esconde indisponibilidade real ou gera alarme falso | Média | Alto | Matriz de criticidade por aplicação documentada e testada (US-085); alertas A01/A02/A04 validados em homologação |
| Contexto de `AsyncLocalStorage`/trace perdido em `Promise` fora da cadeia do Nest (fire-and-forget, `setTimeout`) | Média | Médio | Teste de não vazamento de contexto entre requisições concorrentes (US-080/US-084); regra documentada no `CONTRIBUTING.md` |
| CSP estrita com *nonce* bloqueia biblioteca de terceiros que injeta `<script>` sem suporte a *nonce* | Baixa | Médio | Avaliação de bibliotecas antes da adoção (mesmo processo de dependência nova da US-077); `report-to` monitorado desde o início |
| Relay do outbox com líder único (*advisory lock*) vira ponto único de atraso sob falha do processo líder | Baixa | Alto | Alertas A05–A07 (lag e ausência/duplicidade de líder) com runbook RB-01 (US-082/US-085) |

## Pontos em aberto
Nenhum ponto aberto no nível do épico: as lacunas identificadas durante a especificação (nomes de classes de mecanismos transversais, flag operacional de debug temporário, escopo incremental dos dashboards D4–D7, API exata do componente `<Can>`) foram resolvidas com uma proposta registrada na seção "Dependências → Lacunas nas fontes canônicas" da respectiva story (US-080, US-084, US-085, US-086).

## Definition of Done do épico
- [ ] Todas as features (FT-047 a FT-050) concluídas e as 10 stories aceitas
- [ ] KPIs desta página instrumentados e visíveis nos dashboards técnicos (US-085)
- [ ] Teste E2E mínimo (CI, US-079) cobrindo: build dos três apps, subida do ambiente local, rota de exemplo da API e jornada de exemplo do shell web
- [ ] Documentação técnica (`architecture.md`, `observability.md`, `security.md`, `queues.md`) e `CONTRIBUTING.md` atualizados com as convenções fixadas por este épico
