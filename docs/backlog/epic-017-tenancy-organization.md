---
id: EP-017
title: "Tenant e estrutura organizacional"
mvp: 1
priority: P0
features: [FT-055, FT-056, FT-057]
status: Especificado
---

# EP-017 — Tenant e estrutura organizacional

## Título
Tenant e estrutura organizacional

## Objetivo
Entregar a fundação multi-tenant de negócio do ContrataFlow — provisionamento automatizado, isolamento garantido de dados, estrutura organizacional (órgãos e unidades) e parametrização (configurações, catálogos, numeração e calendário) — para que qualquer instituição contratante tenha um ambiente pronto, seguro e adaptável às suas particularidades em minutos, sem suporte técnico nem SQL manual.

## Contexto e problema
- Hoje a contratação pública nos órgãos atendidos é controlada por planilhas e papel: numeração manual de processos (duplicidades), estrutura organizacional não refletida em sistema, prazos sem calendário de feriados e "parâmetros" (tipos, modalidades, unidades de medida) fixos ou soltos.
- DEC-011 define a hierarquia `Tenant` (instituição contratante, fronteira de isolamento) × `Organization` (órgão/entidade com CNPJ) × `Department` (unidade administrativa em árvore). DEC-080 a DEC-083 definem o isolamento por `tenant_id` obrigatório, FKs compostas e Row-Level Security. DEC-027 (catálogos), DEC-028 (numeração) e DEC-031 (calendário/SLA) definem como o tenant adapta o comportamento do sistema sem alteração de código.
- Este épico é a **fundação de negócio** sobre a qual todo o restante do produto se apoia: nenhum processo, documento ou workflow pode existir sem tenant, órgão, unidade, catálogo, numeração e calendário corretos. Depende apenas de EP-015 (fundação técnica: API, Prisma, outbox) e habilita diretamente EP-001 (processo), EP-007 (workflow), EP-016 (identidade e RBAC) e EP-018 (templates de documento).

## Escopo
- Provisionar um tenant completo com um único comando (API de plataforma ou CLI), e administrar seu ciclo de vida (ativar, suspender, encerrar, desativar).
- Garantir isolamento de dados entre tenants em toda a pilha: banco (RLS + FKs compostas), cache, storage, filas e logs.
- Cadastrar e manter órgãos/entidades com CNPJ (`Organization`) e a árvore de secretarias, departamentos e setores (`Department`), com titular e substituto.
- Manter um registro de configurações tipado por tenant (rótulos, marca, numeração, segurança, prazos, pesquisa de preços, riscos, arquivos, notificações, flags).
- Manter catálogos parametrizáveis (tipo de contratação, modalidade, origem do processo, unidade de medida, categoria de risco, tipo de fonte de preço, critério de julgamento, categoria de anexo).
- Configurar e operar a numeração de processos e documentos de forma segura sob concorrência.
- Manter o calendário de dias úteis e feriados (nacionais, estaduais, municipais, facultativos) do tenant.

## Fora de escopo
- Autenticação, usuários, perfis e autorização (RBAC) — EP-016.
- Modelagem e execução de workflows — EP-007.
- O processo de contratação e seus documentos (DFD, ETP, TR, mapa de riscos, pesquisa de preços) — EP-001 a EP-006.
- Integração com o PNCP e backoffice de plataforma com interface própria (MVP 2/MVP 3 — DT-07, DEC-141, PEND-17).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` (escopo `TENANT`) | Configura órgãos, unidades, catálogos, numeração e calendário sem depender de suporte |
| Operador da plataforma | `isPlatformOperator = true` | Provisiona, ativa, suspende e encerra tenants |
| Qualquer usuário do tenant | Todos os perfis | Depende do isolamento de dados e consome rótulos/marca e catálogos nos formulários |
| Controle Interno / Auditor | `AUDITOR` | Consulta auditoria de todas as alterações de configuração e estrutura |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-055 | Provisionamento e isolamento | US-099, US-100 | P0 |
| FT-056 | Estrutura organizacional | US-101, US-102 | P0 |
| FT-057 | Parametrização | US-103, US-104, US-105, US-106 | P0/P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-099 | Provisionar tenant com dados padrão | P0 | M | 5 |
| US-100 | Contexto de tenant e isolamento de dados | P0 | L | 8 |
| US-101 | Gerenciar órgãos/entidades | P0 | S | 2 |
| US-102 | Gerenciar secretarias e setores | P0 | M | 5 |
| US-103 | Configurações gerais do tenant | P0 | M | 5 |
| US-104 | Catálogos parametrizáveis | P0 | M | 5 |
| US-105 | Numeração configurável e segura sob concorrência | P0 | M | 5 |
| US-106 | Calendário de dias úteis e feriados | P1 | S | 2 |
| **Total** | | | | **37** |

## Módulos e entidades
- Módulos: `tenancy` (dono de `Tenant`, `TenantSetting`, provisionamento), `organization` (dono de `Organization`, `Department`), `catalog` (dono de `CatalogItem`, `Holiday`, `NumberSequence`), `platform` (persistência multi-tenant, `SystemDbService`, cache, storage, filas).
- Entidades: `Tenant`, `TenantSetting`, `Organization`, `Department`, `CatalogItem`, `Holiday`, `NumberSequence` (donas); `User`, `Attachment` (consumidas).

## Telas
- SCR-032 — Secretarias (órgãos, secretarias, setores) (`/admin/estrutura`)
- SCR-041 — Configurações gerais (`/admin/configuracoes`)
- SCR-109 — Catálogos (`/admin/catalogos`)
- SCR-110 — Calendário de dias úteis (`/admin/calendario`)
- SCR-111 — Telas de acesso indisponível/sem vínculo (apoio, dono em US-100)

## Integrações
- **Internas:** fundação consumida por praticamente todo módulo de negócio do MVP 1 (processo, workflow, documentos, identidade) através de fachadas (`NumberingFacade`, `BusinessCalendarFacade`, `CatalogFacade`, `TenantPrismaService`).
- **Externas:** nenhuma no MVP 1 (integração com PNCP fica para o MVP 3).

## Eventos principais
- `TenantProvisioned`, `TenantActivated`, `TenantSuspended`, `TenantOffboarded`, `TenantDeactivated`
- `TenantSettingsChanged`
- `OrganizationCreated`, `OrganizationUpdated`
- `DepartmentCreated`, `DepartmentUpdated`, `DepartmentMoved`, `DepartmentDeactivated`
- `CatalogItemChanged`
- `HolidayChanged`

## Permissões envolvidas
- `PLATFORM_TENANT_MANAGE` (plataforma)
- `ORGANIZATION_MANAGE`
- `DEPARTMENT_MANAGE`
- `SETTINGS_MANAGE`
- `CATALOG_MANAGE`
- `CALENDAR_MANAGE`

## Regras configuráveis
- `labels.secretariat` / `labels.department` — rótulo exibido para os níveis da árvore organizacional
- `numbering.process.mask` / `.scope` / `.assignOn`, `numbering.document.defaultMask` — máscara, escopo e momento da numeração
- `calendar.optionalHolidaysAreNonBusiness` — se pontos facultativos contam como não úteis
- `access.historicalDepartmentsCanView` — se unidades mantêm acesso histórico após deixarem de atuar no processo
- `deadlines.warnBeforeBusinessDays` — antecedência do aviso de vencimento próximo (consumida por US-055, fora do épico)

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo de provisionamento de um tenant | p95 < 2 min (típico < 30 s) | US-099 |
| Tempo até o primeiro processo criado após o contrato (A6) | ≤ 10 dias úteis | product-overview §11.3 |
| Incidentes de isolamento entre tenants (C5) | 0 | Suíte "tenant leak" no CI (US-100) |
| Numerações concorrentes sem lacuna ou duplicata | 100% | Teste de carga (US-105) |

## Dependências
- **Depende de:** EP-015 (fundação técnica: API modular, Prisma/migrações, outbox, worker, observabilidade).
- **Habilita:** EP-001 (processo de contratação), EP-007 (workflow), EP-016 (identidade, acesso e RBAC), EP-018 (templates de documentos).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Vazamento de dados entre tenants (consulta sem filtro, cache/storage sem escopo) | Baixa | Crítico | RLS `ENABLE`+`FORCE` em toda tabela, FKs compostas, chaves de cache/storage com `tenantId`, suíte "tenant leak" no CI (US-100) |
| Lacuna ou duplicidade de número sob concorrência | Baixa | Alto | Incremento transacional `UPDATE … RETURNING` com bloqueio de linha na mesma transação do recurso numerado (US-105) |
| Feriado local não cadastrado leva a prazo (SLA) incorreto | Média | Médio | Feriados nacionais e Páscoa semeados automaticamente; administrador completa os locais (US-106) |
| Mudança de escopo/máscara de numeração confundir numeração em curso | Média | Médio | Efeito só a partir do próximo exercício, com aviso não bloqueante na UI (US-105, RN-TEN-68) |

## Pontos em aberto
- ~~PEND-01~~ — decidida em 2026-10-07: `CREATE` como padrão (DEC-028), configurável para `START`.
- Lista de slugs reservados de tenant: revisar se domínios próprios por tenant forem adotados (MVP 2+; no MVP 1, domínio único — DEC-141).
- PEND-07 — Política de exclusão/retenção de dados ao desativar um tenant (LGPD).
- PEND-17 — Limites de plano e cota de armazenamento por tenant.

## Definition of Done do épico
- [ ] Todas as features (FT-055, FT-056, FT-057) concluídas
- [ ] KPIs instrumentados (tempo de provisionamento, incidentes de isolamento, concorrência de numeração)
- [ ] Testes E2E das jornadas do épico passando (provisionar tenant, montar estrutura, configurar numeração e calendário)
- [ ] Suíte "tenant leak" cobrindo 100% das rotas introduzidas pelo épico
- [ ] Documentação e guia do administrador do órgão atualizados
