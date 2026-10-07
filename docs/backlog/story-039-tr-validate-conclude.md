---
id: US-039
title: "Validar e concluir o TR"
epic: EP-006
feature: FT-027
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-037, US-038]
modules: [term, document, access, timeline, audit, platform]
screens: [SCR-012]
endpoints: [DOC-08, DOC-09, DOC-10]
permissions: [TERM_SUBMIT, PROCESS_VIEW]
events: [DocumentFinalized, DocumentVersionCreated, DocumentSubmitted]
---

# US-039 — Validar e concluir o TR

## Título
Validar e concluir o TR

## Descrição
**Como** analista de planejamento responsável pelo TR, **quero** ver as pendências que impedem a conclusão e os avisos de consistência com o ETP antes de concluir o documento, **para** entregar um TR completo e coerente, sem redigitar nem adivinhar o que falta.

A validação (`DOC-08`) agrega as pendências genéricas do template (seções e campos obrigatórios — RN-TR-13) com pendências específicas do TR: bloqueantes (`TR_*`, impedem concluir) e avisos de consistência com o ETP de origem (`TR_*`, não bloqueiam, mas exigem reconhecimento explícito). Concluir (`DOC-10`) ou, quando o tipo exigir aprovação avulsa, submeter (`DOC-09`) revalida tudo na mesma transação, cria uma nova versão do documento e gera o evento `DocumentFinalized` — conhecido no domínio do TR como `TermCompleted`.

## Contexto
- O TR só está pronto para seguir à fase de seleção do fornecedor quando reúne, de forma coerente, os dados elaborados nas stories anteriores do épico: seções (US-036), importação do ETP (US-037) e itens/condições (US-038).
- DEC-018 define o ciclo único de status do documento: tipos semeados como o TR nascem com `requiresApproval = false`, então a ação padrão é **concluir** (`FINALIZED`); a aprovação formal ocorre na etapa `APPROVAL` do workflow que cobre o TR, sem exigir submissão avulsa.
- DEC-019 cita a validação cruzada "quantidade divergente entre ETP e TR" como um aprimoramento do MVP 5; o pacote deste épico antecipa a versão **determinística** (sem IA) para o MVP 1, deixando a análise mais ampla para o MVP 5 — ver Dependências.
- Esta é a story que, por convenção de api.md §2.1.2, define o catálogo concreto de códigos `TR_*` de completude.

## Objetivo
Garantir que nenhum TR seja concluído com pendência bloqueante e que todo TR com ETP de origem tenha os avisos de divergência explicitamente reconhecidos, para que o conteúdo que segue à licitação seja completo e rastreável.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`) e Compras (`COMPRAS`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Área requisitante (`REQUISITANTE`) quando custodia o TR.

## Pré-condições
- TR criado (US-036), com seções, itens e condições preenchidos nas medidas possíveis (US-037, US-038).
- TR em `DRAFT`/`RETURNED`, sob custódia (POL-01) ou participação `COLLABORATOR`/`CONSULTANT` do usuário.
- Usuário com `TERM_SUBMIT` cobrindo o processo.
- Processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`.

## Fluxo principal
1. No editor do TR (SCR-012), o painel de completude chama `DOC-08` sempre que uma seção, campo ou item muda (mesmo serviço do indicador de RN-TR-13).
2. A API agrega as pendências genéricas do template e as específicas do TR (bloqueantes e avisos) e devolve `violations[]`.
3. O painel lista as pendências bloqueantes (com link para o campo/seção) e os avisos de consistência com o ETP, cada um com a opção **"Reconhecer"**.
4. O usuário resolve as pendências bloqueantes editando o que falta e reconhece os avisos aplicáveis.
5. Com zero pendências bloqueantes, o botão **"Concluir TR"** (ou **"Submeter para aprovação"**, se o tipo exigir) fica habilitado.
6. O front envia `POST` para `DOC-10` (ou `DOC-09`) com `acknowledgedWarnings` e `If-Match` da versão atual.
7. A API, na mesma transação, revalida a completude (evita corrida com edições concorrentes), aplica a transição de status (DEC-018), cria `DocumentVersion` (`reason = FINALIZATION`/`SUBMISSION`), audita e publica o evento no outbox.
8. A API responde 200; o front bloqueia a edição, mostra "TR concluído" (ou "TR enviado para aprovação") e atualiza o indicador de status.
9. A timeline recebe a entrada correspondente e o painel situacional do processo indica o próximo passo.

## Fluxos alternativos
- **FA-01 — Pendência bloqueante:** o botão "Concluir TR" permanece desabilitado com um resumo ("3 pendências") que expande a lista; tentar concluir pela API sem resolvê-las responde 422 `DOCUMENT_INCOMPLETE`.
- **FA-02 — Aviso não reconhecido:** o botão exige que todos os avisos estejam marcados como reconhecidos; se contornado via API, responde 422 `WARNINGS_NOT_ACKNOWLEDGED`.
- **FA-03 — Tipo com aprovação avulsa:** se o tenant configurar `requiresApproval = true` para o tipo TR, a ação do botão passa a ser "Submeter para aprovação" (`DOC-09`), levando o documento a `IN_REVIEW` e acionando o ciclo de `Approval` (US-051), fora do escopo desta story.
- **FA-04 — Aprovação de etapa sobre TR já concluído:** se o processo entrar depois em uma etapa `APPROVAL` que cubra o TR, o documento permanece `FINALIZED` durante a análise (`pendingApprovalId` preenchido, selo "Em aprovação" — DEC-018), sem nova ação do usuário nesta story.
- **FA-05 — Reabrir TR concluído:** fora do escopo; segue POL-11/US-065 (reabertura volta a `DRAFT` com justificativa e recalcula a completude desta story).

## Regras de negócio
- **RN-TR-34** — A completude (`DOC-08`) agrega as violações genéricas do módulo `document` (seções/campos obrigatórios do template) com as específicas do TR definidas abaixo, pelo mesmo serviço usado no indicador do editor (RN-TR-13) — nunca diverge entre tela e validação.
- **RN-TR-35** — Bloqueantes (`severity = BLOCKING`, impedem concluir/submeter — 422 `DOCUMENT_INCOMPLETE`): `TR_ESTIMATED_VALUE_REQUIRED` (sem valor estimado), `TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED` (origem `MANUAL` sem a seção `ESTIMATED_VALUE` preenchida/justificada — RN-TR-08), `TR_ITEMS_REQUIRED` (nenhum item com quantidade), `TR_SELECTION_CRITERION_REQUIRED` (sem critério de julgamento), `TR_AWARD_TYPE_REQUIRED` (sem tipo de adjudicação) — além das genéricas `SECTION_REQUIRED`, `SECTION_JUSTIFICATION_REQUIRED` e `FIELD_REQUIRED`.
- **RN-TR-36** — Avisos (`severity = WARNING`, não bloqueiam, exigem `acknowledgedWarnings`): quando o processo tiver ETP `FINALIZED`/`APPROVED`, compara por `processItemId` comum a quantidade do `DocumentItem` do TR com a do ETP — divergência gera `TR_ITEM_QUANTITY_DIVERGENT` (`itemId`, `params: { etpQuantity, trQuantity }`); `productWarrantyMonths` e `contractGuaranteePercent` ambos nulos gera `TR_GUARANTEE_NOT_DEFINED`. Comparações determinísticas; análise com IA fica para o MVP 5 (DEC-019).
- **RN-TR-37** — Concluir (`DOC-10`, tipo TR com `requiresApproval = false`, padrão semeado): `DRAFT`/`RETURNED` → `FINALIZED`; cria `DocumentVersion` (`reason = FINALIZATION`, snapshot completo); gera `DocumentFinalized` — alias de domínio `TermCompleted` (`document.finalized.tr`) — com `typedSummary`; bloqueia nova edição até reabertura (POL-11).
- **RN-TR-38** — Submeter (`DOC-09`, somente se o tenant configurar `requiresApproval = true` para o tipo TR): `DRAFT`/`RETURNED` → `IN_REVIEW`; mesma validação de completude e avisos desta story; o ciclo de `Approval` segue fora desta story.
- **RN-TR-39** — Exige `TERM_SUBMIT` com escopo que cubra o processo + POL-01 (custódia) ou participação conforme POL-02 + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`; `If-Match` com a versão atual do documento (`VERSION_CONFLICT` em divergência).
- **RN-TR-40** — Concluir/submeter é idempotente por `Idempotency-Key`: reenvio da mesma chave devolve a mesma resposta (`Idempotent-Replayed: true`) sem gerar uma segunda versão.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Pendências bloqueantes | `violations[]` (`severity = BLOCKING`) | lista (somente leitura) | — | RN-TR-35 | calculado por `DOC-08` |
| Avisos | `violations[]` (`severity = WARNING`) | lista (somente leitura) | — | RN-TR-36 | calculado por `DOC-08` |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de códigos (técnico) | Condicional (havendo avisos) | cada código deve estar entre os avisos atuais | `[]` |
| Ação de conclusão | `action` (`finalize`/`submit`) | botão | Sim | depende de `DocumentType.requiresApproval` | `finalize` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Existe pendência `BLOCKING` | Front + API | "Resolva as pendências antes de concluir." | `DOCUMENT_INCOMPLETE` |
| V-02 | Existe `WARNING` não reconhecido | Front + API | "Reconheça os avisos antes de concluir." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-03 | TR não está em `DRAFT`/`RETURNED` | API | "O TR não pode ser concluído no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-04 | Tipo TR não permitido na etapa atual | API | "O TR não pode ser concluído nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Sem `TERM_SUBMIT`/custódia | API | "Você não tem permissão para concluir este TR." | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` |
| V-06 | `If-Match` ausente | API | "Atualize a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-07 | `If-Match` divergente | API | "O TR foi alterado por outra pessoa. Recarregue para continuar." | `VERSION_CONFLICT` |
| V-08 | Chave de idempotência reutilizada com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `TERM_SUBMIT` com escopo que cubra o processo (permissions.md §2.3).
- **Políticas:** POL-01 (custódia) ou participação `COLLABORATOR`/`CONSULTANT` conforme POL-02; processo em status editável.
- **MFA:** não exigido (`TERM_SUBMIT` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão de conclusão não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentFinalized` (alias `TermCompleted`) | `document.finalized.tr` | Commit de `DOC-10` | `documentId`, `documentVersionId`, `typedSummary: { estimatedTotalValueMasked, itemsCount, warningsAcknowledgedCount }` |
| `DocumentVersionCreated` | `document.version_created.tr` | Mesmo commit (ou de `DOC-09`) | `reason = FINALIZATION` ou `SUBMISSION` |
| `DocumentSubmitted` | `document.submitted.tr` | Commit de `DOC-09` (tipo com `requiresApproval = true`) | `documentId`, `documentVersionId`, `approvalId?` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma ao concluir (padrão dos tipos semeados). Quando o tipo exigir aprovação avulsa, a submissão aciona o fluxo de `Approval` (US-051), que notifica o aprovador via `APPROVAL_REQUESTED` — fora do escopo desta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Validar e concluir o TR

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" tem um ETP finalizado e um TR em "DRAFT"
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e custódia do TR

  Scenario: [Sucesso] Concluir TR completo sem avisos
    Given que o TR tem valor estimado, itens com quantidade, critério de julgamento e tipo de adjudicação definidos
    And as quantidades dos itens do TR coincidem com as do ETP
    When "Carla" solicitar a validação de completude
    Then o sistema deve indicar 0 pendências bloqueantes e 0 avisos
    When "Carla" concluir o TR
    Then o documento deve mudar para "FINALIZED"
    And deve existir uma nova versão com "reason" igual a "FINALIZATION"
    And deve gerar o evento "DocumentFinalized"
    And deve gerar registro de auditoria "document.finalize"

  Scenario: [Sucesso] Concluir reconhecendo o aviso de divergência com o ETP
    Given que o item "3" tem quantidade "50" no TR e "40" no ETP finalizado
    When "Carla" solicitar a validação de completude
    Then o sistema deve apresentar o aviso "TR_ITEM_QUANTITY_DIVERGENT" para o item "3"
    When "Carla" concluir reconhecendo o aviso
    Then o TR deve ser concluído normalmente

  Scenario: [Validação] Pendência bloqueante impede a conclusão
    Given que o TR não tem nenhum item com quantidade
    When "Carla" tentar concluir o TR
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e violação "TR_ITEMS_REQUIRED"
    And o documento deve permanecer "DRAFT"

  Scenario: [Permissão] Usuário sem TERM_SUBMIT
    Given que "Bruno" não possui "TERM_SUBMIT" para o processo
    When "Bruno" tentar concluir o TR
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Concluir TR de outro tenant
    Given que existe um TR completo no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", tentar concluir esse TR
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Reenvio da conclusão com a mesma chave de idempotência
    Given que a conclusão foi aplicada com a chave "K2" e devolveu 200
    When a mesma requisição for reenviada com a chave "K2"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And o TR não deve gerar uma segunda versão "FINALIZATION"

  Scenario: [Concorrência] Conclusão concorrente com edição
    Given que "Carla" carregou o TR na versão "5"
    When outro usuário editar uma condição contratual, criando a versão "6"
    And "Carla" concluir informando "If-Match: \"5\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao concluir
    Given que o banco de dados fica indisponível durante a transação de conclusão
    When "Carla" concluir o TR
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o documento deve permanecer "DRAFT"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" concluir o TR com sucesso
    Then o documento deve mudar para "FINALIZED" e a API deve responder 200
    And o evento "DocumentFinalized" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Pendência bloqueante | 422 | `DOCUMENT_INCOMPLETE` | "Resolva as pendências antes de concluir." | Lista `violations[]` com link para o campo/seção |
| Aviso não reconhecido | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Reconheça os avisos antes de concluir." | Expande a lista de avisos pendentes |
| TR não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O TR não pode ser concluído no status atual." | Botão oculto; exibe status atual |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O TR não pode ser concluído nesta etapa." | Botão oculto |
| Sem permissão/custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não tem permissão para concluir este TR." | Botão oculto |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente novamente." | Recarrega o documento |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O TR foi alterado por outra pessoa. Recarregue para continuar." | Oferece "Ver versão atual" |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém estado; botão "Tentar novamente" |

## Dependências
- **Stories:** US-037 (dados importados do ETP, base dos avisos), US-038 (itens e condições, base das pendências). Indiretas: US-065 (ciclo de vida genérico do documento), US-023 (padrão análogo de validação/conclusão do ETP).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-019, DEC-030, DEC-032, DEC-104, DEC-105, DEC-161.
- **Configurações:** `DocumentType.requiresApproval` (por tenant, para o tipo TR).
- **Lacunas nas fontes canônicas:**
  1. api.md §2.1.2 reserva o prefixo `TR_*` e remete "à tabela de validações da story dona (US-039)" sem defini-los; esta story define o conjunto concreto (`TR_ESTIMATED_VALUE_REQUIRED`, `TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED`, `TR_ITEMS_REQUIRED`, `TR_SELECTION_CRITERION_REQUIRED`, `TR_AWARD_TYPE_REQUIRED`, `TR_ITEM_QUANTITY_DIVERGENT`, `TR_GUARANTEE_NOT_DEFINED`) — propor consolidá-los em api.md §2.1.2.
  2. DEC-019 associa a comparação de quantidade ETP×TR ao MVP 5; o pacote deste épico pede a versão determinística já no MVP 1. Adotado: esta story entrega a checagem determinística agora, e a análise mais ampla (IA) permanece no MVP 5 — propor alinhar a redação de DEC-019.
  3. Não há campo persistido para a justificativa do valor `MANUAL` (lacuna já registrada em US-036); `TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED` usa a seção `ESTIMATED_VALUE` como critério, conforme ali decidido.

## Impacto técnico
- `DOC-08`/`DOC-09`/`DOC-10` são genéricos e compartilhados com DFD/ETP/mapa de riscos/pesquisa; esta story estende o serviço de validação com um `TermValidator` plugável, sem alterar o contrato dos três endpoints.
- A revalidação de completude dentro da própria transação de conclusão evita a corrida em que uma edição concorrente tornaria o documento incompleto entre a checagem da tela e o clique em "Concluir".
- `TermValidator` deve permanecer determinístico e barato (é chamado a cada mudança no editor via `DOC-08`); a análise assistida por IA prevista para o MVP 5 (DEC-019) deve ser um validador adicional, não uma substituição deste.

## Backend
- **Módulo(s):** `term` (fornece o `TermValidator`); usa `document` (dono do ciclo de vida genérico — `DocumentValidationService`, `DocumentLifecycleService`), `access`, `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `GetDocumentValidationQuery` (`DOC-08`, já existente, estendida por `TermValidator`); `FinalizeDocumentCommand` (`DOC-10`) / `SubmitDocumentCommand` (`DOC-09`), ambos já existentes (US-065).
- **Domínio:** `TermValidator.validate(term, items, etp?): Violation[]` (RN-TR-35/36); `Document.finalize()`/`Document.submit()` (máquina de estados de DEC-018).
- **Integrações internas:** `EtpReadFacade.getActiveForProcess` (para os avisos de divergência); `AuthorizationService.assertCan('TERM_SUBMIT', { processId })`.
- **Transação:** revalidação de completude → transição de status → `DocumentVersion` → auditoria → outbox → commit, em uma única transação interativa.

## Frontend
- **Tela(s):** SCR-012, painel **"Completude do TR"**.
- **Componentes:** `ValidationChecklist` (bloqueantes e avisos, com links para o campo/seção), `AcknowledgeWarningToggle`, `ConcludeButton` (rótulo dinâmico "Concluir TR"/"Submeter para aprovação"), `ConfirmationDialog`.
- **Estados:** carregando a validação; vazio (0 pendências, destaque verde); erro ao calcular (com "Tentar novamente"); sucesso (documento bloqueado, status atualizado).
- **Acessibilidade e responsividade:** lista de pendências com foco programático ao clicar; status anunciado via `aria-live`; em telas < 768 px a checklist fica expansível (accordion).

## Banco de dados
- **Tabelas:** `documents` (status, `finalizedAt`/`submittedAt`), `document_versions` (insert), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma — reaproveita o ciclo de vida de DEC-017/DEC-018.
- **Índices/constraints relevantes:** nenhum novo; usa os já existentes de `documents`/`document_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `DOC-08` | GET | `/documents/{id}/validation` | — | `200 { data: { violations: [{ code, severity, message, sectionKey?, field?, itemId?, params }] } }` | 200, 403, 404 |
| `DOC-10` | POST | `/documents/{id}/finalize` | `{ acknowledgedWarnings?: string[] }` + `If-Match` + `Idempotency-Key` | `200 { data: TermOfReference }` com `status: "FINALIZED"` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `DOC-09` | POST | `/documents/{id}/submit` | `{ acknowledgedWarnings?: string[] }` + `If-Match` + `Idempotency-Key` | `200 { data: TermOfReference }` com `status: "IN_REVIEW"` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `document.validated` — `documentId`, `blockingCount`, `warningCount`, `durationMs`.
- `info` `document.finalized` / `document.submitted` — `documentId`, `documentVersionId`, `durationMs`.
- `warn` `document.warnings_pending` — tentativa de concluir com avisos não reconhecidos.
- `error` `document.finalize_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo das seções, valor estimado, especificações/critérios de aceitação dos itens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.finalize` | `DATA_CHANGE` | Commit de `DOC-10` | `metadata`: `documentVersionId`, `acknowledgedWarnings[]`, `idempotencyKey` |
| `document.submit` | `DATA_CHANGE` | Commit de `DOC-09` | `metadata`: `documentVersionId`, `acknowledgedWarnings[]`, `approvalId?` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/custódia | `reasonCode = TERM_SUBMIT` |

## Testes necessários
- **Unitários:** cada regra do `TermValidator` (bloqueantes e avisos) isoladamente; precedência entre `TR_ESTIMATED_VALUE_REQUIRED` e `TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED`; cálculo de `TR_ITEM_QUANTITY_DIVERGENT` por item.
- **Integração (Testcontainers PostgreSQL + Redis):** transição `DRAFT`/`RETURNED` → `FINALIZED`/`IN_REVIEW` (DEC-018); revalidação atômica dentro da transação; RLS entre tenants.
- **API/contrato:** respostas e erros de `DOC-08`/`DOC-09`/`DOC-10` conforme api.md; `violations[]` no formato de §2.1.2.
- **RBAC e multi-tenant:** `TERM_SUBMIT` por perfil e escopo; POL-01 (custódia); TR de outro tenant → 404.
- **Concorrência:** conclusão simultânea por dois usuários com o mesmo `If-Match` → um 200, outro 412; edição concorrente entre o cálculo da completude e o clique em concluir.
- **E2E (Playwright):** jornada completa com pendência bloqueante → resolução → aviso → reconhecimento → conclusão; variante com `requiresApproval = true`.
- **Acessibilidade/performance:** axe sem violações sérias no painel de completude; `DOC-08` com p95 < 400 ms para TR com até 50 itens.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TERM_SUBMIT`, POL-01 e POL-02 aplicados na API; botão oculto/desabilitado conforme as regras
- [ ] Catálogo de códigos `TR_*` documentado e coberto por teste
- [ ] Transação única (revalidação + transição + versão) comprovada por teste de falha induzida
- [ ] Auditoria `document.finalize`/`document.submit` e eventos `DocumentFinalized`/`DocumentSubmitted` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `DOC-08`/`DOC-09`/`DOC-10` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace da validação e da conclusão
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita os endpoints genéricos de ciclo de vida (`DOC-08`/`DOC-09`/`DOC-10`, US-065); a complexidade está no catálogo de validadores `TR_*` e na comparação determinística com o ETP, sem novas entidades.

## Prioridade
**P0** — fecha o épico: sem esta validação, o TR pode seguir incompleto ou divergente do ETP para a fase de seleção do fornecedor.
