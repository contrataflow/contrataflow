---
id: US-047
title: "Encaminhar processo"
epic: EP-008
feature: FT-031
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-004, US-041, US-059, US-106]
modules: [process, workflow, approval, document, catalog, organization, identity, access, timeline, audit, notification, platform]
screens: [SCR-006, SCR-103]
endpoints: [PRC-19, PRC-07, PRC-08, PRC-09, DOC-01, DOC-08, DEP-02, USR-02, CAL-06]
permissions: [PROCESS_FORWARD]
events: [ProcessStageChanged, ProcessStatusChanged, ProcessAssigned, ProcessNumberAssigned, DocumentSubmitted, DocumentVersionCreated, ApprovalRequested]
---

# US-047 — Encaminhar processo

## Título
Encaminhar processo

## Descrição
**Como** servidor que detém a custódia do processo (responsável atual ou, sem responsável, membro da unidade atual), **quero** encaminhar o processo para a próxima etapa do workflow escolhendo a unidade de destino quando a etapa permitir, com prazo, comentário e documentos destacados, **para** que o processo avance com destinatário claro, prazo em dias úteis e registro completo e imutável da tramitação.

O encaminhamento é feito no painel lateral SCR-103, aberto pela ação primária do painel situacional (SCR-006). Em **uma transação**, o sistema bloqueia o processo, confere etapa esperada e versão, aplica a custódia, pede ao motor de workflow (US-041) a validação da transição e das regras, encerra a etapa atual, cria a nova etapa com unidade, responsável e prazo, grava o `ProcessMovement` `FORWARD` (origem, destino, usuário, data, hora, comentário, prazo, documentos, IP e metadata), atualiza status e visibilidade, numera o processo quando a autuação ocorre no 1º encaminhamento e, se o destino for etapa `APPROVAL`, submete os documentos cobertos e cria a `Approval` (US-051).

## Contexto
- Hoje o "despacho" é um papel ou e-mail; ninguém sabe com quem está o processo, os prazos não são contados e não há prova de quais documentos seguiram.
- Lei 14.133/2021: atos preferencialmente digitais (art. 12, VI), motivação e segregação de funções (arts. 5º e 7º). O fluxo padrão é o workflow semeado (DEC-015).
- Decisões: status × etapa (DEC-013), motor e runtime (DEC-014), avisos reconhecidos registrados (DEC-016), submissão automática na entrada em etapa APPROVAL (DEC-018), aprovação genérica (DEC-022), custódia (DEC-023), visibilidade (DEC-024), numeração na autuação (DEC-028), prazos (DEC-031), bloqueio pessimista na tramitação (DEC-055), `If-Match`/idempotência (DEC-104/105), outbox e nomes especializados (DEC-161/162).
- É a story-núcleo da tramitação: o serviço de mudança de etapa criado aqui (`StageTransitionService`) é reutilizado por US-016 ("Concluir e enviar para aprovação" do DFD), US-048 (devolução), US-052 (decisão) e US-010 (conclusão).

## Objetivo
Encaminhar em até 3 cliques a partir do painel (transição primária pré-selecionada), com p95 < 1 s na API, 100% dos encaminhamentos com `ProcessMovement` completo e gravado atomicamente com etapa, visibilidade, timeline, auditoria e eventos, e nenhuma tramitação duplicada ou perdida sob concorrência.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`) ao enviar a demanda; Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`) entre etapas.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); demais perfis com `PROCESS_FORWARD` (`LICITACOES`, `CONTABILIDADE`, `JURIDICO`, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE`, `GESTOR_CONTRATO`); destinatários na unidade de destino.

## Pré-condições
- Processo visível ao usuário, com etapa ativa e status `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Usuário com `PROCESS_FORWARD` em escopo que cubra o processo e com custódia (POL-01).
- Versão de workflow publicada com ao menos uma transição `FORWARD` a partir da etapa atual (US-040, US-041).
- Calendário de dias úteis (US-106), numeração (US-105) e resolução de aprovador (US-051) disponíveis.

## Fluxo principal
1. No SCR-006 o usuário aciona **"Encaminhar"** (ação primária do painel situacional, exibida conforme `PRC-08`).
2. O sistema abre o painel SCR-103 e carrega em paralelo: `PRC-08` (transições `FORWARD` com disponibilidade e motivos, etapa e unidade de destino, `departmentResolution`, `requiresComment`, `allowDueDateOverride`, prazo calculado e prévia do aprovador), `PRC-09` (pendências `BLOCKING` e avisos `WARNING` por transição) e `DOC-01` (documentos). Exibe skeleton até os dados chegarem.
3. **Para onde:** lista as transições disponíveis (nome, etapa e unidade de destino); a transição `isPrimary` vem selecionada; as indisponíveis aparecem desabilitadas com o motivo.
4. **Unidade e responsável:** se a etapa destino for `CHOSEN_ON_FORWARD`, o usuário escolhe a unidade (`DEP-02`, unidades ativas do órgão do processo; padrão = última unidade que executou a etapa, se houver); senão a unidade aparece somente para leitura. Opcionalmente escolhe **"Atribuir diretamente a"** (`USR-02`, pessoas lotadas na unidade de destino) — campo oculto quando o destino é etapa `APPROVAL`.
5. **Prazo:** mostra "Até 20/10/2026 (10 dias úteis)" ou "Sem prazo definido". Se a transição permitir, **"Alterar prazo"** abre data + motivo obrigatório.
6. **Comentário:** campo de texto (obrigatório quando a transição exigir), com contador de 5.000 caracteres.
7. **Documentos:** lista os documentos do processo; vêm marcados os criados ou alterados durante a etapa atual. No destino `APPROVAL`, os documentos cobertos aparecem travados como "Será submetido para aprovação", com a situação de completude (`DOC-08`).
8. **Pendências e avisos:** pendências `BLOCKING` aparecem com link "Resolver" e mantêm o botão desabilitado; cada aviso `WARNING` exige marcar "Estou ciente e desejo prosseguir".
9. **Resumo:** "O processo irá para **Pesquisa de preços — Departamento de Compras**, na fila da unidade, com prazo até **20/10/2026**." (ou "…para aprovação de **Carlos Lima (titular da Secretaria de Obras)**; o DFD será submetido na versão 2").
10. O usuário clica em **"Encaminhar"**. O front envia `POST /api/v1/processes/{id}/forward` com `If-Match` (versão do processo), `Idempotency-Key` (gerada por tentativa com corpo distinto) e o corpo; o botão exibe "Encaminhando…".
11. A API, em **uma transação** com `app.tenant_id` definido:
    1. valida o corpo (`forwardProcessSchema`);
    2. executa `SELECT … FOR UPDATE` no processo aplicando o predicado de visibilidade (não visível → 404);
    3. compara `expectedStageId` com `currentStageId` (→ 409 `STAGE_CHANGED`) e depois `If-Match` com `version` (→ 412);
    4. autoriza `PROCESS_FORWARD` no escopo + POL-01 (custódia e status);
    5. chama `WorkflowFacade.evaluateTransition` (US-041): transição da versão do processo, partindo da etapa atual, ação `FORWARD`; regras `STAGE_EXIT` da etapa atual e `TRANSITION` da transição; `BLOCKING` → 422 `TRANSITION_BLOCKED`; `WARNING` não reconhecido → 422 `WARNINGS_NOT_ACKNOWLEDGED`;
    6. resolve unidade e responsável de destino e valida `toDepartmentId`/`toUserId`;
    7. calcula `dueAt` (US-055) ou valida a sobrescrita;
    8. encerra a etapa atual (`COMPLETED`) e a atribuição ativa;
    9. se `number` for nulo e `numbering.process.assignOn = START`, numera o processo (US-105);
    10. cria `ProcessStage` (ACTIVE), `ProcessAssignment` (`STAGE_ENTRY`) e `ProcessMovement` (`FORWARD`);
    11. atualiza o processo (status, campos `current*`, `overdueSince = null`, `version + 1`);
    12. atualiza `ProcessAccess` (CURRENT → HISTORICAL, novo CURRENT, RESPONSIBLE);
    13. se o destino for `APPROVAL`, chama `ApprovalFacade.requestForStage` (US-051): submete documentos cobertos, cria `Approval` e `ApprovalDocument`;
    14. grava timeline (projetor síncrono), auditoria e eventos no outbox;
    15. confirma a transação.
12. A API responde **200** com o processo atualizado e `ETag` novo. O front invalida processo, resumo, tramitações, timeline, contadores da caixa e dashboard, fecha o painel, exibe o toast "Processo encaminhado para Pesquisa de preços — Departamento de Compras" e move o foco para o cabeçalho de status (agora sem ações de custódia).

## Fluxos alternativos
- **FA-01 — Destino de aprovação:** status vira `AWAITING_APPROVAL`; documentos cobertos em `DRAFT`/`RETURNED` são validados e submetidos (`IN_REVIEW`, nova versão); os `FINALIZED`/`APPROVED` ficam com `pendingApprovalId` (selo "Em aprovação" — DEC-018). Notifica `APPROVAL_REQUESTED` em vez de `PROCESS_RECEIVED`.
- **FA-02 — Unidade escolhida no encaminhamento:** sem unidade → 422 `DEPARTMENT_REQUIRED`; unidade inativa ou de outro órgão → 422 `VALIDATION_ERROR` no campo.
- **FA-03 — Atribuição direta:** com `toUserId` elegível, a nova etapa já nasce com responsável e só ele recebe `PROCESS_RECEIVED`.
- **FA-04 — Prazo alterado:** permitido só se `allowDueDateOverride`; grava `dueDateOverridden` e o motivo; o prazo calculado fica em `metadata.computedDueAt`.
- **FA-05 — Avisos reconhecidos:** se a API responder `WARNINGS_NOT_ACKNOWLEDGED` (regras mudaram após a carga do painel), o painel recarrega `PRC-09`, mostra os avisos com caixa de seleção e o reenvio usa **nova** `Idempotency-Key`.
- **FA-06 — Pendências bloqueantes surgidas após a carga:** `TRANSITION_BLOCKED` lista as violações com links para resolver; nada é gravado.
- **FA-07 — Autuação no 1º encaminhamento:** com `assignOn = START`, o processo recebe número e `openedAt`; o toast informa "Processo autuado sob o nº 0012/2026 e encaminhado…".
- **FA-08 — Outro usuário tramitou antes:** `STAGE_CHANGED` abre o diálogo "Este processo acabou de ser movimentado por {nome}. Recarregue para ver a situação atual." e fecha o painel.
- **FA-09 — Reenvio após falha de rede:** mesma `Idempotency-Key` e mesmo corpo → resposta original (`Idempotent-Replayed: true`), sem segundo movimento.
- **FA-10 — Responsável da política inelegível:** se o candidato da `assignmentPolicy` não tiver vínculo ativo ou lotação na unidade de destino, o processo vai para a fila da unidade, sem erro; o resumo informa "na fila da unidade".
- **FA-11 — Documento coberto incompleto:** 422 `DOCUMENT_INCOMPLETE` com `violations[]` por documento; o painel mostra "Complete o DFD antes de enviar" com link para o editor.
- **FA-12 — Aprovador não resolvido:** 422 `APPROVER_UNRESOLVED` ("A Secretaria de Obras não tem titular apto a decidir. Fale com o administrador do órgão."); nada é gravado.
- **FA-13 — Orçamento sigiloso:** resumo, snapshot, timeline e notificações não contêm valores (POL-09).

## Regras de negócio
- **RN-TRAM-01** — Só encaminha quem tem `PROCESS_FORWARD` em escopo que cubra o processo **e** custódia (POL-01): é o `currentResponsibleId` ou, se não houver responsável, está lotado na `currentDepartmentId`. Participantes nunca encaminham (DEC-036); gestores sem custódia devem primeiro se atribuir (US-050).
- **RN-TRAM-02** — Status permitidos: `DRAFT`, `IN_PROGRESS`, `RETURNED`. Em `AWAITING_APPROVAL`, `SUSPENDED`, `CANCELED`, `COMPLETED` ou `PUBLISHED` → 409 `INVALID_PROCESS_STATUS`.
- **RN-TRAM-03** — Concorrência: `SELECT … FOR UPDATE` no processo; `expectedStageId` diferente de `currentStageId` → `STAGE_CHANGED` (verificado antes do `If-Match`); `If-Match` divergente → `VERSION_CONFLICT`; ausente → `PRECONDITION_REQUIRED`.
- **RN-TRAM-04** — A transição deve pertencer à `workflowVersionId` do processo, partir da etapa atual e ter ação `FORWARD`. `RETURN` usa PRC-20, `COMPLETE` usa PRC-26 e `APPROVE`/`REJECT` só ocorrem por decisão (US-052). Caso contrário → 422 `TRANSITION_NOT_AVAILABLE`.
- **RN-TRAM-05** — Regras avaliadas pelo motor sobre o `RuleContext` v1: `STAGE_EXIT` da etapa atual + `TRANSITION` da transição escolhida. Havendo `BLOCKING` não satisfeita → `TRANSITION_BLOCKED` com **todas** as violações (inclusive avisos) em `violations[]` no formato canônico (api.md §2.1.2, `code = "WORKFLOW_RULE"`, `ruleId`, `severity`, `message`).
- **RN-TRAM-06** — Toda regra `WARNING` não satisfeita deve constar em `acknowledgedWarnings[]`; senão → `WARNINGS_NOT_ACKNOWLEDGED`. Ids extras são ignorados. Os avisos reconhecidos são gravados com id e mensagem em `ProcessMovement.metadata.warningsAcknowledged` e em `AuditLog.metadata.warningsAcknowledged` (DEC-016).
- **RN-TRAM-07** — Unidade de destino conforme `departmentResolution` da etapa destino: `FIXED` → `fixedDepartmentId`; `REQUESTING_DEPARTMENT` → `requestingDepartmentId`; `REQUESTING_SECRETARIAT` → `requestingSecretariatId`; `CHOSEN_ON_FORWARD` → `toDepartmentId` obrigatório (`DEPARTMENT_REQUIRED`), unidade ativa do mesmo órgão. Nas demais resoluções, `toDepartmentId` enviado deve coincidir com o resolvido (senão `VALIDATION_ERROR`/`NOT_ALLOWED`). Unidade resolvida inativa → `TRANSITION_NOT_AVAILABLE` ("unidade de destino inativa").
- **RN-TRAM-08** — `toUserId`, quando informado, exige vínculo `ACTIVE` não expirado, lotação na unidade de destino e `PROCESS_VIEW` (senão 422 `ASSIGNEE_NOT_ELIGIBLE`) e não é aceito em destino `APPROVAL` (`VALIDATION_ERROR`/`NOT_ALLOWED`). Sem `toUserId`, aplica a `assignmentPolicy`: `UNASSIGNED` → fila; `CREATOR` → criador; `DEPARTMENT_HEAD` → titular da unidade de destino; `PREVIOUS_ASSIGNEE` → responsável da última passagem pela mesma etapa. Candidato inelegível → fila da unidade, sem erro.
- **RN-TRAM-09** — Prazo: com `slaDays`, `dueAt` = fim do dia (23:59:59 no fuso do tenant) do N-ésimo dia útil (`BUSINESS`) ou corrido (`CALENDAR`) contado a partir do dia seguinte à entrada, pelas regras de US-055; `slaDays`/`slaType` são copiados para a etapa. Sem SLA e sem sobrescrita → sem prazo.
- **RN-TRAM-10** — Sobrescrita de prazo só com `allowDueDateOverride = true` (senão `DUE_DATE_OVERRIDE_NOT_ALLOWED`); data entre hoje e hoje + 365 dias, normalizada ao fim do dia; `dueDateOverrideReason` obrigatório (10–1.000 caracteres); grava `dueDateOverridden = true`.
- **RN-TRAM-11** — Comentário até 5.000 caracteres; obrigatório (mín. 10) quando `requiresComment = true`.
- **RN-TRAM-12** — `documentIds[]` (máx. 50, sem repetição) devem ser do processo e não excluídos. Omitido = documentos criados ou alterados durante a passagem atual (versão criada ou rascunho salvo após `enteredAt`). Em destino `APPROVAL`, os documentos cobertos entram automaticamente. O snapshot segue `MovementDocumentRef` (entities.md §5.6) com status e versão **após** os efeitos do encaminhamento.
- **RN-TRAM-13** — Status (DEC-013): destino `APPROVAL` → `AWAITING_APPROVAL`; destino `TASK`/`START` → `IN_PROGRESS`. Só há `ProcessStatusChanged` quando o status muda.
- **RN-TRAM-14** — Encerra a etapa atual (`COMPLETED`, `exitedAt`, `exitedViaMovementId`) e a atribuição ativa (`endedAt`, `isActive = false`); cria `ProcessStage` (`sequence + 1`, ACTIVE, com `enteredViaMovementId`) e `ProcessAssignment` `STAGE_ENTRY` (`assignedById` = ator somente quando houver `toUserId`). Uma única etapa ativa por processo.
- **RN-TRAM-15** — `ProcessMovement` `FORWARD` imutável com: `sequence + 1`, transição, etapas, unidades e usuários de origem e destino, `statusFrom`/`statusTo`, `actorType = USER`, `actorId`, `actorDepartmentId` (unidade atual), comentário, `dueAt`, documentos, `ip`, `userAgent`, `correlationId`, `occurredAt` e `metadata` (`warningsAcknowledged`, `computedDueAt`, `dueDateOverridden`, `approvalRequestedId`, `labels` com nomes congelados de etapas, unidades e pessoas, `clientChannel`).
- **RN-TRAM-16** — O processo passa a refletir a nova etapa: `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`; `overdueSince = null`; `version + 1`.
- **RN-TRAM-17** — Visibilidade (DEC-024), na mesma transação: `CURRENT` da unidade de origem vira `HISTORICAL` (quando a unidade muda); `CURRENT` para a unidade de destino; `USER/RESPONSIBLE` para o novo responsável.
- **RN-TRAM-18** — Autuação: com `numbering.process.assignOn = START` e `number` nulo, atribui número e código pela máscara e escopo vigentes (ano corrente), `openedAt = now`, evento `ProcessNumberAssigned` e auditoria `process.number_assign`.
- **RN-TRAM-19** — Destino `APPROVAL`: submissão automática e criação da aprovação seguem US-051 na mesma transação; `DOCUMENT_INCOMPLETE` ou `APPROVER_UNRESOLVED` desfazem o encaminhamento inteiro.
- **RN-TRAM-20** — Notificação: destino `TASK`/`START` → `PROCESS_RECEIVED` ao responsável ou, sem responsável, aos lotados na unidade de destino com `PROCESS_CLAIM`; destino `APPROVAL` → `APPROVAL_REQUESTED` (US-051). Nunca ao próprio ator.
- **RN-TRAM-21** — Atomicidade: etapa, atribuição, movimento, número, versões, aprovação, acessos, timeline, auditoria e outbox são gravados juntos ou nada é gravado.
- **RN-TRAM-22** — Orçamento sigiloso: nenhum valor estimado entra em payload, snapshot, timeline, notificação ou log (POL-09).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Para onde | `transitionId` | seleção (rádio) | Sim | RN-TRAM-04 | transição `isPrimary` |
| *(técnico)* Etapa esperada | `expectedStageId` | uuid | Sim | = `currentStageId` | carregado com o processo |
| Unidade de destino | `toDepartmentId` | seleção em árvore | Condicional (`CHOSEN_ON_FORWARD`) | RN-TRAM-07 | última unidade que executou a etapa |
| Atribuir diretamente a | `toUserId` | seleção de pessoa | Não | RN-TRAM-08 | — |
| Prazo | `dueAt` | data | Não | RN-TRAM-10 | calculado (RN-TRAM-09) |
| Motivo da alteração do prazo | `dueDateOverrideReason` | texto | Condicional | 10–1.000 | — |
| Comentário | `comment` | texto longo | Condicional | RN-TRAM-11 | — |
| Documentos que acompanham | `documentIds` | lista de uuid | Não | RN-TRAM-12 | alterados na etapa |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de uuid (regras) | Condicional | RN-TRAM-06 | — |
| *(cabeçalhos)* | `If-Match`, `Idempotency-Key` | texto | Sim | DEC-104/105 | front |
| *(sistema)* Registro da tramitação | `ip`, `userAgent`, `correlationId`, `occurredAt`, `metadata` | — | — | RN-TRAM-15 | contexto da requisição |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `transitionId` e `expectedStageId` presentes e UUID | Front + API (Zod) | "Selecione para onde o processo vai." | `VALIDATION_ERROR` |
| V-02 | Comentário > 5.000 ou ausente quando exigido | Front + API | "Informe um comentário (mín. 10 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_LONG`) |
| V-03 | Mais de 50 documentos ou repetidos | Front + API | "Selecione até 50 documentos, sem repetição." | `VALIDATION_ERROR` (`TOO_LONG`/`DUPLICATE_IN_LIST`) |
| V-04 | Documento de outro processo, excluído ou de outro tenant | API | "Um dos documentos selecionados não está disponível." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Etapa atual diferente da esperada | API | "O processo acabou de ser movimentado por outra pessoa." | `STAGE_CHANGED` |
| V-06 | Versão divergente | API | "O processo foi alterado. Recarregue para continuar." | `VERSION_CONFLICT` |
| V-07 | Transição inexistente, de outra etapa ou não `FORWARD` | API | "Este caminho não está disponível para a etapa atual." | `TRANSITION_NOT_AVAILABLE` |
| V-08 | Regra `BLOCKING` violada | API | "Há {n} pendências obrigatórias na etapa." | `TRANSITION_BLOCKED` |
| V-09 | Aviso não reconhecido | API | "Confirme que está ciente dos avisos antes de encaminhar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-10 | Unidade ausente em `CHOSEN_ON_FORWARD` | Front + API | "Escolha a unidade de destino." | `DEPARTMENT_REQUIRED` |
| V-11 | Unidade inativa, de outro órgão ou de outro tenant | API | "Selecione uma unidade de destino válida." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`/`REFERENCE_NOT_FOUND`) |
| V-12 | Pessoa não lotada na unidade de destino ou sem vínculo ativo | API | "Esta pessoa não pode receber o processo nesta unidade." | `ASSIGNEE_NOT_ELIGIBLE` |
| V-13 | Prazo alterado sem permissão da transição | API | "Esta etapa não permite alterar o prazo." | `DUE_DATE_OVERRIDE_NOT_ALLOWED` |
| V-14 | Prazo no passado, além de 365 dias ou sem motivo | Front + API | "Informe uma data entre hoje e {limite} e o motivo da alteração." | `VALIDATION_ERROR` (`DATE_IN_PAST`/`OUT_OF_RANGE`/`CONDITIONAL_REQUIRED`) |
| V-15 | Documento coberto incompleto (destino `APPROVAL`) | API | "Complete o {documento} antes de enviar para aprovação." | `DOCUMENT_INCOMPLETE` |
| V-16 | Aprovador não resolvido | API | "Não há aprovador apto para esta etapa. Fale com o administrador do órgão." | `APPROVER_UNRESOLVED` |
| V-17 | Mesma `Idempotency-Key` com outro corpo | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PROCESS_FORWARD` (risco M) com escopo que cubra o processo (permissions.md §1.1).
- **Políticas:** POL-01 (custódia e status). A decisão de aprovação não faz parte desta story (POL-03, US-052).
- **MFA:** não exigido, salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `PROCESS_FORWARD` o botão não é exibido; com a permissão mas sem custódia, o botão aparece desabilitado com o motivo de `PRC-08` ("O processo está com o Departamento de Compras"). A API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageChanged` (`ProcessForwarded`) | `process.stage_changed.forward` | Sempre | `cause = FORWARD`, `movementId`, etapas, unidades, `toUserId`, `dueAt`, `documentIds`; `approvalId` quando o destino é `APPROVAL` |
| `ProcessStatusChanged` | `process.status_changed.in_progress` / `.awaiting_approval` | Quando o status muda | `cause = FORWARD` |
| `ProcessAssigned` | `process.assigned` | Nova etapa com responsável | `assignmentType = STAGE_ENTRY` |
| `ProcessNumberAssigned` | `process.number_assigned` | Autuação no 1º encaminhamento | `number`, `year`, `code` |
| `DocumentVersionCreated`, `DocumentSubmitted` | `document.version_created.<tipo>`, `document.submitted.<tipo>` | Documento coberto submetido (US-051) | Um par por documento |
| `ApprovalRequested` | `approval.requested` | Destino `APPROVAL` (US-051) | — |

Projeções síncronas: timeline `PROCESS_FORWARDED` (e `PROCESS_NUMBER_ASSIGNED`, `DOCUMENT_SUBMITTED`, `DOCUMENT_VERSION_CREATED`, `APPROVAL_REQUESTED` quando aplicáveis) e `ProcessAccess`.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_RECEIVED` | `toUserId`/responsável da política; sem responsável, lotados na unidade de destino com `PROCESS_CLAIM` | In-app + e-mail | Destino `TASK`/`START` |
| `APPROVAL_REQUESTED` | Aprovador resolvido (US-051) | In-app (obrigatória) + e-mail | Destino `APPROVAL` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Encaminhar processo

  Background:
    Given o tenant "Prefeitura de São José" ativo, com fuso "America/Sao_Paulo" e o feriado nacional de 12/10/2026
    And o workflow padrão publicado, com a etapa "PESQUISA_PRECOS" na unidade fixa "Departamento de Compras", SLA de 10 dias úteis e política "UNASSIGNED"
    And o processo "0012/2026" na etapa "ESTUDOS_PRELIMINARES" da "Coordenadoria de Planejamento", status "IN_PROGRESS", versão 14
    And "Paula" (PLANEJAMENTO) é a responsável e "Rui" e "Lia" (COMPRAS) são lotados no "Departamento de Compras"

  Scenario: [Sucesso] Encaminhar para etapa de tarefa com registro completo
    Given o ETP "finalizado" e o mapa de riscos existente
    When "Paula" encaminhar em 05/10/2026 pela transição "Encaminhar para pesquisa de preços" com o comentário "ETP concluído; seguem ETP e mapa de riscos"
    Then o processo deve ficar "IN_PROGRESS" na etapa "PESQUISA_PRECOS" do "Departamento de Compras" sem responsável
    And o prazo da etapa deve ser 20/10/2026 às 23:59:59 no fuso do tenant, desconsiderando fins de semana e o feriado de 12/10
    And deve existir uma tramitação "FORWARD" com origem, destino, usuário "Paula", data, hora, comentário, prazo, os documentos ETP e mapa de riscos com versão, IP, user-agent e correlationId
    And a unidade "Coordenadoria de Planejamento" deve manter acesso "HISTORICAL" e o "Departamento de Compras" receber acesso "CURRENT"
    And deve existir a entrada "PROCESS_FORWARDED" na timeline e o registro de auditoria "process.forward"
    And deve ser gerado o evento "ProcessStageChanged" com routing key "process.stage_changed.forward"
    And "Rui" e "Lia" devem receber a notificação "PROCESS_RECEIVED"
    And a API deve responder 200 com "ETag" igual a "15"

  Scenario: [Sucesso] Encaminhar para aprovação submete o DFD automaticamente
    Given o processo "0013/2026" em "DRAFT" na etapa "ABERTURA" sob custódia de "Ana", com DFD completo em "DRAFT"
    And "Carlos" é o titular da "Secretaria de Obras"
    When "Ana" encaminhar pela transição "Enviar para aprovação da demanda"
    Then o DFD deve ficar "IN_REVIEW" com a versão 1 de motivo "SUBMISSION" e hash SHA-256
    And deve existir uma aprovação "PENDING" com aprovador "Carlos" cobrindo exatamente a versão 1 do DFD
    And o processo deve ficar "AWAITING_APPROVAL" na etapa "APROVACAO_DFD"
    And "Carlos" deve receber "APPROVAL_REQUESTED" e ninguém deve receber "PROCESS_RECEIVED"

  Scenario: [Sucesso] Autuação no primeiro encaminhamento
    Given a configuração "numbering.process.assignOn" igual a "START" e o processo sem número em "DRAFT"
    And o último número de processo de 2026 é 11
    When o processo for encaminhado pela primeira vez
    Then ele deve receber o código "0012/2026" e "openedAt" preenchido
    And deve gerar o evento "ProcessNumberAssigned" e a auditoria "process.number_assign"

  Scenario: [Validação] Etapa com unidade escolhida no encaminhamento sem unidade
    Given que a etapa destino usa "CHOSEN_ON_FORWARD"
    When "Paula" encaminhar sem informar "toDepartmentId"
    Then a API deve responder 422 com código "DEPARTMENT_REQUIRED"
    And nenhuma etapa, tramitação ou evento deve ser gravado

  Scenario: [Validação] Pendência obrigatória impede o encaminhamento
    Given que o ETP não está completo
    When "Paula" tentar encaminhar para "PESQUISA_PRECOS"
    Then a API deve responder 422 com código "TRANSITION_BLOCKED"
    And "violations" deve conter "O ETP deve estar completo." com "code" "WORKFLOW_RULE" e "severity" "BLOCKING"

  Scenario: [Validação] Aviso precisa ser reconhecido e fica registrado
    Given que a regra de aviso "Recomenda-se elaborar o mapa de riscos." não está satisfeita
    When "Paula" encaminhar sem reconhecer o aviso
    Then a API deve responder 422 com código "WARNINGS_NOT_ACKNOWLEDGED"
    When "Paula" encaminhar informando o id da regra em "acknowledgedWarnings"
    Then o encaminhamento deve ser concluído
    And "metadata.warningsAcknowledged" da tramitação e da auditoria deve conter o id e a mensagem da regra

  Scenario: [Validação] Prazo alterado sem autorização da transição
    Given que a transição tem "allowDueDateOverride" falso
    When "Paula" encaminhar com "dueAt" igual a 30/10/2026 e motivo "Volume alto de itens"
    Then a API deve responder 422 com código "DUE_DATE_OVERRIDE_NOT_ALLOWED"

  Scenario: [Validação] Atribuição direta a pessoa não lotada no destino
    When "Paula" encaminhar com "toUserId" de "Bruno", lotado na "Secretaria de Saúde"
    Then a API deve responder 422 com código "ASSIGNEE_NOT_ELIGIBLE"

  Scenario: [Permissão] Usuário sem custódia
    Given "Marcos" (PLANEJAMENTO) lotado na "Coordenadoria de Planejamento", sem ser o responsável
    When "Marcos" abrir o processo
    Then o botão "Encaminhar" deve aparecer desabilitado com o motivo "O processo está com Paula"
    When "Marcos" enviar POST para "/api/v1/processes/{id}/forward"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN" e registrar "access.denied"

  Scenario: [Permissão] Processo suspenso não pode ser encaminhado
    Given o processo com status "SUSPENDED"
    When "Paula" tentar encaminhar
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"

  Scenario: [Tenant incorreto] Processo e unidade de outro tenant
    When "Paula" enviar o encaminhamento para o id de um processo do tenant "Prefeitura B"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    When "Paula" informar "toDepartmentId" de uma unidade do tenant "Prefeitura B"
    Then a API deve responder 422 com "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "toDepartmentId"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Paula" encaminhou com a chave "K7" e recebeu 200
    When a mesma requisição for reenviada com a chave "K7"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única tramitação "FORWARD" e uma única etapa ativa

  Scenario: [Concorrência] Dois custodiantes encaminham ao mesmo tempo
    Given o processo na fila da "Coordenadoria de Planejamento" sem responsável, visto por "Paula" e "Marcos"
    When ambos encaminharem simultaneamente com o mesmo "expectedStageId"
    Then exatamente um encaminhamento deve ser aceito com 200
    And o outro deve receber 409 com código "STAGE_CHANGED"
    And o processo deve ter exatamente uma etapa ativa e uma nova tramitação

  Scenario: [Concorrência] Versão desatualizada
    Given que o processo foi editado por outra pessoa após "Paula" abrir o painel
    When "Paula" encaminhar com "If-Match" igual a "14"
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante o encaminhamento
    Given que o banco fica indisponível após a criação da nova etapa
    When "Paula" encaminhar
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a etapa, a tramitação, o número, as versões de documento, a aprovação, a timeline, a auditoria e os eventos não devem ser persistidos

  Scenario: [Falha de integração] Relay do outbox e e-mail indisponíveis
    Given que o relay do outbox e o servidor SMTP estão indisponíveis
    When "Paula" encaminhar com sucesso
    Then a API deve responder 200 e os eventos devem ficar "PENDING" no outbox
    And quando o relay voltar, "Rui" e "Lia" devem receber "PROCESS_RECEIVED" uma única vez, com o e-mail reenviado pela fila "email"

  Scenario: [Falha de integração] Redis indisponível para idempotência
    Given que o Redis está indisponível
    When "Paula" encaminhar com chave de idempotência
    Then o encaminhamento deve ser concluído e registrar log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; foca o primeiro erro |
| Processo inexistente, de outro tenant ou não visível | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | SCR-111 404 |
| Sem permissão / sem custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Fecha o painel; recarrega ações |
| Status não permite | 409 | `INVALID_PROCESS_STATUS` | "O processo está {status} e não pode ser encaminhado." | Recarrega o painel situacional |
| Outro usuário tramitou | 409 | `STAGE_CHANGED` | "O processo acabou de ser movimentado por outra pessoa." | Diálogo com "Recarregar" |
| Versão divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O processo foi alterado. Recarregue para continuar." | Recarrega mantendo o comentário digitado |
| Transição indisponível | 422 | `TRANSITION_NOT_AVAILABLE` | "Este caminho não está disponível agora." | Recarrega `PRC-08` |
| Pendências / avisos | 422 | `TRANSITION_BLOCKED` / `WARNINGS_NOT_ACKNOWLEDGED` | "Há pendências na etapa." | Lista violações com links "Resolver" ou caixas "Estou ciente" |
| Unidade ausente | 422 | `DEPARTMENT_REQUIRED` | "Escolha a unidade de destino." | Foca o campo |
| Prazo não alterável | 422 | `DUE_DATE_OVERRIDE_NOT_ALLOWED` | "Esta etapa não permite alterar o prazo." | Restaura o prazo calculado |
| Pessoa inelegível | 422 | `ASSIGNEE_NOT_ELIGIBLE` | "Esta pessoa não pode receber o processo nesta unidade." | Limpa o campo |
| Documento coberto incompleto | 422 | `DOCUMENT_INCOMPLETE` | "Complete o {documento} antes de enviar." | Lista pendências por documento com link ao editor |
| Aprovador não resolvido | 422 | `APPROVER_UNRESOLVED` | "Não há aprovador apto para esta etapa." | Mantém o painel; orienta contato com o administrador |
| Requisição em processamento / chave reutilizada | 409 / 422 | `IDEMPOTENCY_IN_PROGRESS` / `IDEMPOTENCY_KEY_REUSED` | "Estamos concluindo o encaminhamento." / "Esta solicitação já foi enviada com outros dados." | Aguarda 2 s e consulta / gera nova chave |
| Dependência indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível encaminhar agora. Tente novamente em instantes." | Mantém dados; "Tentar novamente"; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados |

## Dependências
- **Stories:** US-004 (painel situacional e `PRC-07`), US-041 (motor: transições, regras, `PRC-08`/`PRC-09`), US-059 (timeline), US-106 (calendário); US-051 (aprovação no destino `APPROVAL`), US-055 (cálculo de prazo), US-065/US-066 (submissão e versões), US-105 (numeração), US-097 (autorização), US-111/US-112 (entrega das notificações).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-015, DEC-016, DEC-018, DEC-022, DEC-023, DEC-024, DEC-028, DEC-031, DEC-055, DEC-104, DEC-105, DEC-161, DEC-162; ADR-004, ADR-005.
- **Configurações:** `numbering.process.assignOn`, `numbering.process.mask`, `numbering.process.scope`, `calendar.optionalHolidaysAreNonBusiness`, `access.historicalDepartmentsCanView`, `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:**
  1. ~~Schema de `ProcessMovement.metadata`~~ — resolvida: `MovementMetadata` em entities.md §5.6.
  2. (para api.md §4, tarefas D09–D11) O contrato de `PRC-08` precisa expor, por transição, `departmentResolution`, `requiresComment`, `allowDueDateOverride`, `dueAtPreview`, `approverPreview` e motivos de indisponibilidade (api.md §4, dono US-041/US-004).
  3. Unidade de destino configurada inativa → `TRANSITION_NOT_AVAILABLE` com `detail` explicativo (aceita, sem código novo).
  4. ~~J-08 × events.md~~ — resolvida: J-08 alinhada a events.md §6 (`PROCESS_RECEIVED` para lotados com `PROCESS_CLAIM`).

## Impacto técnico
- Cria o `StageTransitionService` (encerrar etapa, resolver destino, criar etapa/atribuição/movimento, atualizar desnormalizações e acessos), reutilizado por devolução, decisão, retirada e conclusão. Ordem de bloqueio padronizada: **processo → aprovação → documentos**, evitando deadlocks entre tramitação e decisão.
- Transação mais pesada do MVP (submissão de documentos com snapshot canônico e hash, aprovação, numeração): meta p95 < 1 s e tempo de bloqueio < 300 ms; snapshots de documentos grandes são montados antes do bloqueio quando possível e confirmados pelo `draftRevision`.
- O `RuleContext` é montado dentro da transação, após o bloqueio, para que as regras avaliem o mesmo estado que será gravado.
- Idempotência por `Idempotency-Key` (Redis, 24 h); em indisponibilidade segue sem replay e registra alerta.

## Backend
- **Módulo(s):** `process` (dono do comando); fachadas de `workflow` (`evaluateTransition`, `resolveDestination`), `approval` (`requestForStage`), `document` (`submitCovered`, `buildMovementRefs`), `catalog` (`NumberingFacade.next`, `BusinessCalendarFacade`), `organization` (`DepartmentFacade.assertActiveInOrganization`), `identity` (`MembershipFacade.isEligibleAssignee`), `access` (`AuthorizationService.assertCan`), `timeline`, `audit` (`AuditService`), `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `ForwardProcessCommand` → `ForwardProcessHandler`; serviço de domínio `StageTransitionService`; `DeadlineCalculator` (US-055).
- **Domínio:** `Process.forward(...)` aplica RN-TRAM-02/13/16; `ProcessStage.close()`/`ProcessStage.enter()`; `ProcessMovement.record()` (imutável); value objects `DueDate`, `MovementDocumentRef`, `AcknowledgedWarning`.
- **Transação:** passos 11.2–11.15 em uma transação interativa Prisma (`READ COMMITTED`) com `FOR UPDATE` no processo.

## Frontend
- **Tela(s):** SCR-103 (painel lateral em SCR-006, `/processos/[id]`).
- **Componentes:** `ForwardPanel` (Sheet de `packages/ui`), `TransitionRadioGroup`, `DestinationDepartmentField` (`DepartmentTreeSelect`), `AssigneeLookup`, `DueDateField` (prévia via `PRC-08`; recálculo por `CAL-06`), `CommentField`, `DocumentsChecklist` (selo "Em aprovação"), `RuleViolationsList`, `WarningsAcknowledgement`, `ForwardSummary`.
- **Dados:** TanStack Query `['t', tenantId, 'process', id, 'available-actions']`, `[..., 'checklist']`, `[..., 'documents']`; `useMutation(forwardProcess)` com `If-Match` e `Idempotency-Key`; após sucesso invalida `process`, `summary`, `movements`, `timeline`, `tasks`, `dashboard`.
- **Estados:** skeleton; sem transições ("Não há encaminhamentos disponíveis nesta etapa"); erro de carga com "Tentar novamente"; botão com carregamento; avisos de conflito.
- **Acessibilidade e responsividade:** foco preso no painel e devolvido ao botão de origem; violações anunciadas em `aria-live`; atalho `Esc` com confirmação se houver dados; em telas < 768 px o painel ocupa a tela inteira com ações fixas no rodapé.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_stages`, `process_assignments`, `process_movements`, `process_access`, `number_sequences` (autuação), `documents`, `document_versions`, `approvals`, `approval_documents` (destino `APPROVAL`), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma tabela nova (runtime criado em US-001); schema Zod de `process_movements.metadata` versionado em `packages/validation`.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id) WHERE status = 'ACTIVE'` em `process_stages`; `UNIQUE (tenant_id, process_id) WHERE is_active` em `process_assignments`; `UNIQUE (tenant_id, process_id, sequence)` em `process_movements`; checks de prazo sobrescrito e de comentário.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-19 | POST | `/api/v1/processes/{id}/forward` | `{ transitionId, expectedStageId, toDepartmentId?, toUserId?, dueAt?, dueDateOverrideReason?, comment?, documentIds?, acknowledgedWarnings? }` + `If-Match` + `Idempotency-Key` | `200 { data: Process }` com `status`, `currentStage`, `currentDepartment`, `currentResponsible`, `movement { id, sequence }`, `approval { id, approverLabel }?`, `version` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 500, 503 |
| PRC-08 / PRC-09 | GET | `/api/v1/processes/{id}/available-actions`, `/checklist` | — | Transições, prévias e violações | 200, 404 |
| DOC-01, DOC-08, DEP-02, USR-02, CAL-06 | GET/POST | (apoio) | — | — | 200 |

```json
{
  "transitionId": "0192a1…", "expectedStageId": "0192b7…",
  "comment": "ETP concluído; seguem ETP e mapa de riscos.",
  "documentIds": ["0192c3…", "0192c9…"], "acknowledgedWarnings": []
}
```

## Logs
- `info` `process.forwarded` — `processId`, `movementId`, `fromStageKey`, `toStageKey`, `transitionKey`, `toDepartmentId`, `hasAssignee`, `durationMs`, `lockWaitMs`, `correlationId`.
- `info` `process.forward_rejected` — `code` (`TRANSITION_BLOCKED`, `WARNINGS_NOT_ACKNOWLEDGED`, `STAGE_CHANGED`…), quantidade de violações.
- `warn` `process.lock_wait` — espera > 200 ms no bloqueio; `warn` `idempotency.store_unavailable`.
- `error` `process.forward_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** comentário, conteúdo de documentos, valores estimados, IP em claro fora da auditoria.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.forward` | `WORKFLOW` | Commit | `changes`: `status`, `currentStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`. `metadata`: `processCode`, `movementId`, `transitionKey`, `fromStatus`/`toStatus`, `warningsAcknowledged`, `dueDateOverridden`, `idempotencyKey` |
| `process.number_assign` | `DATA_CHANGE` | Autuação | `number`, `year`, `code` |
| `document.version_create`, `document.submit`, `approval.request` | `DATA_CHANGE`/`WORKFLOW` | Destino `APPROVAL` | Conforme US-051 |
| `access.denied` | `ACCESS` | Sem permissão/custódia | `reasonCode` = `PROCESS_FORWARD` ou `NOT_PROCESS_CUSTODIAN` |

## Testes necessários
- **Unitários:** resolução de unidade (4 resoluções) e de responsável (4 políticas + inelegível); cálculo de prazo com feriado e fim de semana; montagem de `MovementDocumentRef`; filtragem de avisos reconhecidos; transições de status (DEC-013).
- **Integração (Testcontainers):** atomicidade com falha induzida em cada passo (inclui sequência de numeração e versões); `ProcessAccess` CURRENT/HISTORICAL; timeline, auditoria e outbox na mesma transação; RLS com `app.tenant_id` divergente.
- **API/contrato:** `violations[]` no formato api.md §2.1.2; cabeçalhos `ETag`, `Idempotent-Replayed`; ordem `STAGE_CHANGED` antes de `VERSION_CONFLICT`.
- **RBAC e multi-tenant:** custodiante × lotado sem responsável × não lotado × participante × gestor sem custódia; ids de outro tenant → 404/422.
- **Concorrência:** 20 encaminhamentos paralelos do mesmo processo → 1 sucesso, demais `STAGE_CHANGED`; encaminhar × decidir aprovação avulsa sem deadlock.
- **E2E (Playwright):** jornada J-02 (envio do DFD) e encaminhamento ETP → pesquisa com aviso reconhecido.
- **Acessibilidade/performance:** axe no SCR-103; k6 com 10 encaminhamentos/s por 2 min → p95 < 1 s e 0 erros 5xx.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Custódia, escopo e status aplicados na API; botão oculto/desabilitado conforme `PRC-08`
- [ ] Atomicidade comprovada por teste de falha induzida (inclui numeração, versões e aprovação)
- [ ] `ProcessMovement` com os 10 dados exigidos e avisos reconhecidos verificado em teste
- [ ] Auditoria e eventos verificados; teste incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-19 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `process_forwarded_total`, `process_forward_duration_seconds`; spans de regras, numeração e aprovação
- [ ] SCR-103 acessível (axe) e utilizável em 360 px
- [ ] Revisão de código e de segurança aprovadas
- [ ] `StageTransitionService` documentado para reúso

## Estimativa
**L** — comando transacional mais complexo do MVP (bloqueio, motor de regras, resolução de destino e prazo, numeração, submissão de documentos, aprovação, visibilidade, projeções, outbox e idempotência) e painel com sete blocos de interação.

## Prioridade
**P0** — sem encaminhamento não há tramitação, aprovação, prazos nem caixa de tarefas; bloqueia todas as jornadas do MVP 1.
