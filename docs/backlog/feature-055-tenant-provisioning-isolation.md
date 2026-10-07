---
id: FT-055
title: "Provisionamento e isolamento"
epic: EP-017
mvp: 1
priority: P0
stories: [US-099, US-100]
status: Especificada
---

# FT-055 — Provisionamento e isolamento

## Título
Provisionamento e isolamento

## Épico
EP-017 — Tenant e estrutura organizacional

## Descrição
Esta feature cobre o nascimento de um tenant — provisionamento automatizado via API de plataforma ou CLI, com checklist de seeders idempotentes (órgão principal, configurações, catálogos, perfis, tipos de documento, templates, workflows, feriados) e ciclo de vida completo (`PROVISIONING` → `ACTIVE` → `SUSPENDED`/`OFFBOARDING` → `DEACTIVATED`) — e a garantia estrutural de que nenhum dado de um tenant é lido ou alterado por outro, em toda a pilha: banco (RLS + FKs compostas), contexto de requisição, cache, storage, filas e logs.

## Valor para o usuário e para o órgão
- Entrega de um ambiente de produção pronto para uso em minutos (meta p95 < 2 min), sem SQL manual nem suporte técnico.
- Confiança estrutural de que um incidente de isolamento entre instituições contratantes é estruturalmente impossível, não apenas evitado por disciplina de código (KPI C5 = 0 incidentes).
- Base reaproveitada por toda story de negócio do produto, que não precisa "lembrar" de filtrar por tenant.

## Personas
- Operador da plataforma (`isPlatformOperator = true`) — provisiona e administra o ciclo de vida do tenant.
- Administrador do órgão (`ADMIN_ORGAO`) — recebe o convite inicial e encontra o ambiente já pronto.
- Time de engenharia — toda story de negócio herda o contexto de tenant sem reimplementar isolamento.
- Controle Interno / Auditor — consulta a auditoria das ações de plataforma sobre o tenant.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-099 | Provisionar tenant com dados padrão | P0 | M | US-081, US-100 |
| US-100 | Contexto de tenant e isolamento de dados | P0 | L | US-080, US-081 |

## Escopo
- Provisionamento ponta a ponta (tenant, órgão principal, configurações, catálogos, perfis, tipos de documento, templates, workflows, feriados, convite do primeiro administrador) com checklist calculado e reexecução idempotente.
- Ciclo de vida do tenant e matriz de acesso por status (`PROVISIONING`, `ACTIVE`, `SUSPENDED`, `OFFBOARDING`, `DEACTIVATED`).
- Contexto de requisição e de job (`TenantContext`, `AsyncLocalStorage`), RLS `ENABLE`+`FORCE` em toda tabela com `tenant_id`, papéis de banco segregados, FKs compostas.
- Acesso de plataforma exclusivamente pelo `SystemDbService`, com motivo de lista fechada e auditoria.
- Isolamento de cache, storage e filas por `tenantId`.

## Fora de escopo
- Autenticação, usuários e perfis (EP-016).
- Interface de backoffice da plataforma (sem UI no MVP 1 — CLI/API apenas; DT-07).
- Conteúdo detalhado dos catálogos, estrutura organizacional e numeração (semeados aqui, geridos em FT-056/FT-057).

## Regras de negócio da feature
- Cada etapa do provisionamento é idempotente por chave natural e roda em transação própria; o checklist é calculado (`verify()`), nunca armazenado como flag isolada (RN-TEN-05..07).
- Transições de `TenantStatus` seguem uma máquina de estados fechada; fora dela, `INVALID_STATE` (RN-TEN-09). Acesso de usuário é bloqueado fora de `ACTIVE`, exceto leitura/exportação em `OFFBOARDING` para `ADMIN_ORGAO`/`AUDITOR` (RN-TEN-10).
- O provisionamento nunca cria vínculo para o operador da plataforma (RN-TEN-14); todo acesso de suporte é um fluxo separado e temporário (DEC-139).
- Toda tabela de negócio tem `tenant_id NOT NULL`, RLS com política `tenant_id = current_setting('app.tenant_id')::uuid` e `UNIQUE (tenant_id, id)` para permitir FKs compostas (RN-TEN-25..27).
- Acesso de plataforma a dados de tenant só via `SystemDbService`, com `reason` de lista fechada e auditoria obrigatória (RN-TEN-28).

## Telas
- SCR-111 — Acesso indisponível / trocar de instituição (`/sem-acesso`, variantes por status do tenant)

## Endpoints
- PLT-01 `POST /platform/tenants` — provisionar tenant
- PLT-02/03 `GET /platform/tenants[/{id}]` — listar/consultar
- PLT-04/05/06/07 `POST /platform/tenants/{id}/activate|suspend|offboard|deactivate`
- PLT-08 `PATCH /platform/tenants/{id}` — atualizar dados cadastrais

## Entidades
- `Tenant` — agregado de ciclo de vida, dono desta feature.
- `TenantSetting` — semeada aqui (seeder `tenancy.settings`), gerida por FT-057 (US-103).

## Eventos
- `TenantProvisioned` — ao concluir o checklist de provisionamento.
- `TenantActivated` / `TenantSuspended` / `TenantOffboarded` / `TenantDeactivated` — a cada transição de status.

## Permissões
- `PLATFORM_TENANT_MANAGE` — provisionar e administrar o ciclo de vida do tenant (uso exclusivo de operadores da plataforma).

## Dependências
- **Features/stories:** depende de EP-015 (API modular, Prisma/migrações, outbox). Habilita todas as demais features deste épico (FT-056, FT-057) e, por extensão, todo o restante do produto.
- **Decisões/ADRs:** DEC-011, DEC-012, DEC-080..083, DEC-105, DEC-132, DEC-139, DEC-161, DEC-164; ADR-002.

## Critérios de aceite da feature
```gherkin
Feature: Provisionamento e isolamento

  Scenario: Provisionar um tenant e confirmar isolamento imediato
    Given que "Carla", operadora da plataforma com MFA, provisiona o tenant "sao-jose" com órgão principal e primeiro administrador
    When o provisionamento concluir com o checklist 100% "DONE"
    Then o tenant "sao-jose" deve ficar "ACTIVE" e o convite do primeiro administrador deve ser enviado
    And nenhuma consulta feita no contexto de outro tenant deve retornar dados de "sao-jose"
```

## Métricas de sucesso
- Tempo de provisionamento: p95 < 2 min (típico < 30 s).
- Incidentes de isolamento entre tenants: 0 (suíte "tenant leak" no CI, 100% das rotas classificadas).

## Riscos
- Consulta sem filtro de tenant (RM-01) — mitigado por RLS `FORCE` e extensão do Prisma que injeta `tenantId`.
- Contexto vazando entre requisições no pool de conexões (RM-02) — mitigado por `set_config(…, true)` escopado à transação, validado com o pooler em modo transação.
- Cache/storage sem escopo de tenant (RM-03/RM-04) — mitigado por `TenantCache`/`StorageKeyBuilder` como único caminho de acesso.

## Definition of Done da feature
- [ ] US-099 e US-100 concluídas e aceitas
- [ ] Jornada E2E "provisionar tenant até o primeiro acesso do administrador" automatizada
- [ ] Suíte "tenant leak" com 100% das rotas introduzidas classificadas e sem achados
- [ ] Documentação (CLI, API de plataforma e runbook de isolamento) atualizada
