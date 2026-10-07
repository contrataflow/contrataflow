---
id: US-034
title: "Gerenciar ações de tratamento de riscos"
epic: EP-005
feature: FT-022
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-033]
modules: [risk, process, access, audit, platform]
screens: [SCR-011]
endpoints: [RSK-03, RSK-06, RSK-07, RSK-08, USR-01, USR-02, DEP-01]
permissions: [RISK_MANAGE]
events: [RiskTreatmentChanged]
---

# US-034 — Gerenciar ações de tratamento de riscos

## Título
Gerenciar ações de tratamento de riscos

## Descrição
**Como** gestor de contratações (ou integrante da equipe de planejamento), **quero** cadastrar e acompanhar ações de prevenção e de contingência para os riscos registrados (US-033), **para** reduzir a probabilidade/impacto dos riscos ou preparar a resposta caso eles se materializem.

Cada risco pode ter uma ou mais ações de tratamento (`RiskTreatment`), classificadas como **Prevenção** (`PREVENTIVE`) ou **Contingência** (`CONTINGENCY`), com responsável, prazo e status próprio (`PLANNED` → `IN_PROGRESS` → `DONE`, ou `CANCELED`). O cadastro do primeiro tratamento ativo move o risco de `OPEN` para `IN_TREATMENT`, dando visibilidade do andamento na tela de riscos (SCR-011) e, futuramente, na matriz e no Mapa de Riscos (US-035).

## Contexto
- DEC-021 define `RiskTreatment` (ações `PREVENTIVE`/`CONTINGENCY`, responsável, prazo, status) como parte do módulo de riscos, vinculado 1:N ao `Risk` registrado em US-033.
- Hoje o acompanhamento de ações de mitigação, quando existe, é feito fora do processo (planilhas, e-mails), sem relação formal com o risco que originou a ação nem com seu prazo.
- O Mapa de Riscos (US-035) exige, para riscos de nível Alto/Extremo, ao menos um tratamento registrado antes de poder ser finalizado — esta story é pré-requisito direto daquela validação de completude.

## Objetivo
Permitir que um usuário autorizado cadastre uma ação de tratamento em menos de 1 minuto, com 100% dos riscos que recebem o primeiro tratamento ativo transicionando automaticamente para `IN_TREATMENT`, e com o prazo e o status de cada ação visíveis e atualizáveis a qualquer momento.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`).
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Área requisitante (`REQUISITANTE`).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Existe ao menos um risco (`Risk`) registrado no processo (US-033).
- Usuário possui `RISK_MANAGE` em escopo que cubra o processo.
- Processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`; `RISK_MAP` do processo (se existir) em `DRAFT`/`RETURNED`.

## Fluxo principal
1. Na tela **Riscos** (SCR-011), o usuário expande um risco e clica **"Nova ação de tratamento"**.
2. O usuário escolhe o tipo (**Prevenção** ou **Contingência**), descreve a ação, define responsável (usuário via `USR-02` ou unidade via `DEP-01`) e prazo (opcional), e salva.
3. O front envia `POST /api/v1/risks/{id}/treatments` (`RSK-06`).
4. A API, em transação: valida o corpo; autoriza `RISK_MANAGE` + editabilidade (RN-RISK-16); grava o tratamento com `status = PLANNED`; se o risco estiver `OPEN`, transiciona-o para `IN_TREATMENT` (RN-RISK-14); grava auditoria `risk.treatment_create` e o evento `RiskTreatmentChanged` (`change = CREATED`).
5. A API responde **201**; a UI exibe a ação na lista do risco, com destaque de prazo ("Vence em 5 dias" / "Atrasado").
6. Para avançar o andamento, o usuário altera o status (`PLANNED` → `IN_PROGRESS` → `DONE`) pela ação **"Atualizar status"**; o front envia `PATCH /api/v1/risk-treatments/{treatmentId}` (`RSK-07`) com `If-Match`.
7. Ao mudar o status para `DONE`, a API preenche `completedAt = now()` automaticamente; ao sair de `DONE`, `completedAt` é limpo.
8. O usuário pode editar descrição, responsável, prazo e observações a qualquer momento enquanto o risco não estiver bloqueado (RN-RISK-16); cada edição gera `RiskTreatmentChanged` (`change = UPDATED` ou `STATUS_CHANGED`).
9. Para remover uma ação sem efeito, o usuário usa **"Excluir"** (`DELETE /risk-treatments/{treatmentId}`, `RSK-08`), com exclusão lógica (`+SD`).

## Fluxos alternativos
- **FA-01 — Cancelar em vez de excluir:** o usuário muda o status para `CANCELED` quando a ação deixou de ser necessária, preservando o histórico (preferível a excluir).
- **FA-02 — Vários tratamentos para o mesmo risco:** a lista ordena por `sortOrder`/prazo; o usuário pode reordenar (atualiza `sortOrder` nos itens afetados).
- **FA-03 — Prazo vencido:** a UI calcula "Atrasado" em runtime (`dueDate < hoje` e `status` ∉ `{DONE, CANCELED}`); não há campo persistido nem notificação dedicada nesta story.
- **FA-04 — Tratamento é o único ativo e é cancelado/excluído:** o status do risco **não** reverte automaticamente para `OPEN`; o ajuste, se desejado, é manual via `RSK-04` (US-033).
- **FA-05 — Processo/documento bloqueado:** com o `RISK_MAP` fora de `DRAFT`/`RETURNED`, as ações de criar/editar/excluir tratamento ficam desabilitadas, com o mesmo aviso de FA-04 de US-033.

## Regras de negócio
- **RN-RISK-11** — Obrigatórios: `riskId` (via rota), `type`, `description`; `status` inicial `PLANNED`.
- **RN-RISK-12** — `completedAt` é preenchido automaticamente com `now()` quando `status` muda para `DONE`, e limpo se o status mudar para qualquer outro valor.
- **RN-RISK-13** — `responsibleId` (usuário) e `responsibleDepartmentId` (unidade) são mutuamente opcionais e não exclusivos; nenhum é obrigatório.
- **RN-RISK-14** — Ao criar o primeiro tratamento com `status ≠ CANCELED` de um risco em `status = OPEN`, o risco transiciona automaticamente para `IN_TREATMENT`.
- **RN-RISK-15** — Transições de `status` permitidas: `PLANNED → IN_PROGRESS → DONE`; qualquer status não terminal pode ir para `CANCELED`; `DONE` e `CANCELED` são terminais no MVP 1 (reabertura de tratamento concluído/cancelado não é suportada); transição fora dessas: `INVALID_STATE` (409).
- **RN-RISK-16** — Criar, editar ou excluir um tratamento exige a mesma condição de editabilidade de RN-RISK-09 (processo ativo e, se existir, `RISK_MAP` em `DRAFT`/`RETURNED`).
- **RN-RISK-17** — Excluir um tratamento é exclusão lógica (`+SD`); não afeta o `code` do risco nem os demais tratamentos.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo | `type` | seleção (`TreatmentType`) | Sim | `PREVENTIVE` ("Prevenção") / `CONTINGENCY` ("Contingência") | — |
| Descrição | `description` | texto longo | Sim | 10–1.000 caracteres | — |
| Responsável | `responsibleId` | seleção de usuário | Não | RN-RISK-13 | — |
| Unidade responsável | `responsibleDepartmentId` | seleção de unidade | Não | ativa; RN-RISK-13 | — |
| Prazo | `dueDate` | data | Não | sem restrição de passado (FA-03) | — |
| Status | `status` | seleção (`TreatmentStatus`) | Sim | RN-RISK-15 | `PLANNED` |
| Observações | `notes` | texto longo | Não | até 1.000 caracteres | — |
| *(sistema)* Concluído em | `completedAt` | timestamptz | — | RN-RISK-12 | gerado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios presentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | Limite de tamanho da descrição/observações | Front + API | "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` |
| V-03 | `responsibleId`/`responsibleDepartmentId` inexistente, inativo ou de outro tenant | API | "Selecione um responsável válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Transição de status não permitida (RN-RISK-15) | API | "Não é possível mudar o status de {atual} para {novo}." | `INVALID_STATE` |
| V-05 | Tratamento bloqueado (RN-RISK-16) | API | "As ações de tratamento estão bloqueadas porque o Mapa de Riscos foi concluído." | `DOCUMENT_NOT_EDITABLE` |
| V-06 | Escopo de `RISK_MANAGE` não cobre o processo | API | "Você não tem permissão para gerenciar tratamentos deste risco." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `RISK_MANAGE` com escopo que cubra o `requestingDepartmentId` do processo do risco.
- **Políticas:** RN-RISK-16 (mesma condição de editabilidade de RN-RISK-09, US-033).
- **MFA:** não exigido (`RISK_MANAGE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Nova ação de tratamento" e as ações de editar/excluir/mudar status não são exibidas; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RiskTreatmentChanged` | `risk.treatment_changed` | Criação, edição, mudança de status ou exclusão | `riskId`, `treatmentId`, `change` (`CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED`), `status` |

Sem projeção automática em timeline/notificação/métricas para este evento (consumo interno do módulo `risk`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação dedicada nesta story; prazos vencidos são destacados visualmente na tela de riscos (FA-03). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar ações de tratamento de riscos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o processo "0012/2026" em status "IN_PROGRESS"
    And existe o risco "R01" com status "OPEN" nesse processo
    And o usuário "Ana" tem vínculo ativo e possui "RISK_MANAGE" com escopo que cobre o processo

  Scenario: [Sucesso] Criar a primeira ação de tratamento de um risco aberto
    When "Ana" criar um tratamento "PREVENTIVE" para o risco "R01" com descrição e responsável
    Then o tratamento deve ser criado com status "PLANNED"
    And o risco "R01" deve passar para o status "IN_TREATMENT"
    And deve gerar registro de auditoria "risk.treatment_create"
    And deve gerar o evento RiskTreatmentChanged com "change" igual a "CREATED"

  Scenario: [Sucesso] Concluir uma ação de tratamento
    Given que o tratamento "T01" do risco "R01" está "IN_PROGRESS"
    When "Ana" mudar o status de "T01" para "DONE"
    Then o campo "completedAt" deve ser preenchido com a data e hora atuais
    And deve gerar o evento RiskTreatmentChanged com "change" igual a "STATUS_CHANGED"

  Scenario: [Validação] Descrição ausente
    When "Ana" tentar criar um tratamento sem informar a descrição
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "description"
    And nenhum tratamento deve ser criado

  Scenario: [Validação] Transição de status não permitida
    Given que o tratamento "T02" está "DONE"
    When "Ana" tentar mudar o status de "T02" para "IN_PROGRESS"
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Permissão] Usuário sem RISK_MANAGE
    Given que o usuário "Bruno" não possui "RISK_MANAGE"
    When "Bruno" enviar POST para criar um tratamento no risco "R01"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Responsável de outro tenant
    Given que existe o usuário "Carlos" vinculado apenas ao tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar "responsibleId" de "Carlos"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "responsibleId"
    And a resposta não deve revelar que o usuário existe em outro tenant

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Ana" criou o tratamento "T03" com a chave de idempotência "K9"
    When a mesma requisição for reenviada com a chave "K9"
    Then a API deve responder 201 com o mesmo tratamento "T03" e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Edição concorrente do mesmo tratamento
    Given que "Ana" e "Carla" abriram o tratamento "T01" com "ETag" igual a "1"
    When "Ana" salvar sua alteração e "Carla" tentar salvar com "If-Match" igual a "1"
    Then a resposta a "Carla" deve ser 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao atualizar o status
    Given que o banco de dados fica indisponível durante a atualização
    When "Ana" tentar mudar o status do tratamento "T01"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o status do tratamento não deve ser alterado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" criar um tratamento válido
    Then o tratamento deve ser criado e a API deve responder 201
    And o evento RiskTreatmentChanged deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (schema) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um responsável válido." | Recarrega opções do campo |
| Transição de status inválida | 409 | `INVALID_STATE` | "Não é possível mudar o status de {atual} para {novo}." | Reverte seleção de status |
| Tratamentos bloqueados | 409 | `DOCUMENT_NOT_EDITABLE` | "As ações de tratamento estão bloqueadas porque o Mapa de Riscos foi concluído." | Desabilita ações; mostra link para o documento |
| Sem permissão/escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar tratamentos deste risco." | Oculta botões de ação |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Esta ação foi alterada por outra pessoa. Recarregue para ver a versão atual." | Recarrega o tratamento |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-033 (o risco precisa existir antes do tratamento). Indiretas: US-097 (autorização), US-102 (unidades), US-073 (auditoria), US-082 (outbox).
- **Decisões/ADRs:** DEC-010, DEC-018, DEC-021, DEC-024.
- **Configurações:** nenhuma específica desta story (reutiliza `risk.scale`/`risk.levelThresholds` indiretamente via US-033).
- **Lacunas nas fontes canônicas:** ~~política de edição de `RiskTreatment`~~ — resolvida: POL-02 cobre as coleções dos documentos tipados (permissions.md); RN-RISK-16 herda RN-RISK-09.

## Impacto técnico
- Transição automática de `Risk.status` (RN-RISK-14) precisa ocorrer na mesma transação da criação do tratamento, para não deixar o risco `OPEN` com tratamento ativo em caso de falha parcial.
- `RiskTreatmentChanged` não projeta timeline/notificação (conforme events.md) — qualquer necessidade futura de alerta de prazo vencido é um incremento posterior, não desta story.

## Backend
- **Módulo(s):** `risk` (dono, mesmo módulo de US-033); usa `access` (`AuthorizationService.assertCan('RISK_MANAGE', { departmentId })`), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateRiskTreatmentCommand` → `CreateRiskTreatmentHandler` (aplica RN-RISK-14 sobre o agregado `Risk`); `UpdateRiskTreatmentCommand`; `DeleteRiskTreatmentHandler`.
- **Domínio:** `RiskTreatment.create(props)`, `RiskTreatment.changeStatus(next)` (RN-RISK-12/15); `Risk.startTreatment()` (RN-RISK-14).
- **Transação:** criação/edição/exclusão do tratamento e a eventual transição do risco em uma única transação com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-011 (`/processos/[id]/riscos`), painel expandido do risco.
- **Componentes:** `TreatmentList` (por risco), `TreatmentFormDrawer`, `TreatmentStatusSelect`, `OverdueBadge` (FA-03), `UserSelect`/`DepartmentTreeSelect`.
- **Estados:** vazio por risco ("Nenhuma ação de tratamento. Adicione a primeira ação."); skeleton; erro com "Tentar novamente"; bloqueado (FA-05).
- **Acessibilidade e responsividade:** lista de tratamentos navegável por teclado; `OverdueBadge` com texto além de cor; colapsa em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `risk_treatments` (escrita), `risks` (leitura/atualização de `status`).
- **Migrações:** criação de `risk_treatments` conforme entities.md (padrão + SD); índices `(tenant_id, risk_id)` e `(tenant_id, responsible_id, status)`.
- **Índices/constraints relevantes:** `CHECK` de `completedAt` preenchido quando `status = 'DONE'` (RN-RISK-12), aplicado na camada de domínio (trigger opcional de reforço).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| RSK-06 | POST | `/api/v1/risks/{id}/treatments` | `{ type, description, responsibleId?, responsibleDepartmentId?, dueDate?, notes? }` + `Idempotency-Key` | `201 { data: RiskTreatment }` | 201, 403, 422, 503 |
| RSK-07 | PATCH | `/api/v1/risk-treatments/{treatmentId}` | campos parciais (inclui `status`) + `If-Match` | `200 { data: RiskTreatment }` | 200, 403, 409, 412, 422 |
| RSK-08 | DELETE | `/api/v1/risk-treatments/{treatmentId}` | `If-Match` | `204` | 204, 403, 409, 412 |
| RSK-03 | GET | `/api/v1/risks/{id}` | — | `200 { data: Risk }` (inclui tratamentos) | 200, 403, 404 |
| USR-01/02, DEP-01 | GET | (leituras de apoio) | — | — | 200 |

## Logs
- `info` `risk.treatment_created` — `riskId`, `treatmentId`, `type`, `correlationId`.
- `info` `risk.treatment_status_changed` — `treatmentId`, `fromStatus`, `toStatus`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `risk.treatment_update_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** descrição e observações do tratamento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `risk.treatment_create` | `DATA_CHANGE` | Commit da criação | `metadata`: `riskId`, `type` |
| `risk.treatment_update` | `DATA_CHANGE` | Edição de campos (inclui mudança de status) | `changes`: campos alterados, `fromStatus`/`toStatus` quando aplicável |
| `risk.treatment_delete` | `DATA_CHANGE` | Commit da exclusão | `metadata`: `riskId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/escopo | `reasonCode = RISK_MANAGE` |

## Testes necessários
- **Unitários:** `RiskTreatment.create`/`changeStatus` (RN-RISK-11..15); transição automática do risco (RN-RISK-14).
- **Integração (Testcontainers PostgreSQL + Redis):** criação do primeiro tratamento move o risco para `IN_TREATMENT`; cancelar/excluir não reverte o status do risco; RLS por tenant.
- **Concorrência:** edição concorrente do mesmo tratamento → `VERSION_CONFLICT`.
- **API/contrato:** respostas e erros conforme api.md.
- **RBAC e multi-tenant:** com/sem `RISK_MANAGE`; responsável de outro tenant → 422 `REFERENCE_NOT_FOUND`.
- **E2E (Playwright):** criar tratamento, avançar status até `DONE`, excluir tratamento.
- **Acessibilidade/performance:** axe sem violações sérias no painel expandido do risco.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `RISK_MANAGE` e RN-RISK-16 aplicados na API; UI esconde/desabilita conforme regras
- [ ] Auditoria (`risk.treatment_create`/`update`/`delete`) e evento `RiskTreatmentChanged` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de RSK-06..08 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — CRUD de sub-recurso com máquina de estados simples e uma regra de propagação de status para o risco; sem cálculos de escala nem numeração.

## Prioridade
**P0** — sem tratamento registrado, riscos de nível Alto/Extremo impedem a finalização do Mapa de Riscos (US-035); acompanha a prioridade de US-033.
