---
id: US-075
title: "Consultar e exportar a trilha de auditoria"
epic: EP-013
feature: FT-045
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-073, US-097]
modules: [audit]
screens: [SCR-037]
endpoints: [AUD-01, AUD-02, AUD-03]
permissions: [AUDIT_VIEW, AUDIT_EXPORT]
events: []
---

# US-075 — Consultar e exportar a trilha de auditoria

## Título
Consultar e exportar a trilha de auditoria

## Descrição
**Como** responsável por conformidade e segurança do órgão (auditor, administrador ou controle externo), **quero** pesquisar a trilha de auditoria por período, ator, ação, entidade ou processo, ver o detalhe de cada registro e exportar o resultado em CSV ou NDJSON, **para** responder a diligências do TCU/TCE, investigar incidentes e comprovar conformidade com a Lei 14.133/2021 sem depender de acesso direto ao banco de dados.

A consulta (SCR-037, `/auditoria`) exige um período de no máximo 90 dias, oferece paginação por cursor e exibe o diff de `changes` já mascarado. A exportação reaproveita os mesmos filtros, limita-se a 100 mil linhas por vez e aplica proteção contra injeção de fórmulas (CSV injection).

## Contexto
- DEC-025 define a auditoria como evidência de conformidade e segurança, com acesso restrito a quem tem `AUDIT_VIEW` — diferente da timeline, visível a quem vê o processo. DEC-132 restringe o tenant em `OFFBOARDING` a leitura e exportação somente para `ADMIN_ORGAO`/`AUDITOR`, com todos os comandos bloqueados (guarda obrigatória de documentos públicos durante o encerramento).
- A trilha é gerada por US-073 e, opcionalmente, selada por US-074; esta story não grava nada na trilha (além de auditar a própria consulta/exportação — `audit.search`/`audit.export`, catálogo de events.md §7) — é a janela de leitura sobre o que já existe.
- Volume: `audit_logs` é particionada por mês e pode crescer rapidamente (toda ação mutável do produto gera ao menos um registro); por isso o período é limitado e a exportação tem teto de linhas (`EXPORT_TOO_LARGE`).

## Objetivo
Permitir que um auditor encontre um registro específico (por período + um filtro adicional) em até 3 cliques e exporte até 100 mil linhas em menos de 30 segundos, com 0% de falso negativo nos filtros aplicados e sem expor dado mascarado.

## Persona
- **Principal:** Auditor / controle interno (perfil `AUDITOR`, `AUDIT_VIEW` e `AUDIT_EXPORT`).
- **Secundárias:** Administrador do órgão (`ADMIN_ORGAO`); auditor externo (TCE, vínculo `EXTERNAL` com perfil `AUDITOR` — POL-15).

## Pré-condições
- Usuário autenticado, tenant em status que permita a consulta (`ACTIVE`, ou `OFFBOARDING` se `ADMIN_ORGAO`/`AUDITOR` — DEC-132).
- Usuário possui `AUDIT_VIEW` (consulta/detalhe) e, para exportar, `AUDIT_EXPORT`.
- MFA ativo na sessão quando exigido por `POL-14`/`security.mfaPolicy`.

## Fluxo principal
1. O auditor acessa SCR-037 (`/auditoria`) a partir do menu de conformidade.
2. O sistema exibe o painel de filtros com **período** (obrigatório, padrão últimos 7 dias, máximo 90 dias), e opcionais: ator, ação, categoria, resultado, tipo/id de entidade, processo.
3. O auditor ajusta os filtros e clica em "Pesquisar"; o front chama `AUD-01` (`GET /api/v1/audit`) com os filtros e `cursor`/`limit`.
4. A API autoriza (`AUDIT_VIEW`), valida o período (≤ 90 dias) e devolve a página de resultados ordenada por `occurredAt` decrescente, com `meta.nextCursor`.
5. A lista exibe, por linha: data/hora, ator, ação (rótulo pt-BR), categoria, resultado, entidade/processo relacionado.
6. O auditor clica em uma linha; o front chama `AUD-02` (`GET /api/v1/audit/{id}`) e abre o painel de detalhe com todos os campos, incluindo o diff de `changes` (path/old/new, já mascarado) e `metadata`.
7. Para exportar, o auditor clica em "Exportar" (mantendo os filtros aplicados), escolhe o formato (CSV ou NDJSON) e confirma.
8. O front chama `AUD-03` (`GET /api/v1/audit/export`) com os mesmos filtros e `format`; a API autoriza (`AUDIT_EXPORT`), valida que o total estimado não excede 100 mil linhas e produz o arquivo com os valores de texto escapados contra CSV injection (RN-AUD-20).
9. A API responde com o arquivo (`Content-Disposition: attachment`) e registra `audit.export` com os filtros em `metadata`.
10. O front dispara o download e exibe o toast "Exportação concluída: {N} registros".

## Fluxos alternativos
- **FA-01 — Resultado vazio:** nenhum registro no período/filtros exibe o estado vazio "Nenhum registro de auditoria encontrado para os filtros selecionados." com sugestão de ampliar o período.
- **FA-02 — Exportação acima do limite:** se a contagem estimada exceder 100 mil linhas, a API responde `422 EXPORT_TOO_LARGE` antes de gerar o arquivo; a UI sugere reduzir o período ou adicionar filtros.
- **FA-03 — Tenant em `OFFBOARDING`:** vínculos `ADMIN_ORGAO`/`AUDITOR` continuam acessando `AUD-01`/`AUD-02`/`AUD-03` normalmente; demais perfis recebem `403 TENANT_SUSPENDED` ao tentar qualquer ação no tenant, incluindo a consulta de auditoria (DEC-132).
- **FA-04 — MFA exigido no meio da sessão:** se a sessão perder o fator MFA (expiração do step-up) entre a consulta e a exportação, `AUD-03` responde `403 MFA_REQUIRED`; a UI dispara o step-up e repete a exportação após a confirmação.
- **FA-05 — Detalhe de registro coalescido:** ao abrir o detalhe de um `document.draft_update` coalescido (US-073, RN-AUD-06), o painel informa "Este registro resume múltiplas edições entre {primeiro} e {último} salvamento" quando `metadata` trouxer essa informação.

## Regras de negócio
- **RN-AUD-17** — `AUD-01` exige `occurredFrom`/`occurredTo` com intervalo máximo de 90 dias; aceita filtros combináveis (E lógico entre parâmetros distintos, OU por vírgula dentro do mesmo parâmetro — api.md §1.2): `tenantId` implícito da sessão, `entityType`, `entityId`, `processId`, `actorUserId`, `action`, `category`, `result`; paginação por cursor (`occurredAt`, `id`) decrescente, `limit` máximo 100.
- **RN-AUD-18** — `AUD-02` retorna o `AuditLog` completo; quando houver `changes`, apresenta o diff `path`/`old`/`new` já mascarado — a API nunca desmascara um valor armazenado mascarado/resumido (hash + tamanho permanece hash + tamanho).
- **RN-AUD-19** — `AUD-03` aceita os mesmos filtros de `AUD-01` (sem paginação) e `format` (`csv` ou `ndjson`, padrão `csv`); limite de 100.000 linhas por exportação — acima disso, `422 EXPORT_TOO_LARGE` pedindo refinar os filtros antes de tentar novamente.
- **RN-AUD-20** — No formato `csv`, qualquer valor textual iniciado por `=`, `+`, `-`, `@`, tabulação ou retorno de carro recebe um apóstrofo (`'`) como prefixo de escape antes de ser escrito na célula, neutralizando fórmulas ao abrir em Excel/Sheets (prevenção de CSV injection).
- **RN-AUD-21** — `AUDIT_VIEW` e `AUDIT_EXPORT` são permissões de risco `H`, sem escopo de unidade (aplicam-se ao tenant inteiro); por `POL-14`, exigem sessão com MFA ativo quando `security.mfaPolicy` for `ADMINS` (perfil com alguma permissão `H`) ou `ALL` — senão `403 MFA_REQUIRED`.
- **RN-AUD-22** — Durante `TenantStatus = OFFBOARDING`, `AUD-01`/`AUD-02`/`AUD-03` permanecem disponíveis apenas para vínculos `ADMIN_ORGAO` ou `AUDITOR` (DEC-132); demais perfis recebem `403 TENANT_SUSPENDED` para qualquer ação no tenant, incluindo a consulta de auditoria.
- **RN-AUD-23** — `audit.search` (categoria `ACCESS`) e `audit.export` (categoria `EXPORT`) são eles próprios registrados no `AuditLog` (via `AuditService`, US-073), com os filtros aplicados em `metadata` — permitindo auditar quem consultou ou exportou a auditoria.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Período (de/até) | `occurredFrom`, `occurredTo` | data/hora | Sim | intervalo ≤ 90 dias; RN-AUD-17 | últimos 7 dias |
| Ator | `actorUserId` | seleção | Não | usuário do tenant | — |
| Ação | `action` | seleção múltipla | Não | catálogo events.md §7 | — |
| Categoria | `category` | seleção (`AuditCategory`) | Não | enum | — |
| Resultado | `result` | seleção (`AuditResult`) | Não | enum | — |
| Entidade | `entityType`, `entityId` | texto/seleção | Não | — | — |
| Processo | `processId` | seleção/busca | Não | — | — |
| Formato de exportação | `format` | seleção (`csv`/`ndjson`) | Não | RN-AUD-19 | `csv` |
| *(cursor)* Paginação | `cursor`, `limit` | opaco, int | Não | `limit` ≤ 100 | `limit = 50` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Período ausente ou acima de 90 dias | Front + API | "Selecione um período de até 90 dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `occurredTo` anterior a `occurredFrom` | Front + API | "A data final deve ser posterior à inicial." | `VALIDATION_ERROR` |
| V-03 | `limit` acima de 100 | API | — (API ajusta para o máximo) | — |
| V-04 | Exportação acima de 100 mil linhas | API | "Muitos registros para exportar ({N}). Refine o período ou os filtros." | `EXPORT_TOO_LARGE` |
| V-05 | `format` fora de `csv`/`ndjson` | Front + API | "Selecione um formato de exportação válido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-06 | `id` de `AUD-02` inexistente ou de outro tenant | API | "Registro de auditoria não encontrado." | `NOT_FOUND` |

## Permissões
- **Permissão:** `AUDIT_VIEW` para `AUD-01`/`AUD-02`; `AUDIT_EXPORT` para `AUD-03` (ambas risco `H`, sem escopo de unidade).
- **Políticas:** `POL-14` (MFA, RN-AUD-21); DEC-132 (restrição adicional durante `OFFBOARDING`, RN-AUD-22); POL-15 (perfil `AUDITOR` é o único de risco `H` liberado para vínculos `EXTERNAL`, cobrindo o caso do TCE).
- **MFA:** exigido conforme `POL-14`/`security.mfaPolicy`.
- **Sem permissão:** o item de menu "Auditoria" e a rota `/auditoria` não são exibidos/acessíveis; a API responde `403 PERMISSION_DENIED` e registra `access.denied` com `reasonCode` = `AUDIT_VIEW` ou `AUDIT_EXPORT`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio. Consultar/exportar não altera estado; a própria consulta é registrada como `AuditLog` (RN-AUD-23), não como evento de outbox. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. A exportação é síncrona (download direto); não há notificação de conclusão. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Consultar e exportar a trilha de auditoria

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Clara" possui o perfil "AUDITOR" com "AUDIT_VIEW" e "AUDIT_EXPORT"
    And "Clara" está com MFA ativo na sessão

  Scenario: [Sucesso] Pesquisar por período e ação, e ver o detalhe
    Given que existem registros de auditoria de "process.create" nos últimos 7 dias
    When "Clara" pesquisar com o período padrão e a ação "process.create"
    Then a lista deve exibir somente registros de "process.create" no período
    And ao abrir um registro o painel deve mostrar o diff de "changes" mascarado
    And deve gerar registro de auditoria "audit.search" com os filtros em metadata

  Scenario: [Validação] Período acima de 90 dias
    When "Clara" informar um período de 120 dias
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And a mensagem deve pedir um período de até 90 dias

  Scenario: [Permissão] Usuário sem AUDIT_EXPORT não exporta
    Given que "Bruno" possui "AUDIT_VIEW" mas não "AUDIT_EXPORT"
    When "Bruno" enviar GET para "/api/v1/audit/export" com filtros válidos
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" igual a "AUDIT_EXPORT"
    And o botão "Exportar" não deve ser exibido para "Bruno"

  Scenario: [Tenant incorreto] Registro de auditoria de outro tenant
    Given que existe um "AuditLog" do tenant "Prefeitura B" com id "X"
    When "Clara", no tenant "Prefeitura de São José", enviar GET para "/api/v1/audit/X"
    Then a API deve responder 404 com código "NOT_FOUND"
    And a resposta não deve revelar que o registro existe em outro tenant

  Scenario: [Duplicidade] Exportações repetidas com os mesmos filtros
    Given que "Clara" já exportou os registros de "2026-09-01" a "2026-09-07"
    When "Clara" exportar novamente os mesmos filtros
    Then a API deve gerar um novo arquivo com o mesmo conteúdo
    And devem existir dois registros de auditoria "audit.export" distintos (cada exportação é um evento próprio, não é idempotente)

  Scenario: [Concorrência] Múltiplas exportações simultâneas do mesmo tenant
    Given que três auditores iniciam exportações simultâneas com filtros diferentes
    When todas as requisições forem processadas
    Then cada uma deve receber o arquivo correspondente aos seus próprios filtros
    And nenhuma exportação deve conter linhas de outro conjunto de filtros

  Scenario: [Falha de banco] Banco indisponível durante a pesquisa
    Given que o banco de dados fica indisponível
    When "Clara" pesquisar a auditoria
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a UI deve exibir "Não foi possível consultar a auditoria agora. Tente novamente em instantes." com o correlationId

  Scenario: [Falha de integração] Exportação acima do limite de linhas
    Given que o período e os filtros selecionados resultam em 150.000 registros
    When "Clara" tentar exportar
    Then a API deve responder 422 com código "EXPORT_TOO_LARGE"
    And a UI deve sugerir reduzir o período ou adicionar filtros

  Scenario: [Sucesso] Exportação em CSV neutraliza fórmulas
    Given que existe um registro cujo "actorName" começa com "=SOMA("
    When "Clara" exportar os registros em CSV
    Then o valor exportado para "actorName" deve começar com um apóstrofo antes do "="
    And o arquivo não deve executar fórmulas ao ser aberto em planilha
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Período ausente/acima de 90 dias | 422 | `VALIDATION_ERROR` | "Selecione um período de até 90 dias." | Foca o seletor de datas |
| Formato de exportação inválido | 422 | `VALIDATION_ERROR` | "Selecione um formato de exportação válido." | Reseta para "csv" |
| Exportação acima do limite | 422 | `EXPORT_TOO_LARGE` | "Muitos registros para exportar ({N}). Refine o período ou os filtros." | Mantém filtros; destaca período |
| Registro inexistente/outro tenant | 404 | `NOT_FOUND` | "Registro de auditoria não encontrado." | Fecha o painel de detalhe |
| Sem permissão de visualização/exportação | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Item de menu/botão ocultos |
| MFA ausente | 403 | `MFA_REQUIRED` | "Esta ação exige verificação adicional (MFA)." | Dispara step-up e repete a ação após confirmação |
| Tenant em encerramento, perfil não elegível | 403 | `TENANT_SUSPENDED` | "Seu acesso a este órgão está restrito durante o encerramento." | Redireciona para SCR-111 |
| Limite de requisições (exportação) | 429 | `RATE_LIMITED` | "Muitas exportações em sequência. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível consultar a auditoria agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe correlationId |

## Dependências
- **Stories:** US-073 (gera a trilha consultada; sem ela não há o que pesquisar/exportar), US-097 (autorização na API e no frontend — aplica `AUDIT_VIEW`/`AUDIT_EXPORT` e oculta UI sem permissão). Indireta: US-074 (selos, consultados em tela vizinha de SCR-037, não nesta story).
- **Decisões/ADRs:** DEC-025, DEC-132, DEC-138; POL-14, POL-15.
- **Configurações:** `audit.export.maxRows` (100.000), `audit.search.maxPeriodDays` (90).
- **Lacunas nas fontes canônicas:** nenhuma — filtros, limites e restrição de `OFFBOARDING` constam nas notas de domínio do pacote e em DEC-132/permissions.md; os valores numéricos (90 dias, 100 mil linhas) já vêm explícitos nas notas do épico, não são suposição.

## Impacto técnico
- Toda consulta exige filtro de período (RN-AUD-17) justamente para garantir *partition pruning* em `audit_logs` (particionada por mês) e manter a latência previsível mesmo em tenants de alto volume.
- A exportação de até 100 mil linhas deve ser *streaming* (não carregar tudo em memória) para CSV e NDJSON, usando os mesmos índices da consulta.
- A proteção contra CSV injection (RN-AUD-20) deve ser aplicada em toda coluna de texto livre exportada (não só `actorName`), incluindo valores dentro de `metadata` quando "achatados" para colunas.
- `AUD-02` nunca desmascara um valor — o mascaramento é definitivo desde a gravação (US-073); não existe "elevação de privilégio" que revele o conteúdo original.

## Backend
- **Módulo(s):** `audit` (dono); usa a fachada de `access` (`AuthorizationService.assertCan('AUDIT_VIEW'|'AUDIT_EXPORT')`).
- **Casos de uso:** `SearchAuditLogsQuery` → `SearchAuditLogsHandler` (`AUD-01`); `GetAuditLogQuery` → `GetAuditLogHandler` (`AUD-02`); `ExportAuditLogsQuery` → `ExportAuditLogsHandler` (`AUD-03`, *streaming*).
- **Domínio:** `AuditLogPresenter` (formata diff de `changes`, aplica rótulos pt-BR de `action`/`category`/`result` via terminology.md); `CsvInjectionEscaper`; `AuditExportWriter` (CSV/NDJSON).
- **Transação:** somente leitura; `AUD-01`/`AUD-02`/`AUD-03` não abrem transação de escrita de negócio — a gravação de `audit.search`/`audit.export` (RN-AUD-23) usa sua própria transação curta via `AuditService`.

## Frontend
- **Tela(s):** SCR-037 (`/auditoria`), aba "Registros" (padrão).
- **Componentes:** `DateRangePicker` (limite de 90 dias), `AuditFiltersPanel` (ator, ação, categoria, resultado, entidade, processo), `AuditResultsTable` (cursor/"carregar mais"), `AuditDetailPanel` (diff `path`/`old`/`new`), `ExportDialog` (formato + confirmação), `CollapsibleSection` para filtros avançados.
- **Dados:** TanStack Query — `['t', tenantId, 'audit', filters]` com paginação por cursor; `useMutation` para disparo de exportação (download via `blob`/`Content-Disposition`).
- **Estados:** skeleton na tabela; vazio ("Nenhum registro de auditoria encontrado para os filtros selecionados."); erro de carregamento com "Tentar novamente"; botão "Exportar" com estado de carregamento e desabilitado durante a geração do arquivo.
- **Acessibilidade e responsividade:** filtros navegáveis por teclado; diff de `changes` com contraste AA e rótulos "antes"/"depois" (não só cor); tabela com colunas priorizadas em telas < 768 px (data, ação, resultado).

## Banco de dados
- **Tabelas:** leitura de `audit_logs` (criada por US-073); nenhuma tabela nova.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, occurred_at DESC)`, `(tenant_id, entity_type, entity_id, occurred_at DESC)`, `(tenant_id, process_id, occurred_at DESC)`, `(tenant_id, actor_user_id, occurred_at DESC)`, `(tenant_id, action, occurred_at DESC)` (entities.md §4); o filtro de período obrigatório garante a eliminação de partições fora do intervalo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| AUD-01 | GET | `/api/v1/audit` | `?occurredFrom&occurredTo&actorUserId?&action?&category?&result?&entityType?&entityId?&processId?&cursor?&limit?` | `200 { data: [AuditLog], meta: { nextCursor, hasMore } }` | 200, 401, 403, 422, 429, 503 |
| AUD-02 | GET | `/api/v1/audit/{id}` | — | `200 { data: AuditLog }` (com diff de `changes`) | 200, 403, 404, 429 |
| AUD-03 | GET | `/api/v1/audit/export` | mesmos filtros de `AUD-01` (sem cursor) `&format=csv\|ndjson` | `200` arquivo (`text/csv` ou `application/x-ndjson`), `Content-Disposition: attachment` | 200, 403, 422, 429, 503 |

## Logs
- `info` `audit.search_executed` — `tenantId`, `userId`, quantidade de filtros aplicados, `durationMs` (sem valores dos filtros sensíveis).
- `info` `audit.export_executed` — `tenantId`, `userId`, `format`, `rowCount`, `durationMs`.
- `warn` `audit.export_too_large` — tentativa de exportação acima do limite, com contagem estimada.
- `error` `audit.query_failed` — falha ao consultar/exportar; `correlationId` (stack apenas em nível `debug`).
- **Nunca logar:** conteúdo de `changes`/`metadata` dos registros retornados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `audit.search` | `ACCESS` | Toda chamada a `AUD-01`/`AUD-02` | `metadata`: filtros aplicados (período, ação, categoria, ator, entidade) |
| `audit.export` | `EXPORT` | Toda chamada a `AUD-03` | `metadata`: filtros aplicados, `format`, `rowCount` |
| `access.denied` | `ACCESS` | Tentativa sem `AUDIT_VIEW`/`AUDIT_EXPORT` ou sem MFA | `reasonCode` = `AUDIT_VIEW`/`AUDIT_EXPORT`/`MFA_REQUIRED` |

## Testes necessários
- **Unitários:** `CsvInjectionEscaper` (todos os caracteres-gatilho); formatação do diff de `changes`; validação de período (90 dias) e de `limit`.
- **Integração (Testcontainers PostgreSQL):** consulta com *partition pruning* correto; exportação *streaming* até 100 mil linhas sem exceder memória; `EXPORT_TOO_LARGE` acima do limite.
- **API/contrato:** `AUD-01`/`AUD-02`/`AUD-03` conforme api.md (paginação por cursor, cabeçalhos de arquivo); snapshot do OpenAPI.
- **RBAC e multi-tenant:** matriz `AUDIT_VIEW`/`AUDIT_EXPORT` presentes/ausentes; `POL-14` (MFA); restrição de `OFFBOARDING` (DEC-132) com `ADMIN_ORGAO`/`AUDITOR` vs. demais perfis; registro de outro tenant → 404; isolamento na suíte "tenant leak".
- **Concorrência:** exportações simultâneas com filtros diferentes não se misturam.
- **E2E (Playwright):** jornada "filtrar → ver detalhe → exportar CSV"; verificação visual de que um valor "=SOMA(...)" sai escapado no arquivo gerado.
- **Acessibilidade/performance:** axe na tela de auditoria; exportação de 100 mil linhas completa em até 30 s (meta inicial); k6 em `AUD-01` dentro da classe de rate limit "Leitura" (api.md §1.6).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `AUDIT_VIEW`/`AUDIT_EXPORT` e `POL-14` (MFA) aplicados na API; menu/rota ocultos sem permissão
- [ ] Restrição de tenant `OFFBOARDING` (DEC-132) coberta por teste dedicado
- [ ] Proteção contra CSV injection verificada por teste automatizado
- [ ] `EXPORT_TOO_LARGE` e *streaming* até 100 mil linhas comprovados em teste de integração
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `AUD-01`/`AUD-02`/`AUD-03` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `audit_search_total`, `audit_export_total` e latência
- [ ] Tela acessível (axe) e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — consulta e exportação sobre uma trilha já existente (US-073), com regras de filtro/limite e UI de uma tela, sem modelagem de dados nova.

## Prioridade
**P0** — sem consulta, a trilha gravada por US-073 é inacessível na prática (só existiria via acesso direto ao banco); é o valor de negócio visível do épico para auditores e controle externo.
