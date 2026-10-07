---
id: FT-057
title: "Parametrização"
epic: EP-017
mvp: 1
priority: P0
stories: [US-103, US-104, US-105, US-106]
status: Especificada
---

# FT-057 — Parametrização

## Título
Parametrização

## Épico
EP-017 — Tenant e estrutura organizacional

## Descrição
Esta feature entrega os quatro mecanismos pelos quais o administrador do órgão adapta o comportamento do sistema ao seu contexto, sem alteração de código: o registro de configurações tipado (rótulos, marca, numeração, segurança, prazos…), os catálogos parametrizáveis (tipos, modalidades, unidades de medida, categorias…), a numeração configurável e segura sob concorrência de processos e documentos, e o calendário de dias úteis e feriados.

## Valor para o usuário e para o órgão
- O administrador ajusta comportamento do sistema em minutos, com validação e auditoria, sem depender de suporte técnico ou deploy.
- Numeração de processos e documentos confiável — única, sem lacunas, aceita como protocolo oficial.
- Prazos de tramitação corretos desde o primeiro processo, considerando feriados nacionais, estaduais e municipais.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`) — configura todos os mecanismos desta feature.
- Qualquer usuário com vínculo ativo — consome as chaves públicas (`labels.*`, `branding.*`) e os catálogos ativos nos formulários.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-103 | Configurações gerais do tenant | P0 | M | US-100 |
| US-104 | Catálogos parametrizáveis | P0 | M | US-100 |
| US-105 | Numeração configurável e segura sob concorrência | P0 | M | US-103 |
| US-106 | Calendário de dias úteis e feriados | P1 | S | US-100 |

## Escopo
- Leitura/escrita genérica e tipada de todas as chaves de configuração do tenant, com concorrência otimista por chave e leitura pública de um subconjunto.
- Gestão dos 8 catálogos parametrizáveis (criar, editar, ativar/desativar, reordenar), com `metadata` validada por tipo.
- Configuração de máscara, escopo e momento de atribuição da numeração, com prévia antes de salvar.
- Gestão de feriados (nacionais semeados, estaduais/municipais/facultativos cadastrados) e cálculo de dias úteis.

## Fora de escopo
- Regras de negócio que apenas *consomem* estas configurações fora do épico (ex.: o cálculo de `dueAt` de uma etapa de processo — US-055; a numeração efetiva de um processo — US-001).
- Feature flags de rollout percentual com ferramenta dedicada (DEC-059, avaliado quando necessário).

## Regras de negócio da feature
- Só chaves existentes no registro tipado podem ser lidas/gravadas; chave fora do registro é rejeitada por completo no lote (`SETTING_KEY_UNKNOWN`, RN-TEN-52/54).
- `CatalogItem.code` é estável e imutável; itens de sistema nunca são excluídos, só renomeados/desativados; `metadata` é validada pelo schema do `catalogType` (RN-TEN-59..62).
- Máscara de numeração deve conter `{seq:N}` e `{year}` (e `{org}` quando o escopo é por órgão); o número é obtido por incremento transacional sem lacunas por rollback (RN-TEN-67/69).
- Dia útil é segunda a sexta, exceto feriado ativo do tenant; alterações no calendário nunca recalculam prazos já gravados (RN-TEN-74/79).

## Telas
- SCR-041 — Configurações gerais (`/admin/configuracoes`)
- SCR-109 — Catálogos (`/admin/catalogos`)
- SCR-110 — Calendário de dias úteis (`/admin/calendario`)

## Endpoints
- SET-01..04 — `GET/PATCH /settings`, `GET /settings/public`, `POST /numbering/preview`
- CAT-01..06 — `GET/POST /catalogs/{catalogType}/items`, `PATCH/activate/deactivate /catalog-items/{id}`, `PUT /catalogs/{catalogType}/order`
- CAL-01..06 — `GET/POST/PATCH/DELETE /holidays[/{id}]`, `GET /calendar/business-days`, `POST /calendar/add-business-days`

## Entidades
- `TenantSetting` — registro tipado chave-valor, dona de US-103.
- `CatalogItem` — catálogos parametrizáveis, dona de US-104.
- `NumberSequence` — sequência transacional de numeração, dona de US-105.
- `Holiday` — calendário de feriados, dona de US-106.

## Eventos
- `TenantSettingsChanged` — a cada `PATCH` de configurações (inclusive numeração).
- `CatalogItemChanged` — a cada alteração de item de catálogo.
- `HolidayChanged` — a cada alteração de feriado.

## Permissões
- `SETTINGS_MANAGE` — ler/escrever o registro de configurações (inclusive numeração).
- `CATALOG_MANAGE` — gerenciar catálogos.
- `CALENDAR_MANAGE` — gerenciar o calendário de feriados.

## Dependências
- **Features/stories:** depende de FT-055 (contexto de tenant; seeders `tenancy.settings`, `catalog.items`, `catalog.holidays` no provisionamento). Habilita praticamente toda story de negócio que leia uma chave de configuração, um catálogo ou o calendário (US-001, US-029, US-035, US-047, US-055, document stories estruturadas).
- **Decisões/ADRs:** DEC-027, DEC-028, DEC-031, DEC-059, DEC-080..083, DEC-104, DEC-105; ADR-002.

## Critérios de aceite da feature
```gherkin
Feature: Parametrização do tenant

  Scenario: Configurar numeração, catálogo e calendário antes do primeiro processo
    Given que o tenant "Prefeitura de São José" foi provisionado com os padrões semeados
    When o administrador ajustar a máscara de numeração de processo e cadastrar um feriado municipal
    Then a prévia da numeração deve refletir a nova máscara
    And o feriado municipal deve ser considerado no cálculo de dias úteis
    And ambas as alterações devem gerar auditoria e evento de domínio
```

## Métricas de sucesso
- 100% das chaves do registro com valor padrão desde o provisionamento (nenhuma chave "ausente" percebida pelo administrador).
- 0 máscaras de numeração inválidas aceitas em produção.
- 100% dos cálculos de dias úteis corretos frente aos feriados cadastrados (validado pela suíte de testes de US-055/US-106).

## Riscos
- Mudança de escopo de numeração no meio do exercício confundir o administrador — mitigado por efeito só a partir do próximo exercício, com aviso não bloqueante (US-105).
- Feriado local não cadastrado leva a prazo (SLA) incorreto — mitigado por feriados nacionais e Páscoa semeados automaticamente; administrador completa os locais (US-106).

## Definition of Done da feature
- [ ] US-103, US-104, US-105 e US-106 concluídas e aceitas
- [ ] Jornada E2E "configurar numeração, catálogo e calendário de um tenant novo" automatizada
- [ ] Documentação do administrador do órgão atualizada
