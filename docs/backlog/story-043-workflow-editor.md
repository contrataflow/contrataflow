---
id: US-043
title: "Editor de workflow (etapas e transições)"
epic: EP-007
feature: FT-030
mvp: 1
priority: P1
estimate: L
status: Especificada
depends_on: [US-040]
modules: [workflow, organization]
screens: [SCR-034]
endpoints: [WF-01, WF-02, WF-03, WF-04, WF-08, WF-09, WF-10, WF-11, WF-12, WF-13, WF-14, WF-15]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE]
events: [WorkflowCreated]
---

# US-043 — Editor de workflow (etapas e transições)

## Título
Editor de workflow (etapas e transições)

## Descrição
**Como** administrador do órgão, **quero** criar e editar workflows — suas etapas e transições — em um editor visual, **para** adaptar a fase preparatória (ou criar ritos específicos) sem depender de código, mantendo o workflow publicado intacto enquanto trabalho num rascunho.

O editor (SCR-034) combina uma tabela ordenável de etapas com um painel lateral de propriedades e a lista de transições entre etapas. Toda edição ocorre sobre uma `WorkflowVersion` em `DRAFT` (nunca sobre a publicada, que é imutável — DEC-014); criar um workflow novo gera o primeiro rascunho automaticamente, e editar um workflow que só tem versão publicada oferece "Criar rascunho" como cópia dela.

## Contexto
- DEC-014 define o modelo `Workflow` → `WorkflowVersion` → `WorkflowStage` → `WorkflowTransition`, com a versão publicada imutável; DEC-001 rege a nomenclatura de chaves/enums; DEC-104 rege a concorrência otimista via `If-Match`; DEC-084 rege o snapshot/hash calculado na publicação (consumido aqui apenas pelo fluxo "criar rascunho a partir da publicada").
- US-040 definiu o modelo de dados e as tabelas (`workflows`, `workflow_versions`, `workflow_stages`, `workflow_transitions`); esta story entrega a interface e os comandos de escrita sobre o rascunho — publicar/aposentar ficam em US-045 (fora do alcance) e as regras de etapa/transição ficam em US-044 (fora do alcance).
- Hoje, mudar o rito de um órgão (ex.: adicionar uma etapa de parecer jurídico) exigiria alterar código; o editor devolve essa configuração ao administrador do próprio tenant.

## Objetivo
Permitir que um administrador crie um workflow com etapas e transições válidas (grafo editável sem corromper o publicado) em uma sessão de trabalho, sem perder alterações por concorrência (`If-Match`) e sem nunca escrever sobre a versão publicada em uso pelos processos em andamento.

## Persona
- **Principal:** Administrador do órgão (perfil com `WORKFLOW_MANAGE`).
- **Secundárias:** Gestor de contratações consultando o desenho do fluxo (somente leitura, `WORKFLOW_VIEW`).

## Pré-condições
- Usuário com `WORKFLOW_MANAGE` (edição) ou `WORKFLOW_VIEW` (leitura).
- Para editar um workflow existente apenas com versão publicada: nenhuma `DRAFT` pode existir ainda (ou já existe e é reaberta).

## Fluxo principal
1. O administrador abre **Workflows** (SCR-034, `/admin/workflows`) e vê a lista (`WF-01`) com nome, selos "Padrão"/"Ativo"/"Inativo" e status da versão mais recente.
2. Ao clicar **"Novo workflow"**, informa nome/descrição; o front envia `POST /api/v1/workflows` (`WF-02`); a API cria o `Workflow` e sua primeira `WorkflowVersion` em `DRAFT` (`versionNumber = 1`) na mesma transação e publica o evento `WorkflowCreated`; o front navega para `/admin/workflows/[id]`.
3. O editor carrega `WF-03` (workflow) e `WF-09` (versão em edição) e exibe a **tabela de etapas** (ordem, nome, tipo, unidade, SLA) com o **painel lateral** para a etapa selecionada (nome, instruções, tipo `START`/`TASK`/`APPROVAL`/`END`, `departmentResolution` + unidade fixa quando `FIXED`, `assignmentPolicy`, campos de aprovador quando `APPROVAL`, `slaDays`/`slaType`, `documentTypeCodes`/`approvalDocumentTypeCodes`, cor).
4. O administrador clica **"Adicionar etapa"**; o front envia `POST /api/v1/workflow-versions/{versionId}/stages` (`WF-10`) com os campos do painel; a etapa entra ao final da ordem.
5. Ao editar um campo no painel e salvar, o front envia `PATCH /api/v1/workflow-stages/{stageId}` (`WF-11`) com `If-Match: "<version>"`.
6. Na aba **Transições**, o administrador cria uma transição entre duas etapas (`POST /api/v1/workflow-versions/{versionId}/transitions`, `WF-13`): origem, destino, ação (`FORWARD`/`RETURN`/`COMPLETE` — `APPROVE`/`REJECT` são automáticas de etapas `APPROVAL` e não aparecem aqui), rótulo do botão, se é ação principal, se exige comentário, se permite sobrescrever o prazo.
7. O editor valida o grafo incrementalmente na UI (aviso, não bloqueia salvar o rascunho): etapa sem transição de saída, etapa inalcançável a partir do `START`. A validação completa e bloqueante ocorre na publicação (`WF-20`, US-045, fora desta story).
8. Para reaproveitar um workflow publicado, o administrador aciona **"Criar rascunho"**; o front envia `POST /api/v1/workflows/{id}/versions` (`WF-08`); a API copia etapas, transições e regras da versão publicada para uma nova `WorkflowVersion` em `DRAFT`; se já existir um rascunho, a API responde `WORKFLOW_DRAFT_EXISTS` e o front oferece "Continuar o rascunho existente".
9. Cada campo salva ao perder o foco/confirmar (sem "salvar tudo" em lote), atualizando o `ETag` da etapa/transição/versão correspondente.

## Fluxos alternativos
- **FA-01 — Excluir etapa referenciada por transição:** `DELETE /workflow-stages/{stageId}` (`WF-12`) é bloqueado com "Remova primeiro as transições que usam esta etapa" (lista as transições afetadas) — sem exclusão em cascata no MVP 1.
- **FA-02 — Editar etapa/transição de versão não `DRAFT`:** a API rejeita com `WORKFLOW_VERSION_NOT_DRAFT` (trigger de imutabilidade, DEC-014); a UI nunca deveria permitir, mas a API é a garantia final.
- **FA-03 — Dois administradores editam o mesmo rascunho ao mesmo tempo:** o segundo salvamento com `If-Match` desatualizado recebe `VERSION_CONFLICT` (412); a UI oferece "Recarregar e tentar novamente", sem mesclar automaticamente.
- **FA-04 — Reordenar etapas por arrastar:** o front recalcula `displayOrder` das etapas afetadas e envia um `PATCH` por etapa alterada (sem endpoint de lote no MVP 1).
- **FA-05 — Transição com `fromStageId = toStageId`:** bloqueada no front e rejeitada pela API (`VALIDATION_ERROR`; check `from_stage_id <> to_stage_id`).
- **FA-06 — Etapa `APPROVAL` sem `approverType`:** o painel exige o campo antes de permitir salvar; o check de banco também bloqueia.
- **FA-07 — Workflow sem nenhuma versão em `DRAFT` nem `PUBLISHED`:** a lista mostra "Sem versão em edição"; sem ação de edição disponível.

## Regras de negócio
- **RN-WF-43** — Toda escrita em `WorkflowStage`/`WorkflowTransition` só é aceita se a `WorkflowVersion` dona estiver em `status = DRAFT` (trigger de imutabilidade, DEC-014); caso contrário, `WORKFLOW_VERSION_NOT_DRAFT` (409).
- **RN-WF-44** — Criar um `Workflow` (`WF-02`) cria, na mesma transação, sua primeira `WorkflowVersion` (`versionNumber = 1`, `status = DRAFT`) sem etapas; o evento `WorkflowCreated` é publicado no outbox.
- **RN-WF-45** — `key` de `Workflow`, `WorkflowStage` e `WorkflowTransition` são imutáveis após criados (DEC-001) e únicos no escopo correspondente (`tenant`; `tenant + workflow_version`).
- **RN-WF-46** — Um workflow tem no máximo uma `WorkflowVersion` em `DRAFT` por vez (`UNIQUE (tenant_id, workflow_id) WHERE status = 'DRAFT'`); criar outra retorna `WORKFLOW_DRAFT_EXISTS`.
- **RN-WF-47** — `WF-08` ("Criar rascunho") sem versão publicada existente é rejeitado (`BUSINESS_RULE_VIOLATION` — nada para copiar); com versão publicada, copia etapas, transições e regras para a nova versão em `DRAFT` (ids recriados).
- **RN-WF-48** — Etapa `type = APPROVAL` exige `approverType`; `departmentResolution = FIXED` exige `fixedDepartmentId`; `approverType = DEPARTMENT_HEAD` exige `approverDepartmentResolution` (checks de banco, US-040).
- **RN-WF-49** — `WorkflowTransition.fromStageId` e `toStageId` devem pertencer à mesma `WorkflowVersion` da transição e ser distintos entre si.
- **RN-WF-50** — Excluir uma `WorkflowStage` (`WF-12`) ou `WorkflowTransition` (`WF-15`) é bloqueado (`BUSINESS_RULE_VIOLATION`) enquanto houver `WorkflowTransition`/`WorkflowRule` referenciando a etapa.
- **RN-WF-51** — Todo comando de escrita sobre etapa/transição/workflow exige `If-Match` com a `version` corrente do recurso (DEC-104); divergência → `VERSION_CONFLICT` (412).
- **RN-WF-52** — `displayOrder` de etapas e transições controla apenas a exibição (sem unicidade de banco); a UI mantém a sequência contígua ao reordenar.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome do workflow | `name` | texto curto | Sim | 3–150 caracteres | — |
| Descrição do workflow | `description` | texto longo | Não | até 2.000 caracteres | — |
| Chave da etapa | `key` | texto técnico | Sim | até 60; `SCREAMING_SNAKE_CASE`; imutável (RN-WF-45) | gerada a partir do nome, editável antes de salvar |
| Nome da etapa | `name` | texto curto | Sim | 3–150 caracteres | — |
| Instruções da etapa | `instructions` | markdown | Não | até 4.000 caracteres | — |
| Tipo da etapa | `type` | seleção (`StageType`) | Sim | `START`\|`TASK`\|`APPROVAL`\|`END` | `TASK` |
| Resolução da unidade | `departmentResolution` | seleção (`DepartmentResolution`) | Sim | RN-WF-48 | `REQUESTING_DEPARTMENT` |
| Unidade fixa | `fixedDepartmentId` | seleção | Condicional (`FIXED`) | unidade ativa do órgão | — |
| Política de atribuição | `assignmentPolicy` | seleção (`StageAssignmentPolicy`) | Sim | enum | `UNASSIGNED` |
| Tipo de aprovador | `approverType` | seleção (`ApproverType`) | Condicional (`APPROVAL`) | RN-WF-48 | — |
| SLA (dias) | `slaDays` | número | Não | 1–365 | — |
| Tipo de contagem do SLA | `slaType` | seleção (`DayCountType`) | Não | enum | `BUSINESS` |
| Cor da etapa | `color` | cor (hex) | Não | formato `#RRGGBB` | — |
| Nome da transição | `name` | texto curto | Sim | 3–150 caracteres | — |
| Etapa de origem/destino | `fromStageId` / `toStageId` | seleção | Sim | RN-WF-49 | — |
| Ação da transição | `action` | seleção (`TransitionAction`) | Sim | `FORWARD`\|`RETURN`\|`COMPLETE` nesta story | — |
| Ação principal | `isPrimary` | booleano | Não | — | `false` |
| Exige comentário | `requiresComment` | booleano | Não | forçado `true` em `RETURN` | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | `key` fora do padrão ou duplicada na versão | API | "Esta chave já está em uso nesta versão." | `VALIDATION_ERROR` (padrão) / `CONFLICT` (duplicada) |
| V-03 | Etapa `APPROVAL` sem `approverType` | Front + API | "Selecione quem aprova esta etapa." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-04 | `departmentResolution = FIXED` sem unidade | Front + API | "Selecione a unidade responsável." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-05 | Transição com origem igual ao destino | Front + API | "A etapa de origem deve ser diferente da etapa de destino." | `VALIDATION_ERROR` |
| V-06 | Editar versão não `DRAFT` | API | "Esta versão não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-07 | `If-Match` ausente/divergente | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-08 | Excluir etapa/transição referenciada | API | "Remova primeiro as transições que usam esta etapa." | `BUSINESS_RULE_VIOLATION` |
| V-09 | Criar rascunho quando já existe um | API | "Já existe um rascunho deste workflow. Continue a edição dele." | `WORKFLOW_DRAFT_EXISTS` |

## Permissões
- **Permissão:** `WORKFLOW_VIEW` para listar/visualizar; `WORKFLOW_MANAGE` para criar/editar/excluir workflows, etapas e transições.
- **Políticas:** nenhuma política contextual (configuração do tenant, DEC-010); escopo é o tenant inteiro.
- **MFA:** ação de risco H (`WORKFLOW_MANAGE`) conforme POL-14 e `security.mfaPolicy` do tenant.
- **Sem permissão:** botões "Novo workflow"/"Adicionar etapa"/"Adicionar transição" ocultos; rota de edição acessível só leitura com `WORKFLOW_VIEW`; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowCreated` | `workflow.created` | Commit de `WF-02` | Payload: `workflowId`, `key` (events.md) |

Edição de etapas/transições em rascunho não gera eventos de domínio (apenas auditoria `CONFIGURATION`); a publicação (`WorkflowVersionPublished`) é de US-045.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; edição de rascunho não afeta processos em andamento (que seguem a versão publicada fixada — DEC-014). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Editor de workflow (etapas e transições)

  Background:
    Given que a usuária "Carla" possui a permissão "WORKFLOW_MANAGE" no tenant "Prefeitura de São José"

  Scenario: [Sucesso] Criar workflow com rascunho inicial
    When "Carla" criar o workflow "Obras — rito simplificado"
    Then deve ser criado o workflow com uma "WorkflowVersion" número 1 em "DRAFT"
    And deve gerar o evento "WorkflowCreated"
    And "Carla" deve ser levada ao editor do novo workflow

  Scenario: [Sucesso] Adicionar etapa e transição ao rascunho
    Given que o workflow "Obras — rito simplificado" tem uma versão em "DRAFT"
    When "Carla" adicionar a etapa "Abertura" do tipo "START"
    And adicionar a etapa "Parecer jurídico" do tipo "TASK"
    And criar a transição "Encaminhar para o jurídico" de "Abertura" para "Parecer jurídico" com ação "FORWARD"
    Then as duas etapas e a transição devem existir na versão em rascunho
    And deve gerar registro de auditoria "workflow.update" para cada operação

  Scenario: [Validação] Etapa de aprovação sem aprovador definido
    When "Carla" tentar salvar uma etapa do tipo "APPROVAL" sem informar o aprovador
    Then o sistema deve exibir "Selecione quem aprova esta etapa."
    And a API deve responder 422 com código "VALIDATION_ERROR" no campo "approverType"

  Scenario: [Permissão] Usuário com apenas WORKFLOW_VIEW
    Given que "Daniel" possui apenas "WORKFLOW_VIEW"
    When "Daniel" abrir o editor do workflow "Obras — rito simplificado"
    Then os botões "Adicionar etapa" e "Adicionar transição" não devem ser exibidos
    When "Daniel" enviar "POST /api/v1/workflow-versions/{versionId}/stages" diretamente
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Acessar workflow de outro tenant
    Given que o workflow "Fluxo interno" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", acessar "GET /api/v1/workflows/{id}" desse workflow
    Then a API deve responder 404 com código "NOT_FOUND"
    And a resposta não deve revelar que o workflow existe em outro tenant

  Scenario: [Duplicidade] Criar rascunho quando já existe um
    Given que o workflow "Fase preparatória — Lei 14.133/2021" já tem uma versão em "DRAFT"
    When "Carla" acionar "Criar rascunho" novamente a partir da versão publicada
    Then a API deve responder 409 com código "WORKFLOW_DRAFT_EXISTS"
    And deve oferecer continuar a edição do rascunho existente

  Scenario: [Concorrência] Duas edições simultâneas da mesma etapa
    Given que a etapa "Parecer jurídico" está na versão "3"
    When "Carla" e "Daniel" enviarem "PATCH" para a mesma etapa com "If-Match: \"3\"" ao mesmo tempo
    Then exatamente uma requisição deve ser aceita com 200 e nova versão "4"
    And a outra deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar uma etapa
    Given que o banco de dados fica indisponível
    When "Carla" tentar adicionar uma etapa
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma etapa parcial deve ser persistida

  Scenario: [Falha de integração] Outbox indisponível ao criar o workflow
    Given que o relay do outbox está indisponível
    When "Carla" criar um novo workflow
    Then o workflow deve ser criado e a API deve responder 201
    And o evento "WorkflowCreated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campos obrigatórios ausentes | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos |
| Chave duplicada na versão | 409 | `CONFLICT` (`conflictField = key` — api/10-workflow.md, decisão da US-040) | "Esta chave já está em uso nesta versão." | Foca campo `key` |
| Versão não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão não pode mais ser editada." | Oferece "Criar rascunho" |
| Rascunho já existe | 409 | `WORKFLOW_DRAFT_EXISTS` | "Já existe um rascunho deste workflow." | Link para o rascunho |
| Exclusão bloqueada por referência | 422 | `BUSINESS_RULE_VIOLATION` (uma `violation` por transição/regra — api.md §2.2) | "Remova primeiro as transições que usam esta etapa." | Lista as transições |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega recurso |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Os dados foram alterados por outra pessoa. Recarregue." | Recarrega recurso |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar workflows." | Ações ocultas |
| Outro tenant/inexistente | 404 | `NOT_FOUND` | — | Tela "Não encontrado" |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; "Tentar novamente" |

## Dependências
- **Stories:** US-040 (modelo de definição de workflow versionado — tabelas, enums e checks que este editor escreve).
- **Decisões/ADRs:** DEC-001, DEC-014, DEC-084, DEC-104; ADR-005.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma (`WF-08` atribuído a US-043 e US-045 em api.md §3).

## Impacto técnico
- Reaproveita o padrão de concorrência otimista (`version`/`ETag`/`If-Match`, DEC-104); cada etapa/transição é uma linha versionada independente — sem "salvar tudo" em lote no MVP 1.
- `WF-08` ("Criar rascunho" a partir da publicada) reaproveita a lógica de cópia que também serve à publicação de nova versão (US-045); recomenda-se extrair uma função `cloneWorkflowVersionContent` compartilhada entre as duas stories.
- Exclusão de etapa/transição é sempre restritiva (RN-WF-50), evitando o custo de exclusão em cascata e o risco de apagar regras (US-044) sem intenção explícita.

## Backend
- **Módulo(s):** `workflow`.
- **Casos de uso:** `CreateWorkflowCommand`, `CreateDraftFromPublishedCommand` (`WF-08`), `CreateStageCommand`/`UpdateStageCommand`/`DeleteStageCommand`, `CreateTransitionCommand`/`UpdateTransitionCommand`/`DeleteTransitionCommand`.
- **Domínio:** `Workflow.create(...)`; `WorkflowVersion.cloneFrom(publishedVersion)`; `WorkflowStage`/`WorkflowTransition` com invariantes de RN-WF-48/49 aplicadas na fábrica.
- **Integrações internas:** `organization` (validar `fixedDepartmentId` ativo); referências de aprovador (`approverUserId`/`approverRoleId`) apenas validadas como existentes/ativas — o detalhe de regras é de US-044.
- **Transação:** cada comando de escrita é uma transação curta única (criar/atualizar/excluir um recurso por vez), com checagem de `WorkflowVersion.status = DRAFT` e `If-Match` na mesma transação.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows` e `/admin/workflows/[id]`).
- **Componentes:** `WorkflowList`, `StageTable` (ordenável), `StagePropertiesPanel`, `TransitionList`, `TransitionForm`, `CreateDraftButton`.
- **Estados:** skeleton ao carregar etapas/transições; vazio ("Nenhuma etapa ainda — adicione a primeira") com CTA; erro com "Tentar novamente"; confirmação visual de salvamento por campo.
- **Acessibilidade e responsividade:** tabela de etapas navegável por teclado (setas como alternativa ao arrastar); painel lateral torna-se modal em telas < 768 px; seletor de cor com nome, não só amostra (contraste AA).

## Banco de dados
- **Tabelas:** `workflows`, `workflow_versions`, `workflow_stages`, `workflow_transitions` (escrita); `workflow_rules` apenas lida/copiada (escrita é de US-044).
- **Migrações:** nenhuma (reaproveita US-040).
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, workflow_version_id, key)` de etapas/transições e o trigger de imutabilidade de versões não `DRAFT` (US-040).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-01 | GET | `/api/v1/workflows` | `?status=&q=` | `200 { data: [Workflow], meta }` | 200 |
| WF-02 | POST | `/api/v1/workflows` | `{ name, description? }` | `201 { data: Workflow }` com rascunho v1 | 201, 403, 422 |
| WF-03 | GET | `/api/v1/workflows/{id}` | — | `200 { data: Workflow }` | 200, 404 |
| WF-04 | PATCH | `/api/v1/workflows/{id}` | `{ name?, description? }` + `If-Match` | `200 { data: Workflow }` | 200, 403, 404, 412, 422, 428 |
| WF-08 | POST | `/api/v1/workflows/{id}/versions` | — | `201 { data: WorkflowVersion }` (cópia da publicada) | 201, 403, 409 (`WORKFLOW_DRAFT_EXISTS`) |
| WF-09 | GET | `/api/v1/workflow-versions/{versionId}` | — | `200 { data: WorkflowVersion }` com etapas e transições | 200, 404 |
| WF-10 | POST | `/api/v1/workflow-versions/{versionId}/stages` | `{ key, name, type, departmentResolution, … }` | `201 { data: WorkflowStage }` | 201, 403, 409 (`WORKFLOW_VERSION_NOT_DRAFT`), 422 |
| WF-11 | PATCH | `/api/v1/workflow-stages/{stageId}` | campos do painel + `If-Match` | `200 { data: WorkflowStage }` | 200, 403, 409, 412, 422, 428 |
| WF-12 | DELETE | `/api/v1/workflow-stages/{stageId}` | `If-Match` | `204` | 204, 403, 409 (`BUSINESS_RULE_VIOLATION`), 412 |
| WF-13 | POST | `/api/v1/workflow-versions/{versionId}/transitions` | `{ key, name, fromStageId, toStageId, action, … }` | `201 { data: WorkflowTransition }` | 201, 403, 409, 422 |
| WF-14 | PATCH | `/api/v1/workflow-transitions/{transitionId}` | campos + `If-Match` | `200 { data: WorkflowTransition }` | 200, 403, 409, 412, 422, 428 |
| WF-15 | DELETE | `/api/v1/workflow-transitions/{transitionId}` | `If-Match` | `204` | 204, 403, 409, 412 |

## Logs
- `info` `workflow.created` — `workflowId`, `key`, `userId`.
- `info` `workflow.stage_saved` / `workflow.transition_saved` — `workflowVersionId`, `stageId`/`transitionId`, operação (create/update/delete).
- `warn` `workflow.draft_conflict` — tentativa de criar segundo rascunho (`WORKFLOW_DRAFT_EXISTS`).
- `error` `workflow.write_failed` — causa, `correlationId`.
- **Nunca logar:** não se aplica (configuração estrutural, sem dados pessoais).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.create` | `CONFIGURATION` | Commit de `WF-02` | `changes`: `name`, `description` |
| `workflow.update` | `CONFIGURATION` | Commit de `WF-04`/`WF-11`/`WF-14` | `changes`: campos alterados; `metadata`: `stageId`/`transitionId` quando aplicável |
| `workflow.version_create` | `CONFIGURATION` | Commit de `WF-08` | `metadata`: `sourceVersionId`, `newVersionId` |
| `access.denied` | `ACCESS` | Tentativa sem `WORKFLOW_MANAGE` | `reasonCode = WORKFLOW_MANAGE` |

## Testes necessários
- **Unitários:** fábricas de `WorkflowStage`/`WorkflowTransition` (RN-WF-48/49); clonagem de versão (RN-WF-47).
- **Integração (Testcontainers PostgreSQL):** trigger de imutabilidade bloqueia escrita em versão não `DRAFT`; `UNIQUE … WHERE status = 'DRAFT'` impede dois rascunhos; RLS isola por tenant.
- **API/contrato:** WF-01 a WF-04 e WF-08 a WF-15 conforme api.md.
- **RBAC e multi-tenant:** `WORKFLOW_MANAGE` vs. `WORKFLOW_VIEW`; workflow de outro tenant → 404.
- **Concorrência:** dois `PATCH` simultâneos na mesma etapa com o mesmo `If-Match` → um 200, outro 412.
- **E2E (Playwright):** criar workflow, adicionar etapas e transições, recarregar e confirmar persistência; fluxo "Criar rascunho" a partir da publicada.
- **Acessibilidade/performance:** axe no editor; reordenação por teclado testada.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `WORKFLOW_MANAGE`/`WORKFLOW_VIEW` aplicados; ações ocultas sem permissão
- [ ] Trigger de imutabilidade de versão publicada coberto por teste de integração
- [ ] Auditoria e evento `WorkflowCreated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de WF-01 a WF-04 e WF-08 a WF-15 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Editor acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — CRUD completo de etapas e transições com concorrência otimista por recurso, clonagem de versão publicada e várias regras de integridade de grafo, sobre uma tela composta (tabela + painel + lista de transições).

## Prioridade
**P1** — depende apenas do modelo (US-040) e não bloqueia o MVP mínimo (que já funciona com os workflows semeados, US-042), mas é necessária para qualquer customização pelo tenant.
