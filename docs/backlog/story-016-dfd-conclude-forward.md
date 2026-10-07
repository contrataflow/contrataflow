---
id: US-016
title: "Revisar, concluir e enviar o DFD para aprovação"
epic: EP-002
feature: FT-009
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-015, US-047, US-051]
modules: [dfd, document, process, workflow, approval, timeline, audit, notification, platform]
screens: [SCR-007, SCR-103, SCR-006]
endpoints: [DFD-03, DOC-08, PRC-08, PRC-19, DOC-10, DOC-15, DOC-21, DOC-22, DOC-23]
permissions: [PROCESS_FORWARD, DFD_SUBMIT, PROCESS_VIEW]
events: [ProcessStageChanged, ProcessStatusChanged, ProcessAssigned, ProcessNumberAssigned, DocumentVersionCreated, DocumentSubmitted, ApprovalRequested, DocumentFinalized]
---

# US-016 — Revisar, concluir e enviar o DFD para aprovação

## Título
Revisar, concluir e enviar o DFD para aprovação

## Descrição
**Como** servidora da área requisitante que está com o processo, **quero** concluir o DFD e enviá-lo para aprovação do titular da secretaria em um único passo, **para** formalizar a demanda sem precisar entender a mecânica de tramitação e com a certeza de que o aprovador analisará exatamente a versão que eu conferi.

No passo **5 — Conclusão** do wizard (SCR-007), a ação primária **"Concluir e enviar para aprovação"** executa o encaminhamento do processo (PRC-19) de `ABERTURA` para `APROVACAO_DFD`. Em uma única transação o servidor revalida a completude, move o processo, cria a `Approval` (US-051) e **submete automaticamente o DFD** (DEC-018): `DRAFT`/`RETURNED` → `IN_REVIEW`, com versão imutável e hash coberta pela aprovação (`ApprovalDocument`). Quem não pode encaminhar mas pode concluir documentos usa a alternativa **"Finalizar DFD"** (DOC-10). Após a conclusão, o PDF oficial é a renderização da versão.

## Contexto
- A requisitante não domina "tramitar"; para ela, concluir a demanda e mandá-la para o secretário é um ato só (persona P03, DEC-181).
- DEC-015: a saída de `ABERTURA` exige "DFD existente e completo" e a etapa `APROVACAO_DFD` (APPROVAL, `DEPARTMENT_HEAD` da secretaria solicitante) cobre o tipo `DFD`. DEC-018: a entrada do processo em etapa APPROVAL que cobre o tipo submete o documento (valida completude e cria versão); documento já `FINALIZED` permanece `FINALIZED` com `pendingApprovalId`, exibido com o selo derivado **"Em aprovação"**. DEC-016: avisos (`WARNING`) exigem reconhecimento explícito (`acknowledgedWarnings[]`). DEC-022: aprovação sobre versões exatas e segregação de funções (Lei 14.133, art. 7º, § 1º). api.md §3.5: "Concluir e enviar para aprovação" = PRC-19.
- A mecânica genérica (encaminhar, resolver aprovador, submeter documentos cobertos) é de US-047 e US-051; esta story entrega a experiência do DFD, o submissor/snapshot do tipo e a finalização alternativa, garantindo o fluxo ponta a ponta da jornada J-02 (acceptance-criteria.md).

## Objetivo
Concluir e enviar em no máximo 3 cliques a partir do passo 5; nenhum DFD submetido com pendência `BLOCKING`; 100% das aprovações apontando para a versão exata submetida; mediana da criação do DFD à submissão ≤ 1 dia útil (KPI E4).

## Persona
- **Principal:** Área requisitante — Cláudia Ferreira (`REQUISITANTE`), responsável atual do processo.
- **Secundárias:** Planejamento — Marcos Vinícius Rocha (`PLANEJAMENTO`, participante `COLLABORATOR`), que pode finalizar sem encaminhar; Gestora de contratações — Patrícia Almeida (`GESTOR_CONTRATACOES`); titular da Secretaria de Saúde — Dra. Helena Prado (aprovadora, US-052) e o substituto Paulo Mendes.

## Pré-condições
- DFD em `DRAFT` ou `RETURNED` (US-014/US-015), sem gravações de autosave pendentes.
- Processo na etapa `ABERTURA` com status `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Para enviar: custódia (POL-01) e `PROCESS_FORWARD`; transição `FORWARD` para `APROVACAO_DFD` disponível em PRC-08.
- Para finalizar: `DFD_SUBMIT` + POL-02.
- Secretaria solicitante com titular (`headUserId`) definido, para a resolução do aprovador (US-051).

## Fluxo principal
1. No passo 4, sem pendências, a usuária clica em "Continuar" e chega ao passo **5 — Conclusão**.
2. O front carrega PRC-08 e DOC-08 e exibe o cartão "Pronto para envio": código e situação do DFD; destino "Aprovação da demanda — Titular da Secretaria de Saúde"; prazo previsto da etapa (ex.: "até 3 dias úteis"); alertas (`WARNING`) com caixa de reconhecimento individual; campo opcional **"Mensagem ao aprovador"**.
3. Ao clicar em **"Concluir e enviar para aprovação"**, o front: descarrega o autosave (aguarda a fila vazia — RN-DFD-42); repete DOC-08; abre o painel de encaminhamento (SCR-103) pré-configurado com a transição para `APROVACAO_DFD`, em modo resumido; e envia `POST /api/v1/processes/{id}/forward` (PRC-19) com `If-Match: "<versão do processo>"`, `Idempotency-Key` e `{ transitionId, expectedStageId, comment?, acknowledgedWarnings[], documentIds: [documentId do DFD] }`.
4. A API (US-047 + US-051), em **uma transação**:
   1. bloqueia o processo (`SELECT … FOR UPDATE`), confere `expectedStageId`, custódia e transição;
   2. avalia as regras de saída de `ABERTURA` — a regra `REQUIRED_DOCUMENT` (`DFD`, `minStatus: COMPLETE`) usa o `DfdCompletenessValidator` (US-014); `BLOCKING` → `TRANSITION_BLOCKED`; `WARNING` não reconhecido → `WARNINGS_NOT_ACKNOWLEDGED`;
   3. atribui o número do processo se `numbering.process.assignOn = START`;
   4. encerra a etapa `ABERTURA` e cria a etapa `APROVACAO_DFD`; resolve o aprovador (`DEPARTMENT_HEAD` da secretaria solicitante, com substituto se `allowDeputy`) e cria a `Approval` (`subjectType = PROCESS_STAGE`, `title = "Aprovação da demanda — DFD 0005/2026"`, `requestComment`, `dueAt`);
   5. submete o DFD: cria `DocumentVersion` (`reason = SUBMISSION`, `statusAtCreation = IN_REVIEW`, snapshot pelo `DfdSnapshotBuilder`, `contentHash`), muda o documento para `IN_REVIEW` (`submittedAt`, `submittedById`, `currentVersionId`, `pendingApprovalId`) e grava `ApprovalDocument` com a versão;
   6. muda o processo para `AWAITING_APPROVAL`, grava `ProcessMovement` (`FORWARD`, `documents` com a versão, `metadata.warningsAcknowledged`), concessão `ProcessAccess` `APPROVER`, auditoria, eventos no outbox e timeline;
   7. confirma a transação.
5. A API responde **200**. O front exibe "DFD 0005/2026 enviado para aprovação de Dra. Helena Prado (Titular da Secretaria de Saúde)." e leva ao painel (SCR-006), que mostra "Aguardando aprovação da demanda". SCR-007 passa a modo leitura com a faixa "Em aprovação — versão 1 enviada em 05/10/2026 às 14:40".
6. Assíncrono: a aprovadora (e o substituto) recebem `APPROVAL_REQUESTED` (in-app obrigatória + e-mail).
7. O botão **"Baixar PDF (versão 1)"** solicita a renderização `CONTENT` da versão (DOC-21 → 202), acompanha DOC-22 e baixa por DOC-23. A lista de versões fica em DOC-15.

## Fluxos alternativos
- **FA-01 — Finalizar DFD sem encaminhar:** quando PRC-08 não oferece o encaminhamento (sem `PROCESS_FORWARD`, participante sem custódia ou etapa diferente de `ABERTURA`) e o usuário tem `DFD_SUBMIT` + POL-02, o passo 5 mostra **"Finalizar DFD"**. O front envia DOC-10 (`POST /documents/{documentId}/finalize`) com `If-Match`, `Idempotency-Key` e `{ acknowledgedWarnings[], expectedDraftRevision }`. O DFD vai a `FINALIZED` com versão `FINALIZATION`; o processo não se move e o painel orienta o responsável: "DFD finalizado — encaminhe para aprovação". No encaminhamento posterior, o DFD permanece `FINALIZED` (sem nova versão), recebe `pendingApprovalId` e a `ApprovalDocument` aponta para a versão de finalização.
- **FA-02 — Pendências obrigatórias:** os botões ficam desabilitados com "Há 2 pendências obrigatórias" e a lista com "Ir para o campo". Se a pendência surgir entre a tela e o servidor, PRC-19 responde `TRANSITION_BLOCKED` (violação `WORKFLOW_RULE` "O DFD deve estar completo.") e o front recarrega DOC-08 para detalhar.
- **FA-03 — Alertas:** cada `WARNING` (ex.: `DFD_ATTACHMENTS_PENDING`) exige marcação "Estou ciente"; sem ela, `WARNINGS_NOT_ACKNOWLEDGED`.
- **FA-04 — Aprovador não resolvido:** `APPROVER_UNRESOLVED` (422) → "A Secretaria de Saúde não tem titular cadastrado. Peça ao administrador do órgão para defini-lo." Nada é alterado.
- **FA-05 — Processo alterado por outra pessoa:** `STAGE_CHANGED` (409) ou `VERSION_CONFLICT` (412) → recarrega o painel e informa a nova situação.
- **FA-06 — Numeração na autuação:** com `assignOn = START`, o número do processo é atribuído neste envio e aparece na mensagem de sucesso.
- **FA-07 — DFD devolvido:** após `RETURN` (US-017), o DFD está `RETURNED`; a conclusão repete este fluxo e gera a versão 2 e uma nova `Approval`.
- **FA-08 — Retirar da aprovação:** enquanto a aprovação estiver pendente, quem enviou pode retirá-la (US-053, APV-04): o DFD volta a `DRAFT`.
- **FA-09 — Requisitante é a titular:** se quem envia é a titular da secretaria aprovadora, o passo 5 avisa: "Pela segregação de funções, a decisão caberá ao substituto, Paulo Mendes." A resolução final é de US-051/US-052.
- **FA-10 — Autosave pendente ou com erro:** "Ainda estamos salvando suas alterações…" (até 10 s); em erro, "Não foi possível salvar as últimas alterações. Resolva antes de concluir."
- **FA-11 — PDF ainda não gerado:** a conclusão não depende do PDF; o botão mostra "PDF em geração" até `READY`.

## Regras de negócio
- **RN-DFD-37** — A conclusão sempre revalida a completude **no servidor e dentro da transação** (mesmo validador de US-014); o resultado mostrado na tela é indicativo.
- **RN-DFD-38** — "Concluir e enviar para aprovação" = PRC-19 com a transição `FORWARD` de `ABERTURA` para `APROVACAO_DFD` (transição primária, `isPrimary`); exibida somente quando PRC-08 a retornar ao usuário (POL-01 + `PROCESS_FORWARD` + status editável).
- **RN-DFD-39** — Entrada em etapa APPROVAL que cobre `DFD` (`approvalDocumentTypeCodes`): DFD em `DRAFT`/`RETURNED` → versão `SUBMISSION` + status `IN_REVIEW` + `pendingApprovalId`; DFD `FINALIZED` → sem nova versão, `pendingApprovalId` preenchido. Em ambos os casos `ApprovalDocument` aponta a versão exata (DEC-018/DEC-022) e a interface exibe o selo "Em aprovação".
- **RN-DFD-40** — Snapshot da versão conforme `documentSnapshotSchema`: cabeçalho completo do `Dfd` (valores como string decimal), seções (`state`, `content`, `justification`) e `collections.items` (`processItemId`, `sequence`, `lotNumber`, `description`, `unit`, `quantity`); `contentHash` SHA-256 do JSON canonicalizado (RFC 8785). Anexos não integram o snapshot no MVP 1 (lacuna).
- **RN-DFD-41** — Avisos `WARNING` (do DFD e do workflow) exigem reconhecimento explícito em `acknowledgedWarnings[]`, registrado em `ProcessMovement.metadata.warningsAcknowledged` e em `AuditLog.metadata` (DEC-016).
- **RN-DFD-42** — O comando só é enviado com a fila de autosave vazia; o servidor usa o rascunho persistido no instante do bloqueio — o que não foi salvo não entra na versão.
- **RN-DFD-43** — "Finalizar DFD" (DOC-10) exige `DFD_SUBMIT` + POL-02; leva a `FINALIZED` (versão `FINALIZATION`, `finalizedAt`, `finalizedById`); não move o processo e não propaga dados ao processo, salvo quando o workflow do processo não tiver etapa de aprovação que cubra `DFD` (RN-DFD-61). `expectedDraftRevision` divergente → 412 `VERSION_CONFLICT` ("O DFD foi alterado desde que você o revisou.").
- **RN-DFD-44** — Após submissão ou finalização o DFD é somente leitura (`DOCUMENT_NOT_EDITABLE`); volta a ser editável apenas por devolução (`RETURNED`), retirada da submissão (US-053) ou reabertura (DOC-12, US-017).
- **RN-DFD-45** — "Mensagem ao aprovador" é opcional (até 5.000 caracteres) e é gravada em `ProcessMovement.comment` e `Approval.requestComment`.
- **RN-DFD-46** — PDF: antes da conclusão, apenas `PREVIEW` com marca d'água "RASCUNHO" (US-014); depois, o PDF oficial é a renderização `CONTENT` da versão, sem marca d'água e com o hash no rodapé conforme o layout do template.
- **RN-DFD-47** — Idempotência obrigatória nos dois comandos; reenvio com a mesma chave devolve a mesma resposta; mesma chave com corpo diferente → `IDEMPOTENCY_KEY_REUSED`.
- **RN-DFD-48** — Nova submissão após devolução cria versão com `versionNumber` + 1 e nova `Approval`; a aprovação anterior e sua versão permanecem no histórico.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Transição | `transitionId` | uuid (oculto) | Sim | Transição `FORWARD` `ABERTURA` → `APROVACAO_DFD` | PRC-08 |
| Etapa esperada | `expectedStageId` | uuid (oculto) | Sim | Igual à etapa ativa | Painel |
| Mensagem ao aprovador | `comment` | texto longo | Não | Até 5.000 | — |
| Estou ciente (por alerta) | `acknowledgedWarnings[]` | lista de códigos/ids | Condicional | Todos os `WARNING` | — |
| Documentos enviados | `documentIds[]` | lista | Sim | Contém o DFD | DFD do processo |
| Revisão conferida (finalizar) | `expectedDraftRevision` | inteiro | Sim em DOC-10 | Igual a `draftRevision` | DOC-08 |
| *(sistema)* Versão, hash, aprovação | `DocumentVersion.versionNumber`, `contentHash`, `Approval.id`, `pendingApprovalId` | — | — | RN-DFD-39/40 | Gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Pendência `BLOCKING` no envio | API | "Há pendências obrigatórias no DFD." | `TRANSITION_BLOCKED` |
| V-02 | Pendência `BLOCKING` na finalização | API | "Há pendências obrigatórias no DFD." | `DOCUMENT_INCOMPLETE` |
| V-03 | `WARNING` não reconhecido | Front + API | "Confirme que está ciente dos alertas." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-04 | Etapa mudou | API | "O processo foi movimentado por outra pessoa." | `STAGE_CHANGED` |
| V-05 | Versão do processo/documento divergente | API | "Os dados mudaram desde que você abriu a tela." | `VERSION_CONFLICT` |
| V-06 | Transição indisponível | API | "Esta ação não está disponível na etapa atual." | `TRANSITION_NOT_AVAILABLE` |
| V-07 | Sem custódia | API | "Somente quem está com o processo pode enviá-lo." | `NOT_PROCESS_CUSTODIAN` |
| V-08 | Aprovador não resolvido | API | "A {secretaria} não tem titular cadastrado." | `APPROVER_UNRESOLVED` |
| V-09 | DFD não editável (finalizar) | API | "Este DFD já foi concluído." | `DOCUMENT_NOT_EDITABLE` |
| V-10 | Processo em status impeditivo | API | "O processo está {status}." | `INVALID_PROCESS_STATUS` |
| V-11 | Mensagem acima de 5.000 caracteres | Front + API | "A mensagem pode ter até 5.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-12 | Chave de idempotência reutilizada | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PROCESS_FORWARD` (envio, PRC-19) com custódia; `DFD_SUBMIT` (finalização, DOC-10); `PROCESS_VIEW` para validação, versões e PDF.
- **Políticas:** POL-01 (custódia no envio); POL-02 (finalização: custódia ou participação, documento editável, tipo permitido na etapa); segregação de funções (DEC-022) aplicada na decisão (US-052).
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** os botões não são exibidos; participantes veem a explicação "O envio para aprovação é feito por quem está com o processo (Cláudia Ferreira)."; a API responde 403 e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageChanged` (`ProcessForwarded`) | `process.stage_changed.forward` | Envio | `cause = FORWARD`, `toStage.key = APROVACAO_DFD`, `documentIds` |
| `ProcessStatusChanged` | `process.status_changed.awaiting_approval` | Envio | `DRAFT`/`RETURNED` → `AWAITING_APPROVAL` |
| `ProcessAssigned` | `process.assigned` | Envio, se a etapa de destino atribuir responsável | Conforme US-047 |
| `ProcessNumberAssigned` | `process.number_assigned` | Envio com `assignOn = START` | — |
| `DocumentVersionCreated` | `document.version_created.dfd` | Submissão ou finalização | `reason = SUBMISSION`/`FINALIZATION`, `contentHash` |
| `DocumentSubmitted` | `document.submitted.dfd` | Submissão na entrada da etapa | `approvalId` |
| `ApprovalRequested` | `approval.requested` | Envio | `approverType = DEPARTMENT_HEAD`, `allowDeputy`, `documentVersionIds` |
| `DocumentFinalized` | `document.finalized.dfd` | DOC-10 (FA-01) | Sem `typedSummary` |

Timeline: `PROCESS_FORWARDED`, `DOCUMENT_VERSION_CREATED`, `DOCUMENT_SUBMITTED`/`DOCUMENT_FINALIZED`, `APPROVAL_REQUESTED`.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` | Titular da secretaria solicitante e substituto (se `allowDeputy`) | In-app (obrigatória) + e-mail | Envio |
| `DOCUMENT_RENDER_FAILED` | Quem solicitou o PDF da versão | In-app | Falha após esgotar tentativas |

## Critérios de aceite em Gherkin
```gherkin
Feature: Concluir o DFD e enviá-lo para aprovação

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está na etapa "ABERTURA" com status "DRAFT" e "Cláudia" como responsável
    And o DFD "DFD 0005/2026" está em "DRAFT", completo, com 2 itens
    And a "Secretaria de Saúde" tem a titular "Dra. Helena Prado" e o substituto "Paulo Mendes"
    And a etapa "APROVACAO_DFD" tem prazo de 3 dias úteis e permite decisão do substituto

  Scenario: [Sucesso] Concluir e enviar para aprovação
    When "Cláudia" abrir o passo "Conclusão", escrever a mensagem "Demanda urgente para reposição de estoque" e clicar em "Concluir e enviar para aprovação"
    Then o processo deve ficar "AWAITING_APPROVAL" na etapa "APROVACAO_DFD"
    And o DFD deve ficar "IN_REVIEW" com a versão 1 de motivo "SUBMISSION" e "contentHash" preenchido
    And deve existir uma aprovação "PENDING" do tipo "DEPARTMENT_HEAD" para "Dra. Helena Prado" com substituto permitido, cobrindo a versão 1 do DFD
    And a tramitação "FORWARD" deve registrar o documento na versão 1 e a mensagem informada
    And devem existir na timeline as entradas "PROCESS_FORWARDED", "DOCUMENT_SUBMITTED" e "APPROVAL_REQUESTED"
    And deve gerar registros de auditoria "process.forward", "document.submit", "document.version_create" e "approval.request"
    And devem ser gerados os eventos "ProcessStageChanged", "ProcessStatusChanged", "DocumentVersionCreated", "DocumentSubmitted" e "ApprovalRequested"
    And "Dra. Helena Prado" e "Paulo Mendes" devem receber a notificação "APPROVAL_REQUESTED"
    And o DFD deve abrir em modo leitura com o selo "Em aprovação"

  Scenario: [Sucesso] Finalizar o DFD sem encaminhar e encaminhar depois
    Given que "Marcos" é participante "COLLABORATOR" do processo e possui "DFD_SUBMIT" por perfil
    When "Marcos" clicar em "Finalizar DFD"
    Then o DFD deve ficar "FINALIZED" com a versão 1 de motivo "FINALIZATION"
    And deve ser gerado o evento "DocumentFinalized" com routing key "document.finalized.dfd"
    And o processo deve permanecer na etapa "ABERTURA"
    When "Cláudia" enviar o processo para "APROVACAO_DFD"
    Then o DFD deve permanecer "FINALIZED" com "pendingApprovalId" preenchido e o selo "Em aprovação"
    And a aprovação deve cobrir a versão 1, sem criar nova versão

  Scenario: [Validação] Pendência surgida entre a tela e o servidor
    Given que outra pessoa apagou a justificativa do DFD após "Cláudia" abrir o passo "Conclusão"
    When "Cláudia" clicar em "Concluir e enviar para aprovação"
    Then a API deve responder 422 com código "TRANSITION_BLOCKED" e uma violação "WORKFLOW_RULE" com a mensagem "O DFD deve estar completo."
    And o front deve exibir a pendência "SECTION_REQUIRED" da seção "JUSTIFICATION"
    And nenhuma versão, aprovação ou tramitação deve ser criada

  Scenario: [Validação] Alerta não reconhecido
    Given que o DFD tem 1 anexo em verificação
    When o envio for feito sem reconhecer o alerta "DFD_ATTACHMENTS_PENDING"
    Then a API deve responder 422 com código "WARNINGS_NOT_ACKNOWLEDGED"

  Scenario: [Permissão] Colaborador sem custódia não encaminha
    Given que "Marcos" é participante "COLLABORATOR" do processo
    When "Marcos" abrir o passo "Conclusão"
    Then o botão "Concluir e enviar para aprovação" não deve ser exibido
    When "Marcos" enviar POST para "/api/v1/processes/{id}/forward"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Consultor externo não finaliza
    Given que "Bruno" é participante "CONSULTANT" sem "DFD_SUBMIT"
    When "Bruno" enviar POST para "/api/v1/documents/{documentId}/finalize"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Encaminhar processo de outro tenant
    When "Cláudia" enviar POST para "/api/v1/processes/{id}/forward" com o id de um processo do tenant "Prefeitura de Santa Luzia"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Duplo clique em "Concluir e enviar para aprovação"
    When o envio for repetido com a mesma chave de idempotência "K-ENV-1"
    Then a segunda resposta deve ser a mesma da primeira com o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única aprovação, uma única versão e uma única tramitação

  Scenario: [Duplicidade] Reenvio por outra aba depois do envio
    Given que o processo já está em "APROVACAO_DFD"
    When outra aba enviar o mesmo comando com nova chave e a etapa antiga em "expectedStageId"
    Then a API deve responder 409 com código "STAGE_CHANGED"

  Scenario: [Concorrência] Gravação de seção durante o envio
    When "Bruno" salvar a seção "EXPECTED_RESULTS" no mesmo instante em que "Cláudia" envia o DFD
    Then ou a gravação de "Bruno" entra na versão 1 por ter sido confirmada antes do bloqueio
    Or a gravação de "Bruno" recebe 409 "DOCUMENT_NOT_EDITABLE" por chegar depois
    And o conteúdo da versão 1 deve corresponder exatamente ao seu "contentHash"

  Scenario: [Falha de banco] Falha no meio da transação de envio
    Given que o banco falha ao gravar a aprovação
    When "Cláudia" clicar em "Concluir e enviar para aprovação"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o DFD deve continuar "DRAFT" sem nova versão e o processo deve continuar em "ABERTURA"

  Scenario: [Falha de integração] Serviço de e-mail indisponível
    Given que o SMTP está indisponível
    When "Cláudia" enviar o DFD para aprovação
    Then o envio deve ser concluído e a notificação in-app "APPROVAL_REQUESTED" deve ser criada
    And o e-mail deve ser retentado e, esgotadas as tentativas, a notificação deve registrar "emailStatus" igual a "FAILED"

  Scenario: [Falha de integração] Gotenberg indisponível ao baixar o PDF da versão
    Given que o Gotenberg está indisponível
    When "Cláudia" clicar em "Baixar PDF (versão 1)"
    Then a API deve responder 202 e o botão deve exibir "PDF em geração"
    And o envio para aprovação não deve ser afetado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Regras bloqueantes | 422 | `TRANSITION_BLOCKED` / `DOCUMENT_INCOMPLETE` | "Há pendências obrigatórias no DFD." | Recarrega DOC-08 e lista as pendências |
| Alertas não reconhecidos | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que está ciente dos alertas." | Destaca as caixas "Estou ciente" |
| Etapa alterada | 409 | `STAGE_CHANGED` | "O processo foi movimentado por outra pessoa." | Recarrega o painel |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Os dados mudaram desde que você abriu a tela." | Recarrega e pede nova revisão |
| Aprovador não resolvido | 422 | `APPROVER_UNRESOLVED` | "A {secretaria} não tem titular cadastrado. Fale com o administrador." | Mantém o DFD em edição |
| Sem custódia / sem permissão | 403 | `NOT_PROCESS_CUSTODIAN` / `PERMISSION_DENIED` | "Você não pode enviar este processo." | Mostra quem pode |
| DFD não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este DFD já foi concluído." | Modo leitura |
| Chave reutilizada / em processamento | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Esta solicitação já está sendo processada." | Aguarda e consulta o painel |
| PDF não pronto | 409 | `RENDITION_NOT_READY` | "O PDF ainda está sendo gerado." | Continua consultando DOC-22 |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível enviar agora. Tente novamente em instantes." | Botão "Tentar novamente"; correlationId |

## Dependências
- **Stories:** US-015 (autosave descarregado), US-047 (encaminhar), US-051 (solicitar aprovação e submeter documentos cobertos), US-014 (validador do DFD), US-041 (regras e ações disponíveis), US-065 (DOC-10), US-066 (versões e hash), US-067 (PDF), US-111/US-112 (notificações), US-053 (retirada).
- **Decisões/ADRs:** DEC-013, DEC-015, DEC-016, DEC-018, DEC-022, DEC-023, DEC-028, DEC-060, DEC-084, DEC-105, DEC-161; ADR-005, ADR-006, ADR-007.
- **Configurações:** `numbering.process.assignOn`, `approval.preventSelfApproval`, `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:**
  1. O corpo de DOC-10 (`acknowledgedWarnings[]`, `expectedDraftRevision`) não está em api.md §4 (DEC-016 já exige o reconhecimento "no comando").
  2. `documentSnapshotSchema` não inclui anexos; proposta: `collections.attachments?: Array<{ attachmentId, fileName, sha256, sizeBytes }>` com os anexos `AVAILABLE` no instante da versão.
  3. events.md §4.3 marca `DocumentFinalized` com consumidor N, mas §6 não define `NotificationType` derivado; no DFD nenhuma notificação é emitida na finalização.
  4. PRC-08 não especifica a prévia do aprovador para transições a etapas APPROVAL ("Titular da Secretaria de Saúde"); proposta: `transitions[].approverPreview { type, label }`.

## Impacto técnico
- **Submissor por tipo:** o módulo `dfd` registra `DfdSnapshotBuilder` (porta `TypedSnapshotBuilder`) usada pela submissão genérica de US-051, pela finalização de US-065 e pela reabertura; o mesmo padrão vale para ETP e TR.
- **Transação longa controlada:** envio = tramitação + aprovação + versão + snapshot; o snapshot do DFD é pequeno (3 seções + itens), mas a meta p95 do comando é < 1 s (C2).
- **Ordem de bloqueio:** processo (`FOR UPDATE`) antes do documento, em todos os comandos, para evitar *deadlock* com a reabertura e com o autosave.

## Backend
- **Módulo(s):** `dfd` (snapshot e validador), `process`/`workflow` (US-047), `approval` (US-051), `document` (versões, DOC-10, renditions), `timeline`, `audit`, `platform`.
- **Casos de uso:** `ForwardProcessCommand` (US-047) com `CoveredDocumentSubmitter` (US-051) invocando `DfdSnapshotBuilder`; `FinalizeDocumentCommand` (DOC-10, US-065) com `DfdCompletenessValidator` e `DfdSnapshotBuilder`; `RequestVersionRenditionCommand` (DOC-21).
- **Domínio:** `Dfd.toSnapshotHeader()`; regras RN-DFD-37 a RN-DFD-48.
- **Transação:** passos 4.1–4.7 em uma transação; outbox e timeline na mesma transação.

## Frontend
- **Tela(s):** SCR-007 (passo 5 e modo leitura), SCR-103 (painel de encaminhamento em modo resumido), SCR-006 (painel após envio).
- **Componentes:** `DfdConclusionStep`, `ReadyToSendCard`, `WarningsAcknowledgement`, `ForwardPanel` (US-047) com `preset` da transição, `VersionPdfButton`, `InApprovalBadge` (selo derivado de `pendingApprovalId`).
- **Estados:** botões com carregamento ("Enviando…"); bloqueio durante o descarregamento do autosave; sucesso com redirecionamento; erro com causa e ação.
- **Acessibilidade:** alertas com caixas de seleção rotuladas; mensagem de sucesso anunciada (`role="status"`); foco movido para o painel do processo após o envio.
- **Responsivo:** passo 5 utilizável no celular (consulta e envio), com botões fixos no rodapé.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_stages`, `process_assignments`, `process_movements`, `process_access`, `approvals`, `approval_documents`, `documents`, `document_versions`, `document_renditions`, `number_sequences` (se `START`), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma específica; usa as tabelas de US-047, US-051 e US-066.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_stage_id) WHERE status = 'PENDING' AND subject_type = 'PROCESS_STAGE'`; `UNIQUE (tenant_id, approval_id, document_id)`; `UNIQUE (tenant_id, document_id, version_number)`; trigger de imutabilidade em `document_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-19 | POST | `/api/v1/processes/{id}/forward` | `{ transitionId, expectedStageId, comment?, acknowledgedWarnings[], documentIds[] }` + `If-Match` + `Idempotency-Key` | `200 { data: { process, movement, approval { id, approver } } }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DOC-10 | POST | `/api/v1/documents/{id}/finalize` | `{ acknowledgedWarnings[], expectedDraftRevision }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, version { id, versionNumber, contentHash } } }` | 200, 403, 404, 409, 412, 422 |
| DOC-08 | GET | `/api/v1/documents/{id}/validation` | — | Ver US-014 | 200, 404 |
| PRC-08 | GET | `/api/v1/processes/{id}/available-actions` | — | Transições disponíveis e motivos de indisponibilidade | 200, 404 |
| DOC-15 / DOC-21 / DOC-22 / DOC-23 | GET/POST | Versões e PDF da versão | — | Lista de versões · `202 { renditionId }` · status · `{ url, expiresAt }` | 200, 202, 404, 409 |

## Logs
- `info` `dfd.submitted` — `documentId`, `versionNumber`, `approvalId`, `processId`, `durationMs`.
- `info` `dfd.finalized` — `documentId`, `versionNumber`.
- `warn` `forward.blocked` — `processId`, quantidade de violações por severidade.
- `error` `dfd.submit_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** mensagem ao aprovador, conteúdo do snapshot, valores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.forward` | `WORKFLOW` | Envio | `fromStage`, `toStage`, `warningsAcknowledged`, `idempotencyKey` |
| `document.submit` | `WORKFLOW` | Submissão na entrada da etapa | `documentCode`, `versionNumber`, `approvalId`, `fromStatus`, `toStatus` |
| `document.version_create` | `DATA_CHANGE` | Submissão/finalização | `versionNumber`, `reason`, `contentHash` |
| `approval.request` | `WORKFLOW` | Envio | `approverType`, `approverUserId`, `allowDeputy`, `dueAt` |
| `document.finalize` | `WORKFLOW` | DOC-10 | `versionNumber`, `warningsAcknowledged` |
| `document.render_request` / `document.download` | `DATA_CHANGE` / `EXPORT` | PDF da versão | `renditionId`, `kind = CONTENT` |
| `access.denied` | `ACCESS` | Negativas | `reasonCode` |

## Testes necessários
- **Unitários:** `DfdSnapshotBuilder` (canonicalização e hash estável para o mesmo conteúdo); regras de exibição das ações do passo 5 a partir de PRC-08.
- **Integração (Testcontainers):** envio completo em uma transação (falha induzida após a aprovação → nada persiste); caminho `FINALIZED` → envio sem nova versão; `WARNING` reconhecido gravado no movimento e na auditoria; gravação de seção concorrente com o envio.
- **API/contrato:** PRC-19 e DOC-10 com os erros desta story; `violations[]` com `code = WORKFLOW_RULE`.
- **RBAC e multi-tenant:** custodiante, colaborador com e sem `DFD_SUBMIT`, consultor, gestor; IDs de outro tenant → 404.
- **Concorrência:** duplo clique (idempotência); duas abas; envio × retirada (US-053).
- **E2E (Playwright):** jornada J-02 até "Aguardando aprovação da demanda", incluindo notificação ao aprovador e download do PDF da versão.
- **Acessibilidade/performance:** axe no passo 5; envio p95 < 1 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] Envio e finalização com revalidação no servidor e transação única comprovadas por teste de falha induzida
- [ ] Versão imutável com `contentHash` coberta pela `ApprovalDocument` verificada em teste
- [ ] Auditoria, eventos e notificações verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-19 e DOC-10 compatível com api.md
- [ ] Selo "Em aprovação" exibido a partir de `pendingApprovalId`
- [ ] Logs sem dados sensíveis; métricas de envio e bloqueio
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reutiliza encaminhamento e solicitação de aprovação (US-047/US-051); o trabalho próprio é o passo 5, o snapshot do DFD, a finalização alternativa e os testes ponta a ponta da submissão automática.

## Prioridade
**P0** — sem o envio do DFD para aprovação a demanda não é formalizada e o processo não sai da etapa `ABERTURA` (marco M3 do plano de entrega).
