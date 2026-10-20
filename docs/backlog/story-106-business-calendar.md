---
id: US-106
title: "Calendário de dias úteis e feriados"
epic: EP-017
feature: FT-057
mvp: 1
priority: P1
estimate: S
status: Especificada
depends_on: [US-100]
modules: [catalog]
screens: [SCR-110]
endpoints: [CAL-01, CAL-02, CAL-03, CAL-04, CAL-05, CAL-06]
permissions: [CALENDAR_MANAGE]
events: [HolidayChanged]
---

# US-106 — Calendário de dias úteis e feriados

## Título
Gerenciar calendário de dias úteis e feriados

## Descrição
**Como** administrador do órgão, **quero** manter os feriados e pontos facultativos do tenant e consultar dias úteis, **para** que os prazos de tramitação sejam calculados corretamente considerando as particularidades locais do meu município e estado.

## Contexto
- DEC-031: dia útil é segunda a sexta-feira, exceto datas com `Holiday` ativo do tenant. Feriados nacionais — inclusive móveis, calculados pelo algoritmo de Meeus/Butcher para a Páscoa — são semeados no provisionamento (US-099, seeder `catalog.holidays`) para o ano corrente e o seguinte; estaduais, municipais e pontos facultativos são cadastrados pelo administrador. `calendar.optionalHolidaysAreNonBusiness` decide se pontos facultativos contam como não úteis (padrão `false`).
- `CAL-06` (`POST /calendar/add-business-days`, `{ fromDateTime, businessDays, dayCountType? } → { dueDateTime }`) é o endpoint consumido por US-055 (cálculo de `dueAt` de etapa, sempre normalizado ao fim do dia — `23:59:59.999` no fuso do tenant) e pela prévia de sobrescrita de prazo em US-047.
- Alterações no calendário **não** recalculam prazos (`dueAt`) já gravados — sem recálculo retroativo no MVP 1; correção manual de prazos afetados é uma ação de produto fora deste escopo.

## Objetivo
Garantir que todo cálculo de dias úteis considere corretamente os feriados do tenant, com os feriados nacionais e a Páscoa do ano corrente e do seguinte sempre presentes após o provisionamento, e permitir que o administrador complete o calendário com feriados locais.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Time de engenharia — toda story que calcula prazo (US-047, US-055) consome a `BusinessCalendarFacade` desta story.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `CALENDAR_MANAGE` para editar (leitura é capacidade implícita).
- Feriados nacionais semeados pelo provisionamento (US-099).

## Fluxo principal
1. O administrador acessa **Administração → Calendário** (SCR-110) e escolhe o ano; o sistema lista os feriados (`CAL-01`) com data, nome, escopo, se é recorrente e se é de sistema.
2. Clica em **"Novo feriado"**, informa data, nome, escopo (`STATE`, `MUNICIPAL` ou `OPTIONAL`) e se é recorrente; o front envia `POST /holidays` (`CAL-02`).
3. A API valida unicidade `(tenant, date, nome em minúsculas)`, cria o `Holiday` (`isSystem = false`), grava `holiday.create` e publica `HolidayChanged`.
4. Para editar ou remover um feriado não-sistema, usa `PATCH`/`DELETE` (`CAL-03`/`CAL-04`, ambos com `If-Match`).
5. Na virada do ano, um job de manutenção gera a ocorrência do ano seguinte para feriados recorrentes, recalculando a Páscoa e os feriados móveis derivados.
6. Qualquer serviço que precise somar dias úteis consulta `CAL-05` (intervalo) ou `CAL-06` (soma a partir de uma data).

## Fluxos alternativos
- **FA-01 — Feriado de sistema:** não pode ser excluído (ver RN-TEN-77), só desativado; a UI não exibe "Excluir" para esses registros.
- **FA-02 — Cadastro retroativo:** permitido (correção histórica), mas não recalcula `dueAt` já gravados.
- **FA-03 — Ponto facultativo sem afetar dias úteis:** com `calendar.optionalHolidaysAreNonBusiness = false`, o feriado `OPTIONAL` aparece na lista mas não altera `CAL-05`/`CAL-06`.

## Regras de negócio
- **RN-TEN-74** — Dia útil é segunda a sexta-feira, exceto datas com `Holiday` ativo de escopo `NATIONAL`/`STATE`/`MUNICIPAL`, ou `OPTIONAL` quando `calendar.optionalHolidaysAreNonBusiness = true` (DEC-031).
- **RN-TEN-75** — Unicidade por `(tenant, date, lower(name))`; feriados de escopos diferentes na mesma data são registros distintos e permitidos (ex.: nacional e municipal coincidentes).
- **RN-TEN-76** — `isRecurring = true`: o job de manutenção gera a ocorrência do ano seguinte automaticamente; feriados móveis (Páscoa e derivados — Carnaval: Páscoa − 47 dias; Quarta-feira de Cinzas: Páscoa − 46; Corpus Christi: Páscoa + 60; Sexta-feira Santa: Páscoa − 2) são recalculados a cada virada de ano pelo algoritmo de Meeus/Butcher.
- **RN-TEN-77** — Feriados de sistema (`isSystem = true`) não podem ser excluídos; podem ser desativados. Reaproveita o código `CATALOG_ITEM_SYSTEM` (409) por ausência de um código específico de calendário nas fontes canônicas (ver Lacunas).
- **RN-TEN-78** — `CAL-06` soma `businessDays` dias úteis (ou corridos, se `dayCountType = CALENDAR`) a partir de `fromDateTime`, retornando `dueDateTime` normalizado ao fim do dia (`23:59:59.999`) no fuso do tenant; consumido por US-055/US-047.
- **RN-TEN-79** — Criar, editar ou excluir um feriado nunca recalcula `dueAt` já gravados (sem recálculo retroativo).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Data | `date` | data | Sim | formato `YYYY-MM-DD` | — |
| Nome | `name` | texto curto | Sim | 1–120 caracteres | — |
| Escopo | `scope` | seleção (`HolidayScope`) | Sim | enum | — |
| Recorrente | `isRecurring` | interruptor | Não | RN-TEN-76 | `false` |
| Ativo | `isActive` | interruptor | — | — | `true` |
| *(sistema)* De sistema | `isSystem` | booleano (leitura) | — | RN-TEN-77 | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | Data em formato inválido | Front + API | "Informe uma data válida." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `(date, name)` duplicado no tenant | API (+ índice único) | "Já existe um feriado com esta data e nome." | `CONFLICT` |
| V-04 | Excluir/alterar código de feriado de sistema | API | "Feriados padrão do sistema não podem ser excluídos." | `CATALOG_ITEM_SYSTEM` |
| V-05 | `businessDays` fora do intervalo em `CAL-06` | API | — (uso interno/prévia) | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** `CALENDAR_MANAGE`, risco `M`, sem variação de escopo (sempre `TENANT`); leitura (`CAL-01`, `CAL-05`, `CAL-06`) é capacidade implícita de qualquer vínculo `ACTIVE`.
- **Políticas:** nenhuma política contextual própria.
- **MFA:** exigido somente se `security.mfaPolicy = ALL`.
- **Sem permissão:** tela de calendário oculta edição; API responde 403 `PERMISSION_DENIED` em `CAL-02..04` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `HolidayChanged` | `catalog.holiday_changed` | Commit de criar/editar/excluir feriado | `change` = `CREATED`\|`UPDATED`\|`DELETED` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; alteração de calendário não gera notificação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar calendário de dias úteis e feriados

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo com a permissão "CALENDAR_MANAGE"

  Scenario: [Sucesso] Cadastrar feriado municipal e refletir no cálculo de dias úteis
    When o administrador cadastrar o feriado municipal "Aniversário da cidade" em 12/10/2026
    Then o feriado deve aparecer na lista do ano 2026
    And "CAL-06" não deve contar 12/10/2026 como dia útil
    And deve gerar o evento "HolidayChanged" com "change" igual a "CREATED"

  Scenario: [Validação] Data ausente
    When o administrador tentar cadastrar um feriado sem informar a data
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "date"

  Scenario: [Permissão] Usuário sem CALENDAR_MANAGE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" enviar POST para cadastrar um feriado
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Feriado de outro tenant não afeta o cálculo
    Given que o tenant "Prefeitura B" tem um feriado municipal na mesma semana
    When o tenant "Prefeitura de São José" calcular dias úteis para a mesma semana via "CAL-06"
    Then o feriado municipal de "Prefeitura B" não deve ser considerado no cálculo

  Scenario: [Duplicidade] Mesmo feriado cadastrado duas vezes
    Given que existe o feriado "Aniversário da cidade" em 12/10/2026
    When o administrador tentar cadastrar outro feriado com a mesma data e nome
    Then a API deve responder 409 com código "CONFLICT"

  Scenario: [Concorrência] Cadastro simultâneo do mesmo feriado
    When dois administradores enviarem "POST" simultâneos para o mesmo feriado
    Then apenas um deve receber 201
    And o outro deve receber 409 com código "CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao cadastrar feriado
    Given que o banco de dados fica indisponível
    When o administrador tentar cadastrar um feriado
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"

  Scenario: [Falha de integração] CAL-06 indisponível para quem calcula prazo
    Given que o serviço de calendário está indisponível
    When outra story tentar calcular "dueAt" via "CAL-06"
    Then a resposta deve ser 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tramitação que depende do cálculo deve poder ser repetida sem duplicar efeitos
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| Feriado duplicado | 409 | `CONFLICT` | "Já existe um feriado com esta data e nome." | Erro no formulário |
| Excluir feriado de sistema | 409 | `CATALOG_ITEM_SYSTEM` | "Feriados padrão do sistema não podem ser excluídos." | Sem botão "Excluir" para esses registros |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar o calendário." | Oculta ações de edição |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-100 (contexto de tenant). Consumida por US-055 (cálculo de `dueAt`), US-047 (prévia de sobrescrita de prazo), US-099 (seeder `catalog.holidays`).
- **Decisões/ADRs:** DEC-031, DEC-003; ADR-002.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`; `deadlines.warnBeforeBusinessDays` (consumida indiretamente por US-055).
- **Decisões de implementação (a story não fixa):** (1) `year` de `CAL-01` é opcional e vale o ano corrente no fuso do tenant; (2) o seed (entities.md §7) é `NATIONAL` nos 9 feriados de data fixa e `OPTIONAL` em Carnaval (segunda e terça), Quarta-feira de Cinzas e Corpus Christi; a Sexta-feira Santa nasce `MUNICIPAL` (sugerido, para revisão do órgão), todos recorrentes e `isSystem`; (3) o administrador cadastra só `STATE`/`MUNICIPAL`/`OPTIONAL` — `NATIONAL` é reservado ao seed (PATCH também não promove feriado próprio a nacional); (4) feriado de sistema pode ser desativado e ter `scope`/`isRecurring` ajustados, mas não renomeado (o nome é a chave natural do seeder) nem excluído (`CATALOG_ITEM_SYSTEM`); a data de qualquer feriado é imutável (excluir e recadastrar); (5) `businessDays` de `CAL-06` vai de 0 a 1.000, `dayCountType` padrão `BUSINESS`, o dia de partida não conta e o dia é o LOCAL de `fromDateTime` no fuso do tenant; `CALENDAR` soma dias corridos sem olhar feriados; (6) `CAL-05` aceita no máximo 1.100 dias; (7) a ocorrência do ano seguinte é gerada pela tarefa `holiday-year` do job `tenant-housekeeping` (fila `maintenance`, diária), a partir da ocorrência recorrente mais recente de cada nome, herdando escopo e situação; os móveis de sistema são recalculados pela Páscoa; (8) o calendário não é cacheado na API (uma consulta indexada por cálculo); o evento `HolidayChanged` já invalida o prefixo `catalog:holidays` no worker para o cache por ciclo do job de prazos (US-055).
- **Lacunas nas fontes canônicas:** `Holiday.isSystem` (entities.md) não tem, nas fontes canônicas, uma regra explícita de proteção contra exclusão — diferente de `CatalogItem.isSystem` (DEC-027). Adotamos o conceito mais próximo (mesma proteção) e reaproveitamos o código `CATALOG_ITEM_SYSTEM` (409), já que `Holiday` pertence ao mesmo módulo `catalog`; registrado como lacuna.

## Impacto técnico
- O calendário de feriados do tenant deve ser cacheado em memória por ciclo pelo job `deadlines` (US-055) para evitar recomputar a mesma tabela repetidamente em lote.
- Job de manutenção (fila `maintenance`) gera a ocorrência do ano seguinte para feriados recorrentes e recalcula os móveis — deve rodar antes da virada do ano com margem suficiente.
- Normalização para "fim do dia útil" sempre no fuso do tenant (DEC-003), nunca no fuso do servidor.

## Backend
- **Módulo(s):** `catalog` (dono); usa `access` (`AccessFacade.assertCan('CALENDAR_MANAGE')`) e `identity` (`IdentityFacade.mfaPolicy`) — mesma exceção de nível da US-104 (decisions.md §3). A aritmética de datas pura (Páscoa, feriados do seed, `planRecurringHolidays`) fica em `packages/types/src/calendar.ts`, compartilhada com o worker e o web; os contratos CAL-01..06 e o evento, em `packages/validation/src/calendar`.
- **Casos de uso:** `CreateHolidayCommand`, `UpdateHolidayCommand`, `DeleteHolidayCommand`; `ListHolidaysQuery`, `AddBusinessDaysQuery`.
- **Domínio:** `BusinessCalendarFacade.addBusinessDays(tx, from, days, type)` / `.isBusinessDay(tx, date)` / `.listBusinessDaysBetween(tx, from, to)` (exportada pelo módulo; fuso e `calendar.optionalHolidaysAreNonBusiness` do tenant lidos por porta); `easterSunday` (Meeus/Butcher); `HolidayYearGeneratorTask` (worker, `tenant-housekeeping`).
- **Transação:** criação/edição/exclusão de feriado, auditoria e outbox na mesma transação; `CAL-05`/`CAL-06` são leituras, sem efeito colateral.

## Frontend
- **Tela(s):** SCR-110 (`/admin/calendario`).
- **Componentes:** `YearSelector`, `HolidayTable`, `HolidayFormDialog`, selos "Sistema"/"Recorrente".
- **Estados:** skeleton na lista; vazio ("Nenhum feriado cadastrado para este ano" — não ocorre para o ano semeado); erro com "Tentar novamente".
- **Acessibilidade e responsividade:** tabela navegável por teclado; diálogo em tela cheia em telas < 768 px.

## Banco de dados
- **Tabelas:** `holidays`.
- **Migrações:** `20261015270000_holidays` — enum `holiday_scope` e tabela `holidays` (entities.md §4: unicidade `(tenant_id, date, lower(name))`, índice parcial de ativos, gatilhos de imutabilidade e de proteção do feriado de sistema, RLS; `DELETE` só para a aplicação, `SELECT`/`INSERT` para o worker).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, date, lower(name))`; índice `(tenant_id, date) WHERE is_active`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| CAL-01 | GET | `/holidays?year=` | — | `200 { data: [Holiday], meta }` | 200 |
| CAL-02 | POST | `/holidays` | `{ date, name, scope, isRecurring? }` | `201 { data: Holiday }` | 201, 403, 409, 422 |
| CAL-03 | PATCH | `/holidays/{id}` | `{ name?, scope?, isRecurring?, isActive? }` + `If-Match` | `200 { data: Holiday }` | 200, 403, 404, 409, 412, 422 |
| CAL-04 | DELETE | `/holidays/{id}` | `If-Match` | `204` | 204, 403, 404, 409, 412 |
| CAL-05 | GET | `/calendar/business-days?from=&to=` | — | `200 { data: { businessDays: int, dates: [date] } }` | 200, 422 |
| CAL-06 | POST | `/calendar/add-business-days` | `{ fromDateTime, businessDays, dayCountType? }` | `200 { data: { dueDateTime } }` | 200, 422, 503 |

## Logs
- `info` `calendar.holiday_created` / `calendar.holiday_updated` — `holidayId`, `date`, `scope`, `tenantId`.
- `info` `calendar.year_generated` — `year`, quantidade de feriados recorrentes gerados.
- `error` `calendar.easter_calculation_failed` — defensivo; não deveria ocorrer para anos válidos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `holiday.create` | `CONFIGURATION` | Commit de `CAL-02` | `changes`: `date`, `name`, `scope` |
| `holiday.update` | `CONFIGURATION` | Commit de `CAL-03` | `changes`: campos alterados |
| `holiday.delete` | `CONFIGURATION` | Commit de `CAL-04` | `metadata`: `holidayId`, `date` |

## Testes necessários
- **Unitários:** cálculo da Páscoa (Meeus/Butcher) para anos conhecidos; `addBusinessDays` com fins de semana e feriados combinados.
- **Integração (Testcontainers PostgreSQL):** isolamento de calendário por tenant; índice único `(tenant_id, date, lower(name))`.
- **Concorrência:** dois cadastros simultâneos do mesmo feriado → um 201, outro 409 `CONFLICT`.
- **API/contrato:** `CAL-06` conforme api.md (datas ISO 8601, `dayCountType`).
- **E2E (Playwright):** cadastrar feriado e observar o novo prazo de uma tramitação (ponte com US-055).
- **Acessibilidade/performance:** axe na tela de calendário.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `CALENDAR_MANAGE` aplicado na API; ações de edição ocultas sem permissão
- [ ] Cálculo da Páscoa e geração do ano seguinte cobertos por teste
- [ ] Auditoria `holiday.*` e evento `HolidayChanged` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `CAL-01..06` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace presentes
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — CRUD simples de feriados mais um algoritmo determinístico (Páscoa) e um endpoint de soma de dias úteis já consumido por outra story (US-055); sem orquestração transacional complexa.

## Prioridade
**P1** — necessário para o cálculo correto de prazos (US-055), mas não bloqueia a abertura do primeiro processo com os feriados nacionais já semeados.
