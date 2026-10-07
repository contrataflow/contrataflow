---
id: US-065
title: "Ciclo de vida do documento"
epic: EP-011
feature: FT-040
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-061, US-108]
modules: [document, workflow, access, audit, platform]
screens: [SCR-006, SCR-105]
endpoints: [DOC-04, DOC-08, DOC-09, DOC-10, DOC-12, DOC-13, DOC-14]
permissions: [DOCUMENT_UPDATE, DOCUMENT_SUBMIT, DOCUMENT_REOPEN, DOCUMENT_CANCEL]
events: [DocumentSubmitted, DocumentFinalized, DocumentApproved, DocumentReturned, DocumentRejected, DocumentReopened, DocumentCanceled, DocumentVersionCreated]
---

# US-065 — Ciclo de vida do documento

## Título
Controlar o ciclo de vida do documento (rascunho, revisão, aprovação, devolução, reabertura e cancelamento)

## Descrição
**Como** sistema que sustenta todos os tipos de documento do processo, **quero** aplicar um único ciclo de vida previsível — rascunho, em revisão, devolvido, finalizado, aprovado, indeferido, cancelado — com validação de completude antes de qualquer avanço, **para** que módulos tipados (DFD, ETP, TR, mapa de riscos, pesquisa de preços, fora deste épico) e documentos livres/externos (US-063/US-064) tenham o mesmo comportamento confiável de finalização, submissão, aprovação, devolução, reabertura e cancelamento.

Esta story implementa o `DocumentLifecycleService` (DEC-018): as transições de `status`, a criação de versão no momento certo, o cálculo de `meta.allowedActions`, a verificação de documento singular por tipo (`singletonKey`) e a validação de completude (`DOC-08`), que combina regras genéricas do módulo `document` com as regras específicas registradas por cada módulo tipado através da interface `DocumentValidator`.

## Contexto
- DEC-017/DEC-018 unificam o ciclo de vida de todo `Document`, independentemente de `kind` (`STRUCTURED`, `FREE_TEXT`, `UPLOADED`). Sem essa unificação, cada módulo tipado (DFD, ETP, TR…) reimplementaria sua própria máquina de estados, divergindo com o tempo.
- O padrão de "porta declarada no módulo dono, implementada pelo módulo consumidor" já existe no produto (ex.: `DocumentTypeUsageProvider`, declarada em `document` e implementada por `workflow`, US-061); esta story aplica o mesmo padrão para a validação de completude (`DocumentValidator`).
- Singularidade (`singletonKey`) e numeração de documento (DEC-019, DEC-028) precisam de um único ponto de aplicação para não divergir entre os módulos tipados e os documentos livres/externos.
- É base para US-062 (painel), US-063 (documento livre) e US-064 (documento externo) e para os módulos tipados do MVP 1 (fora deste épico), que apenas registram sua própria validação e seu próprio `typedSummary`.

## Objetivo
Garantir que 100% das transições de `status` de documento sigam exatamente a tabela de DEC-018, com versão criada nos momentos corretos, validação de completude consistente (`violations[]`) e nenhuma transição inválida aceita pela API.

## Persona
- **Principal:** redator/custodiante do processo (`REQUISITANTE`, `GESTOR_CONTRATACOES`, `GESTOR_CONTRATO`) agindo sobre documentos sob sua custódia ou participação.
- **Secundárias:** aprovadores de etapa e de aprovação avulsa (módulo de aprovações, fora deste épico), que consomem o resultado das transições aqui definidas.

## Pré-condições
- Documento existente, vinculado a um processo visível ao usuário (DEC-024).
- Permissão aplicável à ação (`DOCUMENT_UPDATE`, `DOCUMENT_SUBMIT`, `DOCUMENT_REOPEN` ou `DOCUMENT_CANCEL`) e política correspondente (POL-02 ou POL-11) atendidas.
- Processo em status compatível com a ação (`DRAFT`/`IN_PROGRESS`/`RETURNED` para editar, finalizar, submeter ou cancelar).

## Fluxo principal
1. O usuário abre um documento em `DRAFT`/`RETURNED` sem pendências óbvias e clica em **"Finalizar"** (tipos com `requiresApproval = false` — caso mais comum, usado por DFD, ETP, TR, mapa de riscos, pesquisa de preços e pela maioria dos tipos `FREE_TEXT`).
2. O front chama `GET /api/v1/documents/{id}/validation` (`DOC-08`) e mostra as pendências: bloqueantes (`BLOCKING`) impedem a ação; avisos (`WARNING`) podem ser reconhecidos e seguidos.
3. Sem pendências bloqueantes, o usuário confirma; o front envia `POST /api/v1/documents/{id}/finalize` (`DOC-10`) com `If-Match` e, se houver, `acknowledgedWarnings`.
4. A API, em uma transação: revalida a completude (defesa em profundidade); monta o `DocumentSnapshot` (cabeçalho, seções, coleções); cria uma `DocumentVersion` (`reason = FINALIZATION`, `contentHash` SHA-256 do JSON canonicalizado — DEC-084); atualiza `status = FINALIZED`, `finalizedAt`/`finalizedById`; grava auditoria `document.finalize`; publica `DocumentFinalized` (com `typedSummary`, se o tipo for `STRUCTURED`) e `DocumentVersionCreated` no outbox, e as entradas de timeline correspondentes; confirma.
5. A API responde **200** com o documento atualizado e `ETag` incrementado.
6. A tela atualiza `meta.allowedActions`: a edição fica bloqueada e passam a aparecer as ações compatíveis com `FINALIZED` (ex.: "Reabrir", se o usuário tiver `DOCUMENT_REOPEN`).

## Fluxos alternativos
- **FA-01 — Submeter avulso (`DOC-09`):** para tipos com `requiresApproval = true`, o botão é "Submeter" em vez de "Finalizar"; a transição vai para `IN_REVIEW`, cria a `DocumentVersion` (`reason = SUBMISSION`) e abre uma `Approval` (`subjectType = DOCUMENT`) conforme `DocumentType.approvalPolicy`.
- **FA-02 — Entrada do processo em etapa de aprovação (acionada pelo módulo de tramitação/aprovações, fora deste épico):** para documentos cujo tipo conste em `WorkflowStage.approvalDocumentTypeCodes` da etapa `APPROVAL`, se o `status` estiver em `DRAFT`/`RETURNED`, o `DocumentLifecycleService` aplica o mesmo efeito de finalizar/submeter e transiciona para `IN_REVIEW`; se já `FINALIZED`/`APPROVED`, o `status` não muda — apenas `pendingApprovalId` é preenchido.
- **FA-03 — Decisão de aprovação (módulo de aprovações, fora deste épico):** ao receber a decisão, o serviço aplica `APPROVED` (preenche `approvedVersionId`), `RETURNED` ou `REJECTED`, sempre limpando `pendingApprovalId` (RN-DOC-45).
- **FA-04 — Pendências apenas de aviso:** o usuário marca "Reconheço os avisos" (`acknowledgedWarnings`) e a ação prossegue sem bloqueio.
- **FA-05 — Reabrir documento concluído (`DOC-12`):** de `APPROVED`/`FINALIZED`/`REJECTED` para `DRAFT`, com justificativa obrigatória; cria um novo rascunho de trabalho a partir do conteúdo da última versão; bloqueado se houver `pendingApprovalId`.
- **FA-06 — Cancelar documento em rascunho (`DOC-13`):** de `DRAFT`/`RETURNED` para `CANCELED` (final), com justificativa; exige custódia atual do processo.
- **FA-07 — Excluir rascunho nunca submetido (`DOC-14`):** exclusão lógica, permitida apenas se o documento nunca saiu de `DRAFT`.
- **FA-08 — Retirar submissão avulsa (`DOC-11`, US-053, fora desta story):** `IN_REVIEW` → `DRAFT`, cancelando a `Approval` pendente; citado aqui apenas como transição consumida pela máquina de estados.

## Regras de negócio
- **RN-DOC-41** — Toda transição de `status` (DEC-018) é exclusiva do `DocumentLifecycleService`; nunca ocorre por `PATCH` direto no campo `status`.
- **RN-DOC-42** — **Finalizar** (`DOC-10`): de `DRAFT`/`RETURNED` para `FINALIZED`, somente para tipos com `requiresApproval = false`; valida completude (`DOC-08`), cria `DocumentVersion` (`reason = FINALIZATION`), bloqueia a edição e grava `finalizedAt`/`finalizedById`.
- **RN-DOC-43** — **Submeter avulso** (`DOC-09`): de `DRAFT`/`RETURNED` para `IN_REVIEW`, somente para tipos com `requiresApproval = true`; valida completude, cria `DocumentVersion` (`reason = SUBMISSION`), cria `Approval` (`subjectType = DOCUMENT`) conforme `DocumentType.approvalPolicy` e grava `submittedAt`/`submittedById`.
- **RN-DOC-44** — **Entrada em etapa de aprovação** (acionada fora deste épico): para documentos cujo tipo conste em `WorkflowStage.approvalDocumentTypeCodes` da etapa `APPROVAL`, se `status` ∈ {`DRAFT`, `RETURNED`}, aplica-se o mesmo efeito de finalizar/submeter (valida completude e cria versão) e o `status` passa a `IN_REVIEW`; se já `FINALIZED`/`APPROVED`, o `status` não muda — apenas `pendingApprovalId` é preenchido com a nova `Approval` (`subjectType = PROCESS_STAGE`).
- **RN-DOC-45** — A decisão de aprovação (módulo fora deste épico) aplica: `APPROVED` → `status = APPROVED` e `approvedVersionId` igual à versão analisada; `RETURNED` → `status = RETURNED`; `REJECTED` → `status = REJECTED`; em qualquer caso, `pendingApprovalId` é limpo.
- **RN-DOC-46** — **Retirar submissão avulsa** (`DOC-11`, US-053): `IN_REVIEW` → `DRAFT`, cancelando a `Approval` pendente; a implementação da ação do usuário é da US-053 — aqui apenas se garante que o documento aceite essa transição.
- **RN-DOC-47** — **Reabrir** (`DOC-12`, `DOCUMENT_REOPEN` + POL-11): de `APPROVED`/`FINALIZED`/`REJECTED` para `DRAFT`; exige `reopenReason` (mínimo 20 caracteres); cria um rascunho de trabalho a partir do conteúdo de `currentVersionId`; bloqueado com `INVALID_STATE` (409) se `pendingApprovalId` estiver preenchido.
- **RN-DOC-48** — **Cancelar** (`DOC-13`, `DOCUMENT_CANCEL`): somente de `DRAFT`/`RETURNED` para `CANCELED` (final); exige `cancellationReason` (mínimo 20 caracteres); requer custódia atual do processo (POL-01, fora deste épico) — sem custódia, `NOT_PROCESS_CUSTODIAN` (403).
- **RN-DOC-49** — **Excluir** (`DOC-14`, exclusão lógica — DEC-034): permitida apenas quando o documento nunca saiu de `DRAFT` (nenhuma `DocumentVersion` com `reason` `SUBMISSION` ou `FINALIZATION`); do contrário, só `CANCELED` é possível.
- **RN-DOC-50** — `singletonKey = documentTypeId` quando `DocumentType.allowMultiplePerProcess = false`; a criação de um segundo documento ativo (não `CANCELED`) do mesmo tipo singular no mesmo processo é rejeitada com `DOCUMENT_ALREADY_EXISTS` (409), inclusive sob concorrência (índice único parcial em `documents`).
- **RN-DOC-51** — `DOC-08` (validação de completude) combina: (a) regras genéricas do módulo `document` (seções `REQUIRED`/`REQUIRED_OR_JUSTIFY` incompletas, campos de cabeçalho obrigatórios do tipo); (b) quando `DocumentType.systemModule` estiver presente, as regras do `DocumentValidator` registrado pelo módulo tipado correspondente (fora deste épico) — compondo um único array `violations[]` (api.md §2.1.2).
- **RN-DOC-52** — Ao finalizar/submeter com sucesso, se `DocumentType.systemModule` estiver presente, o `DocumentLifecycleService` solicita ao módulo tipado (pelo mesmo mecanismo de porta/adaptador de `DocumentValidator`) um `typedSummary` serializável para incluir no evento `DocumentFinalized`; tipos `FREE_TEXT`/`UPLOADED` não produzem `typedSummary` (campo omitido).
- **RN-DOC-53** — Toda transição que a tabela de DEC-018 associa à criação de versão cria exatamente uma `DocumentVersion`, com `contentHash` SHA-256 do JSON canonicalizado (RFC 8785, DEC-084) do `DocumentSnapshot` (entities.md §5.3.2); a reabertura em si não cria versão — a próxima versão só nasce na finalização/submissão seguinte.
- **RN-DOC-54** — A auditoria de alterações de rascunho (`document.draft_update`, gerada pelo autosave de seção — `DOC-05`, US-015/US-063) é coalescida: no máximo um registro por documento/seção/usuário a cada 10 minutos, consolidando o intervalo de revisões e a variação de tamanho; toda transição de status (`submit`, `finalize`, `reopen`, `cancel`, `delete`) gera um registro individual, nunca coalescido.
- **RN-DOC-55** — POL-02 governa a edição de cabeçalho (`DOC-04`) e das coleções tipadas (`DocumentItem` e equivalentes) enquanto o documento dono estiver em `DRAFT`/`RETURNED`; POL-11 governa especificamente a reabertura (RN-DOC-47).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Responsável | `responsibleId` | seleção | Não (`DOC-04`) | usuário com acesso ao processo | criador |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de códigos | Condicional (`DOC-09`/`DOC-10`) | deve cobrir todos os `WARNING` pendentes | `[]` |
| Justificativa da reabertura | `reopenReason` | texto longo | Sim (`DOC-12`) | mínimo 20 caracteres | — |
| Motivo do cancelamento | `cancellationReason` | texto longo | Sim (`DOC-13`) | mínimo 20 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Pendência bloqueante não resolvida | API | "Há pendências que impedem esta ação." | `DOCUMENT_INCOMPLETE` (`violations[]`) |
| V-02 | Aviso não reconhecido | API | "Reconheça os avisos para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-03 | Justificativa de reabertura/cancelamento curta | Front + API | "Justifique com pelo menos 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-04 | Reabertura com aprovação pendente | API | "Este documento tem uma aprovação em andamento e não pode ser reaberto." | `INVALID_STATE` |
| V-05 | Transição incompatível com o status atual | API | "Esta ação não está disponível para o status atual do documento." | `INVALID_STATE` |
| V-06 | Cancelamento sem custódia do processo | API | "Apenas o responsável atual pelo processo pode cancelar este documento." | `NOT_PROCESS_CUSTODIAN` |
| V-07 | Exclusão de documento já submetido | API | "Este documento já foi submetido; só pode ser cancelado." | `INVALID_STATE` |
| V-08 | Segundo documento de tipo singular | API | "Este processo já tem um documento deste tipo." | `DOCUMENT_ALREADY_EXISTS` |
| V-09 | `If-Match` ausente/divergente | API | "Esta informação foi atualizada por outra pessoa. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |

## Permissões
- **Permissão:** `DOCUMENT_UPDATE` (`DOC-04`, e implicitamente `DOC-14` por reaproveitar a condição de documento editável); permissão de submissão do tipo (`DOCUMENT_SUBMIT`, para `DOC-09`/`DOC-10`); `DOCUMENT_REOPEN` (`DOC-12`); `DOCUMENT_CANCEL` (`DOC-13`).
- **Políticas:** POL-02 (edição/submissão: permissão do tipo + custódia **ou** participação `COLLABORATOR`/`CONSULTANT` + status `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável); POL-11 (reabertura: `DOCUMENT_REOPEN` + custódia + processo editável + tipo permitido na etapa + justificativa + sem aprovação pendente); cancelamento exige custódia do processo (POL-01, fora deste épico), não apenas participação.
- **MFA:** não exigido para `DOCUMENT_UPDATE`/`DOCUMENT_SUBMIT`/`DOCUMENT_CANCEL` (risco médio); `DOCUMENT_REOPEN` é risco alto e pode exigir MFA conforme a política de risco do tenant (`security.mfaPolicy`).
- **Sem permissão:** botões de ação ocultos/desabilitados conforme `meta.allowedActions`; chamada direta responde 403 `PERMISSION_DENIED` (ou `NOT_PROCESS_CUSTODIAN` para cancelamento sem custódia).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentSubmitted` | `document.submitted.<type>` | Commit de `DOC-09` ou entrada em etapa de aprovação | `documentId`, `documentVersionId`, `approvalId?` |
| `DocumentFinalized` | `document.finalized.<type>` | Commit de `DOC-10` | `documentId`, `documentVersionId`, `typedSummary?` |
| `DocumentVersionCreated` | `document.version_created.<type>` | Toda transição que cria versão (RN-DOC-53) | `documentId`, `documentVersionId`, `versionNumber`, `reason`, `contentHash` |
| `DocumentApproved` | `document.approved.<type>` | Decisão de aprovação `APPROVED` (fora deste épico) | `documentId`, `documentVersionId`, `approvalId` |
| `DocumentReturned` | `document.returned.<type>` | Decisão de aprovação `RETURNED` | `documentId`, `approvalId` |
| `DocumentRejected` | `document.rejected.<type>` | Decisão de aprovação `REJECTED` | `documentId`, `approvalId` |
| `DocumentReopened` | `document.reopened.<type>` | Commit de `DOC-12` | `documentId`, `fromStatus`, `baseVersionId` |
| `DocumentCanceled` | `document.canceled.<type>` | Commit de `DOC-13` | `documentId`, `fromStatus` |

Projeções síncronas na mesma transação: entradas de timeline `DOCUMENT_SUBMITTED`/`DOCUMENT_FINALIZED`, `DOCUMENT_VERSION_CREATED`, `DOCUMENT_APPROVED`/`DOCUMENT_RETURNED`/`DOCUMENT_REJECTED`, `DOCUMENT_REOPENED`/`DOCUMENT_CANCELED` (events.md §5).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria: o catálogo (`NotificationType`, events.md §6) não tem um tipo dedicado a transições diretas de documento — apenas timeline. Quando a transição decorre de uma aprovação de etapa, a notificação já existente `APPROVAL_DECIDED` cobre o caso (destinatários incluem o `responsibleId` dos documentos cobertos). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Ciclo de vida do documento

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está em "IN_PROGRESS"
    And existe o documento "ETP 0001/2026" (`requiresApproval = false`) em "DRAFT", sob custódia de "Ana"

  Scenario: [Sucesso] Finalizar um documento completo
    Given que o documento não tem pendências bloqueantes em "DOC-08"
    When "Ana" finalizar o documento
    Then o status deve mudar para "FINALIZED"
    And deve ser criada uma "DocumentVersion" com `reason = "FINALIZATION"`
    And deve ser gerado o evento "DocumentFinalized"
    And deve existir uma entrada "DOCUMENT_FINALIZED" na timeline
    And deve gerar registro de auditoria "document.finalize"

  Scenario: [Sucesso] Submeter avulso um documento com aprovação própria
    Given que o tipo "DESPACHO_SIGILOSO" tem `requiresApproval = true`
    And existe um documento desse tipo em "DRAFT", sem pendências
    When "Ana" submeter o documento
    Then o status deve mudar para "IN_REVIEW"
    And deve ser criada uma "Approval" com `subjectType = "DOCUMENT"`
    And deve ser gerado o evento "DocumentSubmitted"

  Scenario: [Validação] Finalizar com pendências bloqueantes
    Given que o documento tem a pendência bloqueante "Informe ao menos um item com quantidade."
    When "Ana" tentar finalizar o documento
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE"
    And o corpo deve trazer "violations" com a pendência listada
    And o status deve permanecer "DRAFT"

  Scenario: [Validação] Reabrir com aprovação pendente
    Given que o documento "ETP 0001/2026" está "FINALIZED" com `pendingApprovalId` preenchido
    When "Ana" tentar reabrir o documento
    Then a API deve responder 409 com código "INVALID_STATE"
    And o status deve permanecer "FINALIZED"

  Scenario: [Permissão] Reabrir sem a permissão DOCUMENT_REOPEN
    Given que o documento "ETP 0001/2026" está "APPROVED"
    And "Bruno" não tem `DOCUMENT_REOPEN`
    When "Bruno" tentar reabrir o documento
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o status deve permanecer "APPROVED"

  Scenario: [Permissão] Cancelar sem custódia do processo
    Given que "Carla" tem `DOCUMENT_CANCEL` mas não é a custodiante atual do processo
    When "Carla" tentar cancelar o documento "ETP 0001/2026" em "DRAFT"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Transição em documento de outro tenant
    Given que o documento "X" pertence ao tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", chamar "POST /api/v1/documents/{id-de-X}/finalize"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Segundo documento de tipo singular no mesmo processo
    Given que o processo já tem um "ETP" com status "APPROVED"
    When alguém chamar "POST /api/v1/processes/{id}/documents" com o tipo "ETP"
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"

  Scenario: [Duplicidade] Reenvio da finalização com a mesma chave de idempotência
    Given que "Ana" finalizou o documento com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo documento e "Idempotent-Replayed: true"
    And deve existir apenas uma "DocumentVersion" criada

  Scenario: [Concorrência] Finalizar com ETag desatualizado
    Given que o documento está na versão de concorrência "3" (`ETag: "3"`)
    When "Ana" enviar "POST /documents/{id}/finalize" com "If-Match: \"2\""
    Then a API deve responder 412 com código "VERSION_CONFLICT" e `currentVersion = 3`
    And nenhuma nova "DocumentVersion" deve ser criada

  Scenario: [Concorrência] Duas finalizações simultâneas do mesmo documento
    When duas requisições de finalização chegarem quase ao mesmo tempo, ambas com `If-Match` válido
    Then exatamente uma deve ser aceita com status 200
    And a outra deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao finalizar
    Given que o banco de dados está indisponível
    When "Ana" tentar finalizar o documento
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o status deve permanecer "DRAFT" e nenhuma versão deve ser criada

  Scenario: [Falha de integração] Outbox indisponível ao finalizar
    Given que o relay do outbox está indisponível
    When "Ana" finalizar o documento com sucesso
    Then o status deve mudar para "FINALIZED" e a API deve responder 200
    And o evento "DocumentFinalized" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Pendências bloqueantes | 422 | `DOCUMENT_INCOMPLETE` | "Há pendências que impedem esta ação." | Lista `violations[]` com links às seções/campos |
| Avisos não reconhecidos | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Reconheça os avisos para continuar." | Checklist de avisos |
| Transição incompatível | 409 | `INVALID_STATE` | "Esta ação não está disponível para o status atual." | Atualiza `meta.allowedActions` e re-renderiza botões |
| Reabertura bloqueada por aprovação pendente | 409 | `INVALID_STATE` | "Este documento tem uma aprovação em andamento." | Oculta "Reabrir"; mostra link para a aprovação |
| Sem custódia para cancelar | 403 | `NOT_PROCESS_CUSTODIAN` | "Apenas o responsável atual pelo processo pode cancelar este documento." | Oculta "Cancelar" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta botão |
| Tipo singular duplicado | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem um documento deste tipo." | Impede nova criação |
| `If-Match` ausente/divergente | 428/412 | `PRECONDITION_REQUIRED`/`VERSION_CONFLICT` | "Esta informação foi atualizada por outra pessoa." | Recarrega o documento |
| Documento/processo inexistente ou outro tenant | 404 | `NOT_FOUND` | "Documento não encontrado." | Redireciona ao painel |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora." | Botão "Tentar novamente" |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-061 (`DocumentType.requiresApproval`/`approvalPolicy`, catálogo de tipos); US-108 (modelos publicados usados na validação de seções). Consomem esta story: US-062 (`meta.allowedActions`), US-063 e US-064 (criação e validação de completude). Implementam `DocumentValidator`/`typedSummary` (fora deste épico): módulos de DFD, ETP, TR, mapa de riscos e pesquisa de preços. Aciona transições automáticas (fora deste épico): módulo de tramitação/aprovações.
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-019, DEC-024, DEC-034, DEC-056, DEC-084; ADR-006.
- **Configurações:** nenhuma configuração nova própria desta story (reaproveita `numbering.document.defaultMask` definida em US-061/US-063).
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Estabelece o **padrão de máquina de estados de documento** reutilizado por todo o produto: validar → autorizar (POL-02/POL-11) → checar completude (`DocumentValidator`) → transicionar → criar versão → auditar → publicar evento → projetar timeline → commit. Deve ser extraído como `DocumentLifecycleService` reutilizável por todos os módulos tipados.
- A porta `DocumentValidator` (e o mecanismo de `typedSummary`) precisa de um registro por `SystemDocumentModule`, resolvido em tempo de execução; módulos tipados que não registrarem validador tratam a validação genérica como suficiente (nunca falha por ausência de registro).
- `singletonKey` com índice único parcial é a defesa definitiva contra duplicidade de tipo singular sob concorrência; a aplicação não deve depender apenas de verificação prévia em memória.
- Transições concorrentes sobre o mesmo documento são resolvidas por `If-Match`/`ETag` (otimista), nunca por lock pessimista de longa duração.

## Backend
- **Módulo(s):** `document` (dono); usa `workflow` (etapa atual, `documentTypeCodes`/`approvalDocumentTypeCodes`), `access` (POL-01/POL-02/POL-11), `audit` (`AuditService`, coalescimento), `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `FinalizeDocumentCommand` → `FinalizeDocumentHandler` (`DOC-10`); `SubmitDocumentCommand` → `SubmitDocumentHandler` (`DOC-09`); `ReopenDocumentCommand` → `ReopenDocumentHandler` (`DOC-12`); `CancelDocumentCommand` → `CancelDocumentHandler` (`DOC-13`); `DeleteDocumentCommand` → `DeleteDocumentHandler` (`DOC-14`); `UpdateDocumentHeaderCommand` → `UpdateDocumentHeaderHandler` (`DOC-04`); `GetDocumentValidationQuery` → `GetDocumentValidationHandler` (`DOC-08`); `ApplyApprovalDecisionToDocument` (consumido pelo módulo de aprovações, fora deste épico).
- **Domínio:** `Document` (entidade raiz) com métodos `finalize()`, `submit()`, `reopen(reason)`, `cancel(reason)`, `delete()`, aplicando DEC-018; porta `DocumentValidator` (`validate(document): Violation[]`), implementada pelos módulos tipados; `DocumentLifecycleService.allowedActions(document, actor)` (usado por US-062).
- **Integrações internas:** `workflow.getCurrentStage(processId)`; `access.assertCan(permission, { processId, documentId })`; registro de `DocumentValidator` por `systemModule` (injeção de dependência).
- **Transação:** cada transição em uma única transação interativa (validar → autorizar → checar completude → atualizar status → criar versão → auditoria → outbox → timeline → commit); isolamento `READ COMMITTED` + `If-Match` para concorrência otimista.

## Frontend
- **Tela(s):** SCR-006 (resumo do status no painel) e SCR-105 (ações completas no documento).
- **Componentes:** `DocumentActionsBar` (botões conforme `meta.allowedActions`), `CompletenessPanel` (lista `violations[]` com links), `AcknowledgeWarningsDialog`, `ReopenDialog`/`CancelDialog` (com campo de justificativa), `StatusTimeline`.
- **Estados:** carregando pendências; pendências bloqueantes (ação desabilitada); apenas avisos (ação habilitada com confirmação); sucesso (toast + atualização de status); erro de concorrência (recarregar).
- **Acessibilidade e responsividade:** foco movido para a primeira pendência ao abrir `CompletenessPanel`; diálogos de justificativa com `aria-describedby`; barra de ações colapsa em menu "Mais ações" em telas < 768 px.

## Banco de dados
- **Tabelas:** escrita em `documents` (status e timestamps de transição), `document_versions`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** nenhuma nova (reaproveita o esquema de `documents`/`document_versions` de entities.md §4).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, singleton_key) WHERE singleton_key IS NOT NULL AND status <> 'CANCELED' AND deleted_at IS NULL` (RN-DOC-50); `UNIQUE (tenant_id, document_id, version_number)` em `document_versions`; `CHECK (status <> 'CANCELED' OR cancellation_reason IS NOT NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-04 | PATCH | `/api/v1/documents/{id}` | `{ title?, responsibleId? }` + `If-Match` | `200 { data: Document }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-08 | GET | `/api/v1/documents/{id}/validation` | — | `200 { data: { violations: Violation[] } }` | 200, 403, 404, 503 |
| DOC-09 | POST | `/api/v1/documents/{id}/submit` | `{ acknowledgedWarnings? }` + `If-Match` + `Idempotency-Key` | `200 { data: Document }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-10 | POST | `/api/v1/documents/{id}/finalize` | `{ acknowledgedWarnings? }` + `If-Match` + `Idempotency-Key` | `200 { data: Document }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-12 | POST | `/api/v1/documents/{id}/reopen` | `{ reopenReason }` + `If-Match` | `200 { data: Document }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-13 | POST | `/api/v1/documents/{id}/cancel` | `{ cancellationReason }` + `If-Match` | `200 { data: Document }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-14 | DELETE | `/api/v1/documents/{id}` | `If-Match` | `204` | 204, 403, 404, 409, 412, 428, 503 |

## Logs
- `info` `document.status_changed` — `documentId`, `fromStatus`, `toStatus`, `reason`, `durationMs`.
- `info` `document.version_create` — `documentId`, `documentVersionId`, `versionNumber`, `reason`.
- `warn` `document.completeness_blocked` — `documentId`, quantidade de `violations` bloqueantes.
- `error` `document.transition_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo de seções, justificativas de reabertura/cancelamento, `violations[].message` quando derivado de dados sigilosos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.submit` | `DATA_CHANGE` | Commit de `DOC-09` ou entrada em etapa de aprovação | `metadata`: `documentVersionId`, `approvalId?` |
| `document.finalize` | `DATA_CHANGE` | Commit de `DOC-10` | `metadata`: `documentVersionId`, `typedSummary?` |
| `document.version_create` | `DATA_CHANGE` | Toda transição com versão | `metadata`: `versionNumber`, `reason`, `contentHash` |
| `document.reopen` | `DATA_CHANGE` | Commit de `DOC-12` | `changes`: `fromStatus`; `metadata`: hash da justificativa + tamanho |
| `document.cancel` | `DATA_CHANGE` | Commit de `DOC-13` | `changes`: `fromStatus`; `metadata`: hash da justificativa + tamanho |
| `document.delete` | `DATA_CHANGE` | Commit de `DOC-14` | `metadata`: `documentTypeCode` |
| `document.draft_update` | `DATA_CHANGE` | Autosave de seção (coalescida — RN-DOC-54) | `metadata`: `sectionKey`, intervalo de revisões |

## Testes necessários
- **Unitários:** máquina de estados `Document` (todas as transições de DEC-018, inclusive as inválidas); composição de `violations[]` (genéricas + `DocumentValidator` simulado); cálculo de `allowedActions`.
- **Integração (Testcontainers PostgreSQL + Redis):** `singletonKey` sob concorrência (duas criações simultâneas → uma 201, outra `DOCUMENT_ALREADY_EXISTS`); atomicidade de cada transição (falha simulada → nada persiste); RLS multi-tenant.
- **Concorrência:** duas transições simultâneas sobre o mesmo documento com `If-Match` iguais → uma 200, outra `VERSION_CONFLICT`; duas finalizações com a mesma `Idempotency-Key` → replay.
- **API/contrato:** respostas e erros conforme api.md para `DOC-04/08/09/10/12/13/14`.
- **RBAC e multi-tenant:** matriz de perfis × permissões para cada transição; documento de outro tenant → 404.
- **E2E (Playwright):** finalizar documento completo; bloquear finalização por pendência; reabrir com justificativa; cancelar rascunho; excluir rascunho nunca submetido.
- **Acessibilidade/performance:** axe no painel de pendências e nos diálogos; transição com p95 < 400 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Todas as transições de DEC-018 cobertas por teste, incluindo as rejeitadas
- [ ] `DocumentValidator` documentado como porta/interface para os módulos tipados (fora deste épico) a implementarem
- [ ] `singletonKey` validado sob concorrência em teste de integração
- [ ] Auditoria e eventos de cada transição verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `DOC-04/08/09/10/12/13/14` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `document_transition_total` por `fromStatus`/`toStatus`
- [ ] Painéis e diálogos acessíveis (axe) e responsivos (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Padrão `DocumentLifecycleService`/`DocumentValidator` documentado para reúso pelos módulos tipados

## Estimativa
**L** — implementa a máquina de estados central de todo o módulo de documentos, a interface de extensão para os módulos tipados (`DocumentValidator`/`typedSummary`), a aplicação de `singletonKey` sob concorrência e a auditoria coalescida — base reutilizada por praticamente todas as demais stories do épico e por módulos de outros épicos.

## Prioridade
**P0** — sem o ciclo de vida único, nenhum documento do MVP 1 (estruturado, livre ou externo) pode ser submetido, aprovado, devolvido, reaberto ou cancelado de forma consistente.
