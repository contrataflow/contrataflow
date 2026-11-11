---
id: US-150
title: "Distribuir análises na assessoria jurídica"
epic: EP-025
feature: FT-073
mvp: 2
priority: P0
estimate: S
status: Especificada
depends_on: [US-050, US-149]
modules: [legal-review, process, organization, access, timeline, notification, audit]
screens: [SCR-019, SCR-115]
endpoints: [LGL-03, LGL-04, LGL-09, LGL-02, PRC-22]
permissions: [PROCESS_ASSIGN, LEGAL_REVIEW_VIEW, LEGAL_REVIEW_MANAGE]
events: [LegalReviewAssigned, ProcessAssigned]
---

# US-150 — Distribuir análises na assessoria jurídica

## Título
Distribuir análises na assessoria jurídica

## Descrição
**Como** chefe da assessoria jurídica (titular ou substituto da unidade jurídica, ou gestor com `PROCESS_ASSIGN`), **quero** designar e redistribuir as análises da fila aos procuradores, uma a uma ou em lote, **para** repartir a carga sem planilha paralela, deixar claro quem responde por cada análise e garantir que quem elaborou o processo nunca seja escolhido para analisá-lo (POL-19).

Distribuir grava o procurador na `LegalReview` (`assigneeId`, `assignedAt`, `assignedById`) **e**, na mesma transação, o torna responsável pelo processo na etapa `JURIDICO` (`ProcessAssignment` `MANUAL` e `ProcessAccess` `USER/RESPONSIBLE`), reaproveitando o comando da US-050. A designação **não** muda a posição na fila, o score nem o prazo. Iniciar a análise é da US-152; a regra de quem pode iniciar ou concluir (designado ou titular/substituto) já está nas US-152 e US-155.

## Contexto
- A DEC-199 e a RN-LGL-06 dão a distribuição ao chefe da assessoria (`PROCESS_ASSIGN` no escopo da unidade jurídica); o procurador designado recebe acesso de responsável ao processo (`permissions.md §5.3`).
- A US-050 (MVP 1) já atribui responsável individual dentro da unidade atual (POL-05: `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` que cubra o processo, **ou** titular/substituto da unidade atual; motivo obrigatório ao trocar quem já responde). A US-058 define o padrão de ação em lote (2 a `inbox.bulkMaxItems` itens, uma transação por item, resultado por item, `Idempotency-Key` cobrindo o lote). Esta story aplica ambos à fila jurídica.
- POL-19 (segregação jurídico x requisitante) vale para **quem analisa**: criador do processo, autor de DFD, ETP, TR, `EDITAL` ou `MINUTA_CONTRATO` e lotado na secretaria ou no setor solicitante não podem ser designados (RN-LGL-07). Quem **distribui** não precisa ser procurador e não é submetido a POL-19, porque distribuir não é analisar.
- O evento `LegalReviewAssigned` (`events.md §4.5`) alimenta a timeline e a notificação `LEGAL_REVIEW_ASSIGNED`; o `ProcessAssigned` do MVP 1 continua sendo publicado pela atribuição do processo (RN-LGL-73 trata a duplicidade de timeline e de aviso).
- A carga atual de cada procurador vem de LGL-09 (`byAssignee`, US-149), limitada ao que o chefe pode ver.

## Objetivo
Permitir que o chefe da assessoria distribua uma análise em até 30 segundos (e um lote de até 50 em até 2 minutos), com 100% das designações respeitando POL-19, a elegibilidade do procurador e a custódia do processo, e com a posição na fila preservada.

## Persona
- **Principal:** chefe da assessoria jurídica — titular ou substituto da unidade jurídica da etapa (perfil `JURIDICO`) — ou Gestor de contratações com `PROCESS_ASSIGN` cobrindo o processo.
- **Secundárias:** procurador designado (recebe o aviso e passa a ser responsável); procurador anterior, em redistribuição (perde o acesso de responsável); Auditor (`AUDITOR`: confere a trilha de designações).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; MFA conforme `security.mfaPolicy` (`PROCESS_ASSIGN` é risco `M`: só com política `ALL`).
- Usuário com `LEGAL_REVIEW_VIEW` cobrindo o processo **e** (`PROCESS_ASSIGN` com escopo que cubra o processo **ou** titular/substituto da unidade jurídica da etapa — POL-05).
- `LegalReview` do tenant em `PENDING` ou `IN_REVIEW`, com `currentProcessStageId` não nulo; processo `IN_PROGRESS` ou `RETURNED` na etapa `JURIDICO` (do tipo `TASK`).
- Procurador a designar com vínculo `ACTIVE`, lotado na unidade jurídica da etapa, com `PROCESS_VIEW` e `LEGAL_REVIEW_MANAGE` cobrindo o processo e sem conflito de POL-19.

## Fluxo principal
1. A chefe da assessoria abre a fila (SCR-019, US-149), vê "Sem responsável" na análise "LR-0045" e aciona **"Distribuir"** na linha (ou no painel).
2. O diálogo (SCR-115 adaptado) lista os membros ativos da unidade jurídica com a carga atual de cada um (`pending` e `inReview`, de LGL-09) e marca "Indisponível" para quem violaria a segregação, quando a informação já é conhecida; pede o **motivo** apenas se a análise já tem responsável.
3. Ela escolhe "Dr. André Nunes" e confirma; o front envia `POST /legal-reviews/{id}/assign` (LGL-03) com `{ assigneeId, reason? }`, `If-Match` (ETag da `LegalReview`, lida em LGL-01/LGL-02) e `Idempotency-Key`.
4. A API valida, na ordem: existência e tenant, permissão e titularidade (POL-05), estado da análise, status do processo e da etapa, elegibilidade do procurador (RN-LGL-72), segregação do procurador (POL-19), motivo (RN-LGL-71).
5. Na **mesma transação**, trava a `LegalReview` e o processo (`SELECT … FOR UPDATE`), grava `assigneeId`, `assignedAt`, `assignedById`, incrementa o `version`, executa o comando de atribuição da US-050 (encerra a `ProcessAssignment` ativa e cria a `MANUAL`, atualiza `ProcessStage.assigneeId` e `Process.currentResponsibleId`, cria o `ProcessMovement` `ASSIGN`, concede `ProcessAccess` `USER/RESPONSIBLE` ao novo responsável e retira o do anterior), grava a auditoria `legal_review.assign`, a timeline `LEGAL_REVIEW_ASSIGNED` e os eventos no outbox.
6. A API responde 200 com a `LegalReview` e a nova `ETag`; o front atualiza a linha ("Dr. André Nunes") e os contadores.
7. Depois do commit, o outbox entrega a notificação `LEGAL_REVIEW_ASSIGNED` ao procurador; o fim do fluxo é ele ver a análise em "Minhas" na fila.
8. Para o **lote**, a chefe seleciona de 2 a 50 análises na fila, aciona "Distribuir selecionadas", escolhe **um** procurador e (se necessário) o motivo; o front envia `POST /legal-reviews/bulk-assign` (LGL-04) com `{ assigneeId, reason?, items: [{ legalReviewId, version }] }` e `Idempotency-Key`; a API processa cada item em transação própria e devolve o resultado por item, e o front mostra "42 de 45 análises distribuídas. 3 não puderam ser distribuídas." com a lista dos motivos.

## Fluxos alternativos
- **FA-01 — Primeira designação (sem responsável anterior):** o motivo é opcional.
- **FA-02 — Redistribuição:** com responsável anterior diferente, o motivo (10 a 2.000 caracteres) é obrigatório; o anterior perde o acesso de responsável ao processo, mas mantém o rascunho do parecer que redigiu como histórico de autoria (a edição passa a quem tiver `LEGAL_REVIEW_MANAGE`, US-154) (RN-LGL-71, RN-LGL-73).
- **FA-03 — Remover a designação:** `assigneeId = null` devolve a análise à fila da unidade, só com a análise em `PENDING`, com motivo obrigatório se havia responsável; em `IN_REVIEW` a API responde 409 `LEGAL_REVIEW_INVALID_STATE` e a UI oferece apenas "Redistribuir" (RN-LGL-71).
- **FA-04 — Mesmo procurador já designado:** a chamada responde 200 sem alterar nada, sem evento, sem auditoria e sem aviso (RN-LGL-71).
- **FA-05 — Autodesignação:** o titular que também é procurador pode designar a si mesmo, desde que atenda à elegibilidade e a POL-19; o aviso `LEGAL_REVIEW_ASSIGNED` não é enviado a quem é o próprio ator.
- **FA-06 — Candidato violaria POL-19:** 422 `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` ("Esta pessoa participou da elaboração do processo e não pode analisá-lo."); nada é gravado (RN-LGL-72).
- **FA-07 — Candidato inelegível:** sem vínculo ativo, sem lotação na unidade jurídica, sem `PROCESS_VIEW` ou sem `LEGAL_REVIEW_MANAGE` cobrindo o processo: 422 `ASSIGNEE_NOT_ELIGIBLE` (RN-LGL-72).
- **FA-08 — Análise já iniciada por titular ou outra pessoa:** `IN_REVIEW` aceita redistribuição (com motivo); o `startedAt` e o snapshot não mudam; quem iniciou continua constando na auditoria do início (RN-LGL-71).
- **FA-09 — Lote com falhas parciais:** itens com erro (segregação, estado, versão desatualizada, sem permissão) aparecem com o código; os demais são distribuídos; o lote nunca é desfeito por inteiro (RN-LGL-74).
- **FA-10 — Todos os itens do lote falham:** a API ainda responde 200 com o resultado por item; a UI mostra "Nenhuma análise pôde ser distribuída." e mantém a seleção (RN-LGL-74).
- **FA-11 — Lote fora do limite:** menos de 2 ou mais de `inbox.bulkMaxItems` itens (padrão 50): 422 `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) em `items` (RN-LGL-74).
- **FA-12 — Análise saiu da etapa entre a leitura e o envio:** análise em `DILIGENCE` ou processo fora de `JURIDICO`: 409 `LEGAL_REVIEW_INVALID_STATE` ou `INVALID_PROCESS_STATUS`; no lote, falha só aquele item.

## Regras de negócio
- **RN-LGL-06** — A distribuição é do chefe da assessoria (`PROCESS_ASSIGN` no escopo da unidade jurídica); o procurador designado recebe acesso de responsável ao processo (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-07** — Segregação: quem elaborou o processo ou seus documentos não pode ser designado para analisá-lo (POL-19). *(regra da feature, adotada)*
- **RN-LGL-70** — Quem distribui: usuário com `LEGAL_REVIEW_VIEW` cobrindo o processo **e** `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` que cubra o processo, **ou** titular/substituto da unidade jurídica da etapa (POL-05, `Department.headUserId`/`deputyUserId` da `ProcessStage.departmentId`). Quem distribui não precisa de `LEGAL_REVIEW_MANAGE` nem é avaliado por POL-19 (distribuir não é analisar). Sem nenhuma das condições, 403 `PERMISSION_DENIED`.
- **RN-LGL-71** — Estado e forma: a distribuição vale com a análise em `PENDING` ou `IN_REVIEW`, processo `IN_PROGRESS` ou `RETURNED` e etapa `TASK`; fora disso, `LEGAL_REVIEW_INVALID_STATE` (análise) ou `INVALID_PROCESS_STATUS` (processo). `assigneeId` é obrigatório no corpo (pode ser `null` só em `PENDING`); `reason` (10 a 2.000 caracteres) é obrigatório quando há responsável anterior diferente do novo, inclusive ao remover; mesmo `assigneeId` do atual é no-op (200 sem efeitos). A distribuição **não altera** `enteredQueueAt`, `queuePriorityScore`, `priorityFactors`, `startedAt` nem o prazo da etapa.
- **RN-LGL-72** — Elegibilidade do procurador: vínculo `ACTIVE` no tenant, lotação (não necessariamente principal) na unidade jurídica da etapa, `PROCESS_VIEW` e `LEGAL_REVIEW_MANAGE` cobrindo o processo; senão `ASSIGNEE_NOT_ELIGIBLE` (422). Em seguida, POL-19: não pode ser criador do processo, autor (`createdById` ou autor de versão) de DFD, ETP, TR, `EDITAL` ou `MINUTA_CONTRATO` do processo, nem lotado na secretaria ou no setor solicitante; senão `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` (422). Usuário de outro tenant ou inexistente: 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`), sem revelar existência.
- **RN-LGL-73** — Efeito composto e atômico: `LegalReview` (`assigneeId`, `assignedAt`, `assignedById`, `version`), `ProcessAssignment` `MANUAL`, `ProcessStage.assigneeId`, `Process.currentResponsibleId`, `ProcessMovement` `ASSIGN`, `ProcessAccess` (concede ao novo, retira do anterior), auditoria, timeline e outbox na mesma transação, com `If-Match` obrigatório e `Idempotency-Key` obrigatória (24 h). Para não duplicar registros, `ProcessAssigned` leva o campo aditivo `legalReviewId` e o `TimelineProjector` e o notificador de `PROCESS_ASSIGNED` ignoram esse evento quando o campo está presente (valem `LEGAL_REVIEW_ASSIGNED` na timeline e no aviso); o `ProcessMovement` `ASSIGN` continua gravado (histórico de tramitação, US-054).
- **RN-LGL-74** — Lote (LGL-04): de 2 a `inbox.bulkMaxItems` itens (padrão 50) distintos, **mesmo** `assigneeId`, `version` esperado por item; cada item roda em transação própria com as regras de LGL-03 e produz `ok` ou `code`/`message`; um item com falha não interrompe os demais; a `Idempotency-Key` cobre o lote (mesma chave e mesmo corpo devolvem o mesmo resultado, `Idempotent-Replayed: true`); cada item bem-sucedido publica seu `LegalReviewAssigned` e gera seu aviso; `reason` do lote vale para todos os itens e é exigido por item quando há responsável anterior diferente.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Análise | `id` (path) | uuid | Sim (LGL-03) | `LegalReview` do tenant | rota |
| Procurador | `assigneeId` | uuid ou `null` | Sim (pode ser `null` em `PENDING`) | RN-LGL-71/72 | seleção de membros da unidade |
| Motivo | `reason` | texto | Condicional | 10..2.000; obrigatório em redistribuição e remoção (RN-LGL-71) | em branco |
| Itens do lote | `items[]` (`legalReviewId`, `version`) | lista | Sim (LGL-04) | 2..`inbox.bulkMaxItems`, ids distintos | seleção na fila |
| Versão da análise | `If-Match` (ETag) | texto | Sim (LGL-03) | ETag da `LegalReview` | LGL-01/LGL-02 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| *(saída)* Designação | `assigneeId`, `assignedAt`, `assignedById` | uuid / datetime / uuid | — | gravados pelo servidor | servidor |
| *(saída)* Resultado por item | `legalReviewId`, `ok`, `code?`, `message?`, `review?` | lista | — | RN-LGL-74 | servidor |
| *(saída)* Totais | `successCount`, `errorCount` | int | — | — | servidor |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `assigneeId` ausente do corpo | Front + API (Zod) | "Selecione um procurador ou deixe a análise na fila." | `VALIDATION_ERROR` |
| V-02 | `reason` ausente em redistribuição ou remoção | Front + API | "Informe o motivo da troca de responsável." | `VALIDATION_ERROR` |
| V-03 | `reason` com menos de 10 ou mais de 2.000 caracteres | Front + API | "O motivo deve ter de 10 a 2.000 caracteres." | `VALIDATION_ERROR` |
| V-04 | `assigneeId` nulo com a análise `IN_REVIEW` | API | "Uma análise em andamento só pode ser redistribuída a outro procurador." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-05 | Lote com menos de 2 ou mais de `inbox.bulkMaxItems` itens, ou ids repetidos | Front + API | "Selecione de 2 a {limite} análises por vez." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-06 | `If-Match` ausente / divergente | API | "Atualize a página e tente de novo." / "Esta análise foi alterada por outra pessoa. Atualize a página." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |
| V-07 | Análise fora de `PENDING`/`IN_REVIEW` | API | "Esta análise não pode ser distribuída no estado atual." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-08 | Processo fora de `IN_PROGRESS`/`RETURNED` ou etapa que não é `JURIDICO` ativa | API | "O processo não está disponível para distribuição no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-09 | Procurador sem vínculo, lotação, `PROCESS_VIEW` ou `LEGAL_REVIEW_MANAGE` | API | "Esta pessoa não pode ser responsável por esta análise." | `ASSIGNEE_NOT_ELIGIBLE` (422) |
| V-10 | Procurador em conflito de segregação (POL-19) | API | "Esta pessoa participou da elaboração do processo e não pode analisá-lo." | `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` (422) |
| V-11 | `assigneeId` inexistente ou de outro tenant | API | "Selecione um procurador válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-12 | Usuário sem permissão para distribuir | API | "Você não pode distribuir análises jurídicas." | `PERMISSION_DENIED` (403) |
| V-13 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_VIEW` cobrindo o processo **e** `PROCESS_ASSIGN` com escopo que cubra o processo, **ou** titular/substituto da unidade jurídica da etapa (POL-05). O procurador designado precisa de `LEGAL_REVIEW_MANAGE` para analisar (RN-LGL-72).
- **Políticas:** POL-05 (atribuir), POL-19 (segregação do designado), DEC-024 (visibilidade), DEC-023 (custódia).
- **MFA:** `PROCESS_ASSIGN` tem risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Distribuir" fica oculto; a API responde 403 `PERMISSION_DENIED` com auditoria `access.denied`; análise de outro tenant ou de processo invisível responde 404 `LEGAL_REVIEW_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewAssigned` | `legal_review.assigned` | Commit de LGL-03 (e de cada item de LGL-04) | Payload `legalReviewId`, `fromUserId?`, `toUserId`; consumidores T (timeline `LEGAL_REVIEW_ASSIGNED`) e N (aviso ao procurador); em remoção de designação não há `toUserId` e o evento não é publicado (só auditoria e `ProcessAssigned`) |
| `ProcessAssigned` | `process.assigned` | Mesmo commit (comando da US-050) | `assignmentType = MANUAL`, `hasReason`; ganha `legalReviewId?` (aditivo) para que timeline e aviso de processo não dupliquem (RN-LGL-73) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `LEGAL_REVIEW_ASSIGNED` | Procurador designado (exceto quando ele é o ator) | IN_APP + EMAIL (padrão ligado); não obrigatória | Evento `LegalReviewAssigned` (após o commit, via outbox) |

O texto leva código e objeto do processo e o link da análise; nunca valor, faixa ou fatores. Não há tipo de notificação para o procurador **anterior** (lacuna abaixo). `PROCESS_ASSIGNED` não é enviado para essa designação (RN-LGL-73).

## Critérios de aceite em Gherkin
```gherkin
Feature: Distribuir análises na assessoria jurídica

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "JURIDICO" da unidade "Assessoria Jurídica"
    And a análise "LR-0045" está "PENDING", sem responsável, na posição 1 da fila
    And "Dra. Helena Prado" é titular da "Assessoria Jurídica" e tem "LEGAL_REVIEW_VIEW"
    And "Dr. André Nunes" e "Dra. Lúcia Prado" estão lotados na unidade e têm "PROCESS_VIEW" e "LEGAL_REVIEW_MANAGE"
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e também tem o perfil "JURIDICO"

  Scenario: [Sucesso] Primeira designação mantém a posição na fila
    When "Dra. Helena Prado" distribuir "LR-0045" a "Dr. André Nunes" com a chave "K1"
    Then a API deve responder 200 com "assigneeId" de "Dr. André Nunes", "assignedById" de "Dra. Helena Prado" e nova "ETag"
    And o processo deve ter "Dr. André Nunes" como responsável atual e ele deve receber acesso "RESPONSIBLE"
    And "enteredQueueAt" e "queuePriorityScore" devem continuar iguais e "LR-0045" deve seguir na posição 1
    And deve gerar auditoria "legal_review.assign", os eventos "LegalReviewAssigned" e "ProcessAssigned" e uma única linha de timeline "distribuiu a análise jurídica a Dr. André Nunes"
    And "Dr. André Nunes" deve receber "LEGAL_REVIEW_ASSIGNED" e não "PROCESS_ASSIGNED"

  Scenario: [Sucesso] Redistribuição com motivo retira o acesso do anterior
    Given que "LR-0045" está designada a "Dr. André Nunes"
    When "Dra. Helena Prado" redistribuir "LR-0045" a "Dra. Lúcia Prado" com o motivo "Dr. André está de férias"
    Then a API deve responder 200 e "Dra. Lúcia Prado" deve ser a responsável
    And "Dr. André Nunes" deve perder o acesso "RESPONSIBLE" e o evento "LegalReviewAssigned" deve ter "fromUserId" de "Dr. André Nunes"

  Scenario: [Sucesso] Distribuição em lote com resultado por item
    Given que existem 4 análises "PENDING", entre elas "LR-0045", e a "LR-0050" é do processo "0050/2026" criado por "Dr. André Nunes"
    When "Dra. Helena Prado" distribuir as 4 análises a "Dr. André Nunes" em lote com a chave "K2"
    Then a API deve responder 200 com "successCount" 3 e "errorCount" 1
    And o item "LR-0050" deve vir com "ok" falso e código "LEGAL_REVIEW_ASSIGNEE_SEGREGATED"
    And devem existir 3 eventos "LegalReviewAssigned" e 3 avisos "LEGAL_REVIEW_ASSIGNED"

  Scenario: [Validação] Motivo, lote e remoção em análise iniciada
    Given que "LR-0045" está designada a "Dr. André Nunes"
    When "Dra. Helena Prado" redistribuir "LR-0045" a "Dra. Lúcia Prado" sem motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "reason"
    When "Dra. Helena Prado" enviar um lote com 1 item
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" em "items"
    Given que "LR-0045" está "IN_REVIEW"
    When "Dra. Helena Prado" enviar "assigneeId" nulo com o motivo "Reorganização"
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"

  Scenario: [Permissão] Sem permissão, sem titularidade e candidato inelegível
    Given que "Bruno Lopes" não tem "PROCESS_ASSIGN" nem é titular da unidade
    When "Bruno Lopes" chamar "POST /legal-reviews/{id}/assign"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    When "Dra. Helena Prado" distribuir "LR-0045" a "Carla Mendes"
    Then a API deve responder 422 com código "LEGAL_REVIEW_ASSIGNEE_SEGREGATED"
    Given que "Tiago Reis" está lotado na unidade mas não tem "LEGAL_REVIEW_MANAGE"
    When "Dra. Helena Prado" distribuir "LR-0045" a "Tiago Reis"
    Then a API deve responder 422 com código "ASSIGNEE_NOT_ELIGIBLE"
    And "LR-0045" deve continuar sem responsável

  Scenario: [Tenant incorreto] Análise e procurador de outro órgão
    Given que a análise "LR-0007" pertence ao tenant "Prefeitura B" e "Paulo Reis" é procurador da "Prefeitura B"
    When "Dra. Helena Prado" chamar "POST /legal-reviews/{id-LR-0007}/assign"
    Then a API deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND"
    When "Dra. Helena Prado" distribuir "LR-0045" a "Paulo Reis"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "assigneeId"
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio com a mesma chave e designação ao mesmo procurador
    Given que "Dra. Helena Prado" distribuiu "LR-0045" a "Dr. André Nunes" com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único "LegalReviewAssigned"
    When "Dra. Helena Prado" distribuir de novo a "Dr. André Nunes" com a chave "K3" e a ETag nova
    Then a API deve responder 200 sem novo evento, sem nova auditoria e sem novo aviso

  Scenario: [Concorrência] Dois chefes distribuindo ao mesmo tempo e item de lote desatualizado
    Given que "Dra. Helena Prado" e o gestor "Marcos Lima", com "PROCESS_ASSIGN", leram a mesma ETag de "LR-0045"
    When ambos enviarem designações diferentes na mesma janela de tempo
    Then exatamente uma chamada deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    And "LR-0045" deve ter um único responsável
    Given que a ETag de "LR-0050" mudou depois da seleção do lote
    When o lote for enviado
    Then o item "LR-0050" deve vir com código "VERSION_CONFLICT" e os demais devem ser distribuídos

  Scenario: [Falha de banco] Falha ao gravar a designação
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/assign"
    When "Dra. Helena Prado" confirmar a distribuição
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And "LR-0045" e o processo devem continuar sem responsável, sem auditoria, evento ou timeline

  Scenario: [Falha de integração] Relay do outbox ou SMTP indisponível
    Given que o relay do outbox está indisponível
    When "Dra. Helena Prado" distribuir "LR-0045" a "Dr. André Nunes"
    Then a API deve responder 200 e o evento "LegalReviewAssigned" deve permanecer "PENDING" no outbox
    And o aviso deve sair quando o relay voltar, e a falha de e-mail não deve desfazer a designação
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo ou motivo inválido; lote fora do limite | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Foca o campo; mantém o diálogo |
| Procurador inexistente ou de outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um procurador válido." | Recarrega a lista de membros |
| Procurador inelegível | 422 | `ASSIGNEE_NOT_ELIGIBLE` | "Esta pessoa não pode ser responsável por esta análise." | Remove a opção; recarrega |
| Procurador em conflito de segregação | 422 | `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` | "Esta pessoa participou da elaboração do processo e não pode analisá-lo." | Marca a pessoa como indisponível |
| Sem permissão para distribuir | 403 | `PERMISSION_DENIED` | "Você não pode distribuir análises jurídicas." | Oculta o botão |
| Análise inexistente, de outro tenant ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Análise fora de `PENDING`/`IN_REVIEW`, ou remoção em `IN_REVIEW` | 409 | `LEGAL_REVIEW_INVALID_STATE` | "Esta análise não pode ser distribuída no estado atual." | Recarrega a linha |
| Processo fora de `IN_PROGRESS`/`RETURNED` ou fora de `JURIDICO` | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para distribuição no momento." | Desabilita o botão com o motivo |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega a fila |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Esta análise foi alterada por outra pessoa. Atualize a página." | Recarrega e reabre o diálogo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível distribuir agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-050 (comando de atribuição de responsável, `ProcessAssignment`, `ProcessAccess` e `ASSIGNEE_NOT_ELIGIBLE`, reaproveitados); US-149 (cria a `LegalReview`, expõe LGL-01/LGL-02/LGL-09 e a carga por procurador). Indiretas: US-058 (padrão de lote, `inbox.bulkMaxItems`), US-152 e US-155 (usam `assigneeId` para iniciar e concluir), US-154 (edição do parecer), US-102 (titular e substituto da unidade).
- **Decisões/ADRs:** DEC-023, DEC-024, DEC-199; POL-05, POL-19; RN-LGL-06, RN-LGL-07.
- **Configurações:** `inbox.bulkMaxItems` (limite do lote, padrão 50, 2..200).
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos:** `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` (422, candidato em conflito de POL-19) não consta em `permissions.md` (que só tem `LEGAL_REVIEW_SEGREGATION` para o próprio ator); `LEGAL_REVIEW_NOT_FOUND` e `LEGAL_REVIEW_INVALID_STATE` seguem a lacuna da US-152. A consolidar no `api.md` do MVP 2.
  2. **Escopo de `PROCESS_ASSIGN`:** a feature diz "no escopo da unidade jurídica", mas POL-05 só prevê `TENANT`/`ORGANIZATION` ou titular/substituto da unidade atual. A story segue POL-05 (o chefe é o titular). **Dúvida de produto:** admitir `PROCESS_ASSIGN` com escopo `DEPARTMENT` da unidade jurídica para um coordenador que não seja titular.
  3. **`ProcessAssigned.legalReviewId?`** e a supressão da timeline e do aviso `PROCESS_ASSIGNED` quando presente não estão em `events.md`; é mudança aditiva a registrar nas "Mudanças aditivas" (§2). A auditoria da atribuição composta (`legal_review.assign` única, sem `process.assign` duplicado) exige parâmetro no comando da US-050.
  4. **Procurador anterior:** não existe tipo de notificação para quem perde a análise (`events.md §6` só prevê `LEGAL_REVIEW_ASSIGNED` ao designado). **Dúvida de produto:** avisar o anterior.
  5. **Aviso por item no lote:** 45 designações geram 45 avisos ao mesmo procurador. **Dúvida de produto:** agrupar em um aviso por lote (exigiria tipo ou campo novo).
  6. **Lista de membros da unidade e `byAssignee`:** o endpoint de membros usado pelo `DepartmentMemberSelect` (US-050) não está identificado no catálogo; LGL-09 (US-149) fornece a carga. **Remoção da designação só em `PENDING`:** decisão desta story (uma análise em andamento não fica sem dono); validar com o piloto.

## Impacto técnico
- **Atomicidade:** `LegalReview` e `Process` travados em ordem fixa (primeiro `legal_reviews`, depois `processes`) para evitar *deadlock* com a tramitação; a atribuição do processo reaproveita o handler da US-050 em modo composto (sem auditoria, timeline e aviso próprios).
- **Concorrência:** o recálculo da fila (US-149) não muda `version`; portanto só outra distribuição, início ou conclusão invalida a ETag.
- **Desempenho:** LGL-03 p95 < 500 ms; lote de 50 itens < 5 s em série (escritas na suíte de performance, medidas no endurecimento).
- **Compatibilidade:** nenhum contrato do MVP 1 muda além do campo aditivo `legalReviewId?` em `ProcessAssigned`; PRC-22 continua valendo para a atribuição direta fora da fila jurídica.
- **Sigilo:** nenhum valor, faixa ou texto de documento em eventos, avisos e logs.

## Backend
- **Módulo(s):** `legal-review` (dono), `process` (`AssignProcessCommand` da US-050 em modo composto), `organization` (`OrgUnitFacade`: titular, substituto, lotação), `access` (`AuthorizationService`, concessão e retirada de `ProcessAccess`), `timeline`, `notification`, `audit`, `platform` (idempotência, outbox).
- **Casos de uso:** `AssignLegalReviewCommand` (LGL-03), `BulkAssignLegalReviewsCommand` (LGL-04).
- **Domínio:** `LegalReview.assign(assigneeId, reason, actorId)`, `LegalReviewAssignmentPolicy` (elegibilidade e POL-19, compartilhada com `LegalReviewSegregationPolicy` das US-152/154/155).
- **Integrações internas:** `ProcessFacade.assignInternal(...)`, `OrgUnitFacade`, `DocumentFacade.getAuthorsByType`, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** LGL-03 numa transação (bloqueios, validações, `LegalReview`, atribuição do processo, acesso, auditoria, timeline, outbox); LGL-04 uma transação por item.

## Frontend
- **Tela(s):** SCR-019 (fila e painel: ação "Distribuir" e barra de ações em lote) e SCR-115 (diálogo de atribuição adaptado).
- **Componentes:** `AssignLegalReviewDialog` (`DepartmentMemberSelect` com carga por procurador, campo de motivo condicional), `BulkAssignBar`, `BulkResultSummary` (sucessos e erros por análise), `AssigneeCell`.
- **Estados:** skeleton ao carregar membros; vazio ("Nenhum procurador disponível na unidade"); erro com "Tentar novamente"; sucesso fecha o diálogo e atualiza linha e contadores; resultado do lote com lista de erros.
- **Acessibilidade e responsividade:** foco inicial no seletor; motivo anunciado como obrigatório (`aria-required`) quando aplicável; indisponibilidade nunca só por cor (texto e ícone); lote com seleção por teclado e contagem anunciada; abaixo de 768 px o diálogo é tela cheia.

## Banco de dados
- **Tabelas:** `legal_reviews` (escrita de `assignee_id`, `assigned_at`, `assigned_by_id`, `version`), `process_assignments`, `process_stages`, `processes`, `process_access`, `process_movements`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (M2-15 cria `legal_reviews`; as demais tabelas são do MVP 1).
- **Índices/constraints relevantes:** `(tenant_id, assignee_id) WHERE status IN ('PENDING','IN_REVIEW')` (carga por procurador); `UNIQUE (tenant_id, process_id) WHERE is_active` em `process_assignments`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-03` | POST | `/api/v1/legal-reviews/{id}/assign` | `{ assigneeId: uuid \| null, reason? }` + `If-Match` + `Idempotency-Key` | `200 { data: LegalReview }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-04` | POST | `/api/v1/legal-reviews/bulk-assign` | `{ assigneeId, reason?, items: [ { legalReviewId, version } ] }` + `Idempotency-Key` | `200 { data: [ { legalReviewId, ok, code?, message?, review? } ], meta: { successCount, errorCount } }` | 200, 401, 403, 422, 429, 503 |
| `LGL-09` | GET | `/api/v1/legal-reviews/summary` | — (US-149) | carga por procurador (`byAssignee`) | 200, 401, 403 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel; ganha `canAssign` | 200, 401, 403, 404 |
| `PRC-22` | POST | `/api/v1/processes/{id}/assign` | MVP 1 | reaproveitado internamente (modo composto) | 200, 403, 404, 409, 412, 422 |

## Logs
- `info` `legal_review.assigned` — `legalReviewId`, `processId`, `fromUserId?`, `toUserId`, `actorId`, `viaHeadOrDeputy`, `durationMs`, `correlationId`.
- `info` `legal_review.bulk_assigned` — `batchSize`, `successCount`, `errorCount`, `durationMs`.
- `warn` `legal_review.assign_denied` — `reasonCode`, `legalReviewId`; `warn` `assign.not_head_or_deputy_fallback` (autorização só pela titularidade).
- `error` `legal_review.assign_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o texto do motivo, valores do processo ou conteúdo de documentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.assign` | `WORKFLOW` | Commit de LGL-03 e de cada item de LGL-04 | `changes.assigneeId`: anterior para novo; `metadata`: `viaHeadOrDeputy`, `reasonLength?`, `bulk`, `batchId?`, `processAssignmentId` |
| `access.denied` | `ACCESS` | 403 em LGL-03 ou LGL-04 | `reasonCode`, `legalReviewId?` |

## Testes necessários
- **Unitários:** política de elegibilidade e POL-19 (criador, autor por tipo, lotado no setor solicitante, usuário sem `LEGAL_REVIEW_MANAGE`), exigência condicional do motivo, no-op, regra de remoção só em `PENDING`, montagem do resultado por item.
- **Integração (Testcontainers):** designação completa (análise, `ProcessAssignment`, acesso concedido e retirado, movimento, auditoria, evento, timeline única); rollback total na falha; supressão do aviso e da timeline de `PROCESS_ASSIGNED` com `legalReviewId`; lote com sucesso parcial e idempotência do lote.
- **API/contrato:** LGL-03/LGL-04 (códigos, `ETag`, `Idempotent-Replayed`, limites do lote); PRC-22 inalterado.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-03/LGL-04 e candidato de outro tenant; matriz de autorização (gerada) com `PROCESS_ASSIGN`, titular e substituto; segregação do designado.
- **Concorrência:** dois chefes distribuindo (uma efetiva); distribuição x início da análise; distribuição x recálculo da fila (sem 412 espúrio).
- **E2E (Playwright):** distribuir uma análise, redistribuir com motivo, distribuir em lote com erro parcial, ver "Minhas" do procurador.
- **Acessibilidade/performance:** axe em diálogo e barra de lote; 360 px; metas de p95 na suíte de performance.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] POL-19 do designado comprovada por teste (criador, autor, lotado no setor solicitante)
- [ ] Atribuição composta atômica e sem duplicidade de timeline, aviso e auditoria comprovada em teste
- [ ] Gherkin das 8 categorias automatizado, incluindo o lote com sucesso parcial

## Estimativa
**S** — dois comandos finos sobre a atribuição já existente (US-050) e o padrão de lote (US-058); o esforço está na política de elegibilidade e segregação, na atomicidade com o acesso do processo e em evitar registros duplicados.

## Prioridade
**P0** — sem distribuição a fila não tem responsável por análise e o procurador não ganha acesso ao processo; bloqueia o uso real das US-152 a US-155.
