---
id: US-051
title: "Solicitar aprovação e resolver o aprovador"
epic: EP-008
feature: FT-034
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-047, US-065]
modules: [approval, process, document, organization, access, timeline, audit, platform]
screens: [SCR-006]
endpoints: [PRC-19, DOC-09]
permissions: []
events: [ApprovalRequested]
---

# US-051 — Solicitar aprovação e resolver o aprovador

## Título
Solicitar aprovação e resolver o aprovador

## Descrição
**Como** sistema, **quero** criar automaticamente uma solicitação de aprovação e resolver quem deve decidi-la sempre que um processo entra numa etapa de aprovação ou um documento é submetido isoladamente, **para** que a decisão (US-052) chegue a uma pessoa certa, sem que o usuário precise escolher manualmente "para quem aprovar".

Esta story não é acionada por um botão próprio: ela é a lógica de domínio que roda, na mesma transação, dentro de duas ações já existentes — o encaminhamento (US-047, `PRC-19`) quando a etapa de destino é do tipo `APPROVAL`, e a submissão avulsa de um documento (US-065, `DOC-09`) quando o tipo de documento exige aprovação formal. Em ambos os casos, o sistema cria um `Approval` (`PENDING`), resolve e registra o aprovador (`USER`, `ROLE` ou `DEPARTMENT_HEAD`) e prepara os documentos cobertos para a análise — sem exigir, da parte de quem encaminhou ou submeteu, nenhuma escolha de "quem vai aprovar".

## Contexto
- A Lei 14.133/2021 exige aprovações formais em pontos específicos da fase preparatória (ex.: aprovação da demanda pelo titular da secretaria — art. 18; aprovação final pela autoridade competente). DEC-015 modela isso como etapas do tipo `APPROVAL` no workflow padrão (`APROVACAO_DFD`, `APROVACAO_AUTORIDADE`).
- DEC-022 generaliza a aprovação para dois contextos (`subjectType`): a etapa do workflow (`PROCESS_STAGE`) e a submissão avulsa de um documento fora de uma etapa de aprovação (`DOCUMENT`, usada por tenants que configuram `requiresApproval = true` num tipo de documento). Em ambos, o aprovador é resolvido **no momento da solicitação** e gravado — decisões futuras (US-052) usam exatamente esse registro, não recalculam.
- Resolver automaticamente evita o erro mais comum de fluxos manuais de aprovação: encaminhar "para a pessoa errada" ou esquecer de notificar o aprovador. Também é o ponto em que a segregação de funções (art. 7º, § 1º) começa a ser observada — ainda que a validação definitiva ocorra na decisão (POL-03, US-052).
- Como não existe tela própria, o efeito desta story é observado no painel do processo (SCR-006), que passa a exibir o selo "Em aprovação" nos documentos cobertos (DEC-018) e, para o encaminhamento, impede a conclusão da transação quando o aprovador não pode ser resolvido.

## Objetivo
Garantir que 100% das entradas em etapa `APPROVAL` e das submissões avulsas de documentos com aprovação exigida resultem em um `Approval` com aprovador resolvido e registrado, ou que a ação que as originou (encaminhar/submeter) seja integralmente desfeita quando isso não for possível — sem nenhuma aprovação "órfã" ou sem destinatário.

## Persona
- **Principal:** o sistema, em nome de quem encaminhou o processo (US-047) ou submeteu o documento (US-065).
- **Secundárias:** o aprovador resolvido (destinatário direto do efeito desta story); o titular/substituto da unidade aprovadora, quando `approverType = DEPARTMENT_HEAD`.

## Pré-condições
- Processo entrando numa `ProcessStage` cuja `WorkflowStage.type = APPROVAL` (via US-047), **ou** documento sendo submetido (`DOC-09`, US-065) cujo `DocumentType.requiresApproval = true`.
- Não existe já uma `Approval` `PENDING` para o mesmo `processStageId` (ou `documentId`, no caso avulso) — garantido pelos índices únicos de `approvals`.

## Fluxo principal
1. (Disparo A — etapa) Dentro da transação de `PRC-19` (US-047), ao detectar que a `WorkflowStage` de destino é do tipo `APPROVAL`, o sistema identifica os `DocumentType` cobertos pela etapa (`WorkflowStage.approvalDocumentTypeCodes`).
2. (Disparo B — avulso) Dentro da transação de `DOC-09` (US-065), ao submeter um documento cujo tipo exige aprovação, o sistema considera cobertura = apenas aquele documento.
3. Para cada documento coberto que esteja em `DRAFT`/`RETURNED`: valida a completude (mesmas regras de DOC-08) e, se não houver violação `BLOCKING`, cria uma nova `DocumentVersion` (`reason = SUBMISSION`) e transiciona o documento para `IN_REVIEW` (DEC-018). Havendo violação `BLOCKING`, toda a transação (encaminhamento ou submissão) é desfeita com `DOCUMENT_INCOMPLETE` (`violations[]`) — nenhum `Approval` é criado.
4. Para cada documento coberto que já esteja `FINALIZED`/`APPROVED`: o status não muda; apenas `pendingApprovalId` será preenchido no passo 7.
5. O sistema resolve o `approverType` configurado (etapa ou tipo de documento):
   - `USER`: aprovador = o usuário configurado, diretamente.
   - `ROLE`: aprovador = o perfil configurado; a resolução **não** escolhe uma pessoa específica aqui — grava `approverRoleId`, e a elegibilidade para decidir (quem efetivamente pode agir) é avaliada depois, em cada tentativa de decisão (POL-03), considerando quem possui o perfil com atribuição cobrindo a **unidade solicitante** do processo (`TENANT`, `ORGANIZATION` do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` contendo `requestingSecretariatId`/`requestingDepartmentId` — concessões `CURRENT`/`HISTORICAL` não contam, DEC-022).
   - `DEPARTMENT_HEAD`: aprovador = `headUserId` do `approverDepartmentId` configurado (ex.: a secretaria solicitante); `deputyUserId` dessa unidade também poderá decidir, pois `allowDeputy = true` é automático para este tipo (ver "Dependências → Suposições" no relatório final).
   - Se nenhum aprovador puder ser resolvido (ex.: unidade sem titular definido; perfil sem nenhum detentor com atribuição no escopo necessário), a API responde `APPROVER_UNRESOLVED` (422) e desfaz **toda** a transação de origem (o encaminhamento ou a submissão não se efetivam).
6. O sistema cria `Approval` (`status = PENDING`, `subjectType`, `processStageId`/`documentId`, `title` — ex.: "Aprovação da demanda — DFD 0005/2026" para etapa, ou "Aprovação avulsa — {tipo} {código}" para submissão avulsa —, `requestedById` = quem encaminhou/submeteu, `requestedAt = now`, `requestComment` = comentário da ação de origem quando houver, `approverType`, `approverUserId?`/`approverRoleId?`/`approverDepartmentId?`, `allowDeputy`, `dueAt` = o `dueAt` da `ProcessStage` recém-criada quando `subjectType = PROCESS_STAGE`, ou `null` quando `subjectType = DOCUMENT`).
7. O sistema cria uma `ApprovalDocument` para cada documento coberto, apontando para a **versão exata** em análise (a nova versão de submissão, para os que acabaram de ir a `IN_REVIEW`; a versão já `FINALIZED`/`APPROVED`, para os demais) e preenche `Document.pendingApprovalId` em todos eles.
8. O sistema concede `ProcessAccess` (`USER`/`APPROVER` para o aprovador resolvido e, se `allowDeputy`, para o substituto; ou `DEPARTMENT`/`CURRENT` para a unidade aprovadora, quando `approverType = ROLE`).
9. O sistema grava `AuditLog` `approval.request`, a entrada de timeline `APPROVAL_REQUESTED` ("Aprovação solicitada a {approverLabel}") e publica o evento `ApprovalRequested` no outbox — tudo na mesma transação do encaminhamento ou da submissão.
10. A transação de origem confirma; a resposta de `PRC-19`/`DOC-09` já reflete o processo/documento com a aprovação pendente.

## Fluxos alternativos
- **FA-01 — Documento já `APPROVED` reaprovado por etapa superior:** ex. o ETP aprovado pelo secretário entra em nova `Approval` na etapa `APROVACAO_AUTORIDADE`; o documento permanece `APPROVED` durante a nova análise (DEC-018), só `pendingApprovalId` muda.
- **FA-02 — Nenhum documento coberto ainda existe:** a etapa `APPROVAL` é alcançada, mas nenhum documento do tipo coberto foi criado ainda (configuração incomum) → `Approval` é criada sem `ApprovalDocument` (decisão recairá só sobre a etapa); registrar aviso no log.
- **FA-03 — Perfil (`ROLE`) sem nenhum detentor no escopo:** `APPROVER_UNRESOLVED`; a UI de encaminhamento (US-047) exibe "Não há aprovador configurado para esta etapa. Fale com o administrador do órgão." e mantém os dados do encaminhamento para nova tentativa.
- **FA-04 — Submissão avulsa (`DOC-09`) sem etapa de aprovação envolvida:** `dueAt` da `Approval` fica `null`; a UI não exibe prazo para esta aprovação.

## Regras de negócio
- **RN-TRAM-43** — Esta lógica dispara em exatamente dois pontos: entrada em `ProcessStage` cuja `WorkflowStage.type = APPROVAL` (`subjectType = PROCESS_STAGE`) e submissão avulsa de documento com `DocumentType.requiresApproval = true` (`subjectType = DOCUMENT`, DOC-09). Unicidade de pendência garantida pelos índices de `approvals` (`UNIQUE … WHERE status = 'PENDING'`).
- **RN-TRAM-44** — Documentos cobertos: para `PROCESS_STAGE`, os tipos de `WorkflowStage.approvalDocumentTypeCodes` (DEC-015); para `DOCUMENT`, apenas o próprio documento submetido.
- **RN-TRAM-45** — Documentos cobertos em `DRAFT`/`RETURNED` são validados por completude e passam a `IN_REVIEW` com nova `DocumentVersion` (`SUBMISSION`); violação `BLOCKING` desfaz a transação de origem (`DOCUMENT_INCOMPLETE`). Documentos já `FINALIZED`/`APPROVED` não mudam de status (DEC-018).
- **RN-TRAM-46** — `ApprovalDocument` referencia sempre a versão exata em análise (nova versão de submissão ou versão `FINALIZED`/`APPROVED` vigente); `Document.pendingApprovalId` é preenchido em todos os documentos cobertos, independentemente do status.
- **RN-TRAM-47** — Resolução de `approverType = ROLE`: grava `approverRoleId`; não resolve uma pessoa específica no momento da solicitação — a elegibilidade de quem decide é avaliada na decisão (POL-03/US-052), considerando apenas atribuições com escopo `TENANT`, `ORGANIZATION` do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` contendo a unidade solicitante (nunca `CURRENT`/`HISTORICAL`).
- **RN-TRAM-48** — Resolução de `approverType = DEPARTMENT_HEAD`: `approverUserId` = `headUserId` do `approverDepartmentId` configurado; `allowDeputy = true` sempre para este tipo (habilita `deputyUserId`); para `USER`/`ROLE`, `allowDeputy = false`.
- **RN-TRAM-49** — Se nenhum aprovador puder ser resolvido (unidade sem titular, inativa ou inexistente no tenant; titular ou aprovador `USER` sem vínculo `ACTIVE` não vencido no tenant; perfil sem detentor elegível no escopo necessário — só atribuições de perfil gravadas e vigentes contam, nunca a ponte por chave do modo fake), a API responde `APPROVER_UNRESOLVED` (422) e desfaz integralmente a transação de origem — nenhuma `Approval`, nenhuma mudança de status de documento, nenhum movimento de processo é persistido.
- **RN-TRAM-50** — A resolução do aprovador não aplica, neste momento, a segregação de funções (`approval.preventSelfApproval`): mesmo que o resolvido seja autor de um documento coberto, a `Approval` é criada normalmente; a segregação é verificada **na decisão** (POL-03, US-052), onde pode gerar `SELF_APPROVAL_FORBIDDEN`.
- **RN-TRAM-51** — `Approval.dueAt`: igual ao `dueAt` da `ProcessStage` recém-criada quando `subjectType = PROCESS_STAGE` (mesma SLA da etapa, DEC-031); `null` quando `subjectType = DOCUMENT` (submissão avulsa sem contexto de etapa: sem prazo no MVP 1).
- **RN-TRAM-52** — `title` segue o padrão "Aprovação de {nome da etapa} — {código do principal documento coberto}" para `PROCESS_STAGE`, ou "Aprovação avulsa — {nome do tipo} {código}" para `DOCUMENT`; `requestedById` = o ator do encaminhamento/submissão; `requestComment` = o comentário dessa ação, se houver, senão `null`.
- **RN-TRAM-53** — Efeitos síncronos na mesma transação: `ProcessAccess` (`USER/APPROVER` + substituto se `allowDeputy`, ou `DEPARTMENT/CURRENT` para `ROLE`), `AuditLog` `approval.request`, timeline `APPROVAL_REQUESTED`, evento `ApprovalRequested` no outbox.

## Campos
Esta story não expõe campos de formulário próprios (não há tela dedicada). Os campos abaixo são produzidos internamente a partir do encaminhamento (US-047) ou da submissão (US-065):

| Campo (dado) | Campo técnico | Tipo | Origem | Regras |
|---|---|---|---|---|
| Tipo do assunto | `subjectType` | enum (`ApprovalSubjectType`) | Disparo A/B | `PROCESS_STAGE` ou `DOCUMENT`; RN-TRAM-43 |
| Etapa/documento | `processStageId` / `documentId` | uuid | Disparo A/B | exatamente um dos dois preenchido |
| Tipo de aprovador | `approverType` | enum (`ApproverType`) | configuração da etapa/tipo | `USER`\|`ROLE`\|`DEPARTMENT_HEAD` |
| Aprovador resolvido | `approverUserId` / `approverRoleId` / `approverDepartmentId` | uuid | resolução (RN-TRAM-47/48) | exatamente um preenchido, conforme `approverType` |
| Permite substituto | `allowDeputy` | boolean | resolução | RN-TRAM-48 |
| Prazo | `dueAt` | timestamptz | `ProcessStage.dueAt` ou `null` | RN-TRAM-51 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Documento coberto incompleto (`BLOCKING`) | API | "Há pendências nos documentos desta etapa: {lista}." | `DOCUMENT_INCOMPLETE` |
| V-02 | Aprovador não pôde ser resolvido | API | "Não há aprovador configurado para esta etapa. Fale com o administrador do órgão." | `APPROVER_UNRESOLVED` |
| V-03 | Já existe `Approval` `PENDING` para a mesma etapa/documento (corrida) | API | "Já existe uma aprovação em andamento para este item." | `APPROVAL_NOT_PENDING` (na tentativa concorrente) |

## Permissões
- **Permissão:** nenhuma permissão própria — a ação é interna, executada dentro da autorização já exigida por `PRC-19` (`PROCESS_FORWARD` + POL-01, US-047) ou `DOC-09` (permissão de submissão do tipo + POL-02, US-065).
- **Políticas:** DEC-022 (resolução do aprovador) e POL-03 (usada aqui apenas como referência de escopo para `ROLE`; a aplicação efetiva de POL-03 ocorre na decisão, US-052).
- **MFA:** não aplicável (sem ação direta do usuário final).
- **Sem permissão:** não se aplica — se o encaminhamento/submissão de origem não for autorizado, esta lógica nunca é executada.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalRequested` | `approval.requested` | Commit do encaminhamento (US-047) ou da submissão (US-065) que criou a `Approval` | `approvalId`, `subjectType`, `processStageId?`, `documentId?`, `documentVersionIds[]`, `approverType`, `approverUserId?`, `approverRoleId?`, `approverDepartmentId?`, `allowDeputy`, `dueAt?` |

Projeção síncrona: entrada `APPROVAL_REQUESTED` na timeline ("Aprovação solicitada a {approverLabel}", com `dueAt`); `ProcessAccess` (`APPROVER`/`CURRENT`) conforme RN-TRAM-53. Os eventos `DocumentSubmitted`/`DocumentVersionCreated` (quando aplicável) são gerados pela própria transição de documento (DEC-018) e já pertencem a US-047/US-065, não a esta story.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` | Aprovador designado (`approverUserId`); titular + substituto quando `allowDeputy`; para `ROLE`, detentores do perfil com escopo sobre o processo (máx. 50 — senão notifica a unidade atual) | IN_APP (**obrigatório**, não pode ser desativado) + EMAIL (padrão ligado) | Evento `ApprovalRequested` |

Esta é a única notificação do catálogo marcada como obrigatória em app — o aprovador não pode deixar de ser avisado de uma pendência sob sua responsabilidade.

## Critérios de aceite em Gherkin
```gherkin
Feature: Solicitar aprovação e resolver o aprovador

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o processo "0012/2026" na etapa "ESTUDOS_PRELIMINARES", unidade "Secretaria de Obras"
    And a próxima etapa do workflow é "APROVACAO_AUTORIDADE" (tipo "APPROVAL"), aprovador "DEPARTMENT_HEAD" da "Secretaria de Obras"

  Scenario: [Sucesso] Encaminhar para etapa de aprovação resolve o titular da secretaria
    Given que "Roberto" é o titular ("headUserId") da "Secretaria de Obras"
    And os documentos "ETP", "Mapa de riscos", "Pesquisa de preços" e "TR" do processo "0012/2026" estão completos e "FINALIZED"
    When "Carla" encaminhar o processo "0012/2026" para "APROVACAO_AUTORIDADE"
    Then deve ser criada uma "Approval" com status "PENDING", "approverType" "DEPARTMENT_HEAD" e "approverUserId" igual a "Roberto"
    And deve existir uma "ApprovalDocument" para cada um dos quatro documentos, apontando para a versão vigente de cada um
    And "Roberto" deve receber a notificação obrigatória "APPROVAL_REQUESTED"
    And deve gerar registro de auditoria "approval.request"
    And deve gerar o evento "ApprovalRequested"

  Scenario: [Validação] Documento coberto incompleto bloqueia a aprovação
    Given que o "TR" do processo "0012/2026" está em "DRAFT" e sem itens obrigatórios preenchidos
    When "Carla" tentar encaminhar o processo "0012/2026" para "APROVACAO_AUTORIDADE"
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e as violações do "TR"
    And nenhuma "Approval" deve ser criada
    And o processo deve permanecer na etapa "ESTUDOS_PRELIMINARES"

  Scenario: [Permissão] Resolução de ROLE ignora concessões apenas de visibilidade
    Given que o aprovador configurado é do tipo "ROLE" ("AUTORIDADE_COMPETENTE")
    And "Vera" possui o perfil "AUTORIDADE_COMPETENTE" apenas com concessão "HISTORICAL" sobre o processo "0012/2026" (já tramitou por uma unidade dela)
    And "Marcelo" possui o mesmo perfil com atribuição de escopo "DEPARTMENT" cobrindo a "Secretaria de Obras" (unidade solicitante)
    When o processo "0012/2026" entrar em "APROVACAO_AUTORIDADE"
    Then a "Approval" deve ser criada com "approverType" "ROLE" e "approverRoleId" de "AUTORIDADE_COMPETENTE"
    And, na decisão (US-052), apenas "Marcelo" deve ser aceito como aprovador — "Vera" deve receber "NOT_DESIGNATED_APPROVER" se tentar decidir

  Scenario: [Tenant incorreto] Unidade aprovadora pertence sempre ao mesmo tenant do processo
    Given que a "Secretaria de Obras" do processo "0012/2026" pertence ao tenant "Prefeitura de São José"
    When o sistema resolver o "approverDepartmentId" para a "Approval"
    Then o "headUserId" resolvido deve ter vínculo ativo no tenant "Prefeitura de São José"
    And nenhum usuário de outro tenant pode ser resolvido como aprovador, mesmo por erro de configuração

  Scenario: [Duplicidade] Reenvio do encaminhamento com a mesma chave de idempotência
    Given que "Carla" encaminhou o processo "0012/2026" para "APROVACAO_AUTORIDADE" com a chave "K7" e uma "Approval" foi criada
    When a mesma requisição de encaminhamento for reenviada com a chave "K7"
    Then a API deve responder com o mesmo resultado e "Idempotent-Replayed: true"
    And deve existir apenas uma "Approval" "PENDING" para a etapa

  Scenario: [Concorrência] Duas tentativas de gerar aprovação para a mesma etapa
    Given que, por falha do cliente, duas requisições de encaminhamento para "APROVACAO_AUTORIDADE" são enviadas quase simultaneamente
    When ambas tentarem criar a "Approval" para a mesma "processStageId"
    Then apenas uma "Approval" "PENDING" deve existir, protegida pelo índice único "(tenant_id, process_stage_id) WHERE status = 'PENDING'"
    And a segunda tentativa deve falhar com conflito e não deve duplicar notificações

  Scenario: [Falha de banco] Banco indisponível durante a resolução do aprovador
    Given que o banco de dados fica indisponível durante a transação de encaminhamento
    When "Carla" encaminhar o processo "0012/2026" para "APROVACAO_AUTORIDADE"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma "Approval", versão de documento ou tramitação deve ser persistida

  Scenario: [Falha de integração] Nenhum aprovador resolvido desfaz o encaminhamento
    Given que a "Secretaria de Obras" está sem titular definido ("headUserId" nulo) e sem substituto
    When "Carla" encaminhar o processo "0012/2026" para "APROVACAO_AUTORIDADE"
    Then a API deve responder 422 com código "APPROVER_UNRESOLVED"
    And o processo deve permanecer na etapa "ESTUDOS_PRELIMINARES"
    And nenhuma "Approval" ou mudança de status de documento deve ser persistida
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Documento coberto incompleto | 422 | `DOCUMENT_INCOMPLETE` | "Há pendências nos documentos desta etapa: {lista}." | Lista violações com link para cada documento |
| Aprovador não resolvido | 422 | `APPROVER_UNRESOLVED` | "Não há aprovador configurado para esta etapa. Fale com o administrador do órgão." | Mantém dados do encaminhamento/submissão; botão desabilitado até correção |
| Aprovação concorrente já criada | 409 | `APPROVAL_NOT_PENDING` | "Já existe uma aprovação em andamento para este item." | Recarrega o painel |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a solicitação agora. Tente novamente em instantes." | Preserva dados da ação de origem |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-047 (encaminhamento — disparo A, `PRC-19`); US-065 (submissão avulsa — disparo B, `DOC-09`); US-052 (decisão, consome o que esta story resolve); US-057 (listagem de aprovações, `APV-01`); US-106 (dias úteis, usado no `dueAt` herdado da etapa).
- **Decisões/ADRs:** DEC-015, DEC-017, DEC-018, DEC-022, DEC-023, DEC-024, DEC-055, DEC-105; ADR-005, ADR-006.
- **Configurações:** `approval.preventSelfApproval` (referenciada, mas aplicada em US-052).
- **Lacunas nas fontes canônicas:** nenhuma pendente (cobertura de documentos = `WorkflowStage.approvalDocumentTypeCodes`; `dueAt` nulo na submissão avulsa aceito no MVP 1).

## Impacto técnico
- É o ponto de integração mais denso entre os módulos `process`, `document` e `approval`: roda **dentro** da transação de outra story (US-047 ou US-065), o que exige que `ApprovalFacade.requestForStageEntry(...)`/`requestForDocumentSubmission(...)` sejam chamadas síncronas, sem I/O externo, para não comprometer o orçamento de latência (p95 < 600 ms) dessas transações.
- Qualquer falha nesta lógica (incluindo `APPROVER_UNRESOLVED`) deve propagar como falha da transação **inteira** de origem — nenhuma escrita parcial. Isso reforça a necessidade de `ApprovalFacade` não abrir sua própria transação, apenas participar da ativa.
- Resolução de `ROLE` não materializa uma pessoa: decisões futuras (US-052) precisam repetir a consulta de escopo a cada tentativa — aceitável, pois é feita sob demanda e não em lote.

## Backend
- **Módulo(s):** `approval` (dono da lógica); fachadas de `process` (dados da etapa/processo), `document` (`DocumentCompletionValidator`, transição DEC-018), `organization` (`DepartmentFacade.getHead`), `access` (`RoleAssignmentFacade.resolveHoldersInScope`), `timeline`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** não há `Command` próprio exposto; serviço interno `ApprovalRequestService.requestForStageEntry(processStageId)` e `requestForDocumentSubmission(documentId)`, chamados por `ForwardProcessHandler` (US-047) e `SubmitDocumentHandler` (US-065).
- **Domínio:** `Approval.request(subject, approverConfig)` (fábrica que aplica RN-TRAM-43..52); `ApprovalDocument.snapshot(documentId, versionId)`.
- **Transação:** participa da transação já aberta por `PRC-19`/`DOC-09`; não inicia nem confirma transação própria.

## Frontend
- **Tela(s):** nenhuma tela própria; efeito visível em SCR-006 (selo "Em aprovação" nos documentos cobertos, conforme `pendingApprovalId` — DEC-018) e, quando a resolução falha, na própria tela de encaminhamento/submissão (erro `APPROVER_UNRESOLVED`).
- **Componentes:** `PendingApprovalBadge` (reutilizado de outras stories de documento).
- **Estados:** não aplicável (sem tela própria); o estado de erro é tratado pela tela de origem (US-047/US-065).
- **Acessibilidade e responsividade:** herdadas das telas de origem.

## Banco de dados
- **Tabelas:** `approvals`, `approval_documents`, `documents`, `document_versions`, `process_access`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (reutiliza `approvals`/`approval_documents` de entities.md §4).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_stage_id) WHERE status = 'PENDING' AND subject_type = 'PROCESS_STAGE'`; `UNIQUE (tenant_id, document_id) WHERE status = 'PENDING' AND subject_type = 'DOCUMENT'` — garantem a RN-TRAM-43 mesmo sob concorrência.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-19 | POST | `/api/v1/processes/{id}/forward` | (US-047) — dispara esta lógica quando o destino é `APPROVAL` | inclui `pendingApproval` resumido no `Process`/`ProcessStage` retornado | 200, 422 (`DOCUMENT_INCOMPLETE`, `APPROVER_UNRESOLVED`) |
| DOC-09 | POST | `/api/v1/documents/{id}/submit` | (US-065) — dispara esta lógica quando o tipo exige aprovação | inclui `pendingApprovalId` no `Document` retornado | 200, 422 (`DOCUMENT_INCOMPLETE`, `APPROVER_UNRESOLVED`) |
| APV-01 / APV-02 | GET | `/api/v1/approvals` / `/api/v1/approvals/{id}` | (US-057 / US-052) — leitura do resultado desta story | `200 { data: Approval }` | 200 |

Esta story não introduz endpoint próprio; os três acima já pertencem a outras stories e são listados apenas como pontos de entrada/leitura.

## Logs
- `info` `approval.requested` — `approvalId`, `subjectType`, `processStageId?`, `documentId?`, `approverType`, `resolvedVia` (`USER`\|`ROLE`\|`DEPARTMENT_HEAD`), `durationMs`, `correlationId`.
- `warn` `approval.role_scope_empty` — perfil configurado sem nenhum detentor no escopo necessário, antes de falhar com `APPROVER_UNRESOLVED`.
- `error` `approval.request_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo de documentos, `requestComment`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.request` | `WORKFLOW` | Commit da transação de origem que criou a `Approval` | `changes`: criação de `Approval` (status inicial `PENDING`). `metadata`: `subjectType`, `approverType`, `approverUserId?`/`approverRoleId?`/`approverDepartmentId?`, `documentIds[]` |

## Testes necessários
- **Unitários:** resolução de `approverType` (`USER`/`ROLE`/`DEPARTMENT_HEAD`); exclusão de concessões `CURRENT`/`HISTORICAL` na resolução de `ROLE`; cálculo de `title`/`dueAt`.
- **Integração (Testcontainers):** encaminhamento para etapa `APPROVAL` cria `Approval` + `ApprovalDocument` corretos; submissão avulsa (`DOC-09`) idem; `DOCUMENT_INCOMPLETE` desfaz tudo; `APPROVER_UNRESOLVED` desfaz tudo (nenhuma linha órfã em nenhuma tabela).
- **API/contrato:** respostas de `PRC-19`/`DOC-09` incluem os dados esperados de aprovação pendente; erros conforme api.md.
- **RBAC e multi-tenant:** `headUserId` e detentores de `ROLE` resolvidos nunca pertencem a outro tenant.
- **Concorrência:** duas transações tentando criar `Approval` para a mesma etapa/documento → uma sucede, outra falha pelo índice único, sem duplicar notificação.
- **E2E (Playwright):** encaminhar até uma etapa `APPROVAL` e verificar o selo "Em aprovação" e a notificação do aprovador.
- **Acessibilidade/performance:** não aplicável (sem UI própria); p95 da lógica embutida < 150 ms (orçamento dentro do p95 de `PRC-19`/`DOC-09`).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + integração) e passando no CI
- [ ] `DOCUMENT_INCOMPLETE` e `APPROVER_UNRESOLVED` desfazem integralmente a transação de origem, comprovado por teste de falha induzida
- [ ] Resolução de `USER`/`ROLE`/`DEPARTMENT_HEAD` cobertas por testes unitários, incluindo exclusão de `CURRENT`/`HISTORICAL`
- [ ] Auditoria `approval.request` e evento `ApprovalRequested` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] Índices únicos de `approvals` validados sob concorrência
- [ ] Logs sem dados sensíveis; métricas e trace presentes, dentro do orçamento de latência de `PRC-19`/`DOC-09`
- [ ] Notificação obrigatória `APPROVAL_REQUESTED` verificada (não pode ser desativada em app)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Cobertura de documentos por `WorkflowStage.approvalDocumentTypeCodes` validada com os dois workflows semeados (DEC-015)

## Estimativa
**L** — concentra a parte mais delicada da aprovação genérica (DEC-022): três formas de resolver aprovador, duas origens de disparo, transição de documentos acoplada (DEC-018) e a garantia de desfazer tudo quando o aprovador não pode ser resolvido, tudo dentro da transação de outra story.

## Prioridade
**P0** — sem aprovador resolvido automaticamente, nenhuma etapa `APPROVAL` do workflow padrão (obrigatório pela Lei 14.133/2021) consegue avançar; bloqueia US-052 e todo o restante do ciclo de aprovações do MVP 1.
