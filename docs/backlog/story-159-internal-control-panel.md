---
id: US-159
title: "Abrir a manifestação e painel do Controle Interno com visão de riscos"
epic: EP-026
feature: FT-077
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-033, US-047, US-158]
modules: [internal-control, risk, process, workflow, legal-review, document, notification, timeline, access, audit, platform]
screens: [SCR-020, SCR-006]
endpoints: [ICT-08, ICT-09, ICT-10, ICT-11, RSK-09, DOC-17]
permissions: [INTERNAL_CONTROL_REVIEW_VIEW, INTERNAL_CONTROL_REVIEW_MANAGE, PROCESS_VIEW]
events: [InternalControlReviewOpened, InternalControlReviewStarted, InternalControlReviewCanceled]
---

# US-159 — Abrir a manifestação e painel do Controle Interno com visão de riscos

## Título
Abrir a manifestação do Controle Interno na entrada da etapa e dar ao analista o painel com a visão de riscos do processo

## Descrição
**Como** analista do Controle Interno (ou titular/substituto da unidade do Controle Interno), **quero** que a manifestação sobre o processo nasça sozinha quando ele entra na etapa `CONTROLE_INTERNO`, com o checklist do órgão já fixado, e abrir um painel que reúna o mapa de riscos, os avisos `WARNING` que foram superados na tramitação e o parecer jurídico vigente, **para** iniciar a análise (art. 169, II da Lei 14.133/2021) enxergando num lugar só o que o processo já registrou de risco e de aviso ignorado.

A story entrega: a **abertura automática** da `InternalControlReview` (`PENDING`) pelo `StageLifecycleListener`, com o checklist publicado aplicável fixado e uma resposta `PENDING` por item; a **fila** do Controle Interno (ICT-08); o **painel** SCR-020 com respostas, achados e **visão de riscos** (ICT-09, contrato-base que as US-160, US-161 e US-162 estendem); o ato de **iniciar** a análise (ICT-10, `PENDING` para `IN_REVIEW`, com atribuição); a leitura da **aba "Controle Interno" do processo** (ICT-11); e o ciclo de vida da manifestação com a tramitação (rodada nova na volta do processo, cancelamento com o processo ou o ramo). Responder o checklist e registrar achados é da US-160; emitir a manifestação e concluir é da US-161; acompanhar o atendimento dos achados é da US-162; os modelos de checklist são da US-158. **Não há IA** nesta story nem na feature (DEC-200, RN-ICT-20).

## Contexto
- DEC-200 cria o módulo `internal-control`: `InternalControlReview` por processo e rodada, `InternalControlChecklist` versionado por tenant, `InternalControlChecklistAnswer` e `InternalControlFinding`. A mecânica de abertura, rodadas e retomada espelha a da análise jurídica (DEC-199, EP-025), com a diferença de que não há diligência: a devolução do processo mantém a manifestação `IN_REVIEW` e reabre a rodada na volta (`entities.md` §6.5).
- A abertura é feita no mesmo commit da tramitação pelo `StageLifecycleListener` (porta do módulo `process`, implementada por `internal-control`; `domains.md` §12.3), como a `LegalReview` na entrada em `JURIDICO`. A etapa `CONTROLE_INTERNO` pode ser um ramo de execução paralela (DEC-194); a manifestação continua sendo **uma por processo** (índice parcial `(tenant_id, process_id) WHERE status IN ('PENDING','IN_REVIEW')`).
- O MVP 1 já grava a ciência dos avisos `WARNING` superados (L-08): `ProcessMovement.metadata.warningsAcknowledged[]` (`ruleId` + mensagem exibida, DEC-016) e a auditoria do encaminhamento (US-047, RN-TRAM-06). A visão de riscos apenas **lê** essa evidência e o mapa de riscos do MVP 1 (`Risk`, US-033; documento `RISK_MAP`); o módulo `internal-control` nunca escreve em `risk` ou `process` (D1).
- O parecer jurídico concluído (EP-025) é lido quando a ordem das etapas o coloca antes; na ordem oposta ou na dispensa (`WAIVED`) o painel mostra a ausência, sem bloquear. A manifestação grava o parecer considerado só na conclusão (RN-ICT-42, US-161).
- Leitura ampla do Controle Interno (POL-20): visibilidade de todos os processos do escopo (`TENANT` por padrão), inclusive orçamento sigiloso; para os demais perfis vale `PROCESS_VIEW` e a visibilidade do processo (DEC-024). Conduzir exige independência: não ter atuado como autor de documento, aprovador ou procurador, e ser o `assigneeId` ou o titular/substituto da unidade da etapa.
- O checklist padrão `FASE_PREPARATORIA` v1 é semeado e editável por tenant (princípio 17; "a validar com o piloto", overview §7). Qual checklist se aplica a cada processo é resolvido pela regra de aplicabilidade e pelo padrão do tenant (US-158); aqui ele é **fixado** na abertura e não muda mais.
- Orçamento sigiloso (DEC-030/POL-09) nunca aparece em evento, notificação, log, fila ou prioridade; o painel não exibe valores monetários.

## Objetivo
Garantir que 100% dos processos que entram em `CONTROLE_INTERNO` tenham, no mesmo commit da tramitação, uma única manifestação aberta com o checklist fixado e todas as respostas criadas; que o analista chegue ao painel com a visão de riscos completa em p95 < 2 s; que a fila abra em p95 < 1,5 s para 5.000 manifestações; e que o início da análise seja atômico, com atribuição e linha de base das versões vigentes dos documentos.

## Persona
- **Principal:** Analista do Controle Interno (`CONTROLE_INTERNO`) com `INTERNAL_CONTROL_REVIEW_VIEW` e `INTERNAL_CONTROL_REVIEW_MANAGE` (Renata Prado).
- **Secundárias:** Titular/substituto da unidade do Controle Interno (Dr. Otávio: triagem da fila, início e custódia); Auditor (`AUDITOR`, lê painel e trilha); Autoridade competente (`AUTORIDADE_COMPETENTE`) e demais perfis com `PROCESS_VIEW` (leem a aba do processo e, depois da conclusão, o painel); criador do processo e responsável da etapa (acompanham a situação no processo).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; MFA conforme `security.mfaPolicy` (`INTERNAL_CONTROL_REVIEW_MANAGE` é risco `M`: MFA só com política `ALL`; `INTERNAL_CONTROL_REVIEW_VIEW` é risco `L`).
- **Abertura:** o tenant adotou a versão de workflow que contém a etapa `CONTROLE_INTERNO` (workflow padrão v2, DEC-196) e existe ao menos um checklist `PUBLISHED` aplicável ou o padrão do tenant (US-158).
- **Início (ICT-10):** `InternalControlReview` do tenant em `PENDING`, de processo `IN_PROGRESS` com a etapa `CONTROLE_INTERNO` ativa (`currentProcessStageId` não nulo), visível ao usuário (DEC-024).
- **Painel e fila:** `INTERNAL_CONTROL_REVIEW_VIEW` cobrindo o processo; `PROCESS_VIEW` basta para análises já concluídas ou canceladas e para a aba do processo (RN-ICT-65).

## Fluxo principal
1. **Abertura automática.** Quando o processo entra em `CONTROLE_INTERNO` (encaminhamento, US-047, ou entrada num ramo), o `StageLifecycleListener` chama `OpenInternalControlReviewCommand` na mesma transação da tramitação, com `app.tenant_id` ativo.
2. A API verifica se já existe manifestação aberta do processo (reentrada, ver RN-ICT-56); resolve o checklist (a `applicabilityRule` dos checklists `PUBLISHED`, senão o padrão do tenant, RN-ICT-57); calcula `warningsOverriddenCount` com os avisos reconhecidos nas movimentações do processo (RN-ICT-59); grava a `InternalControlReview` (`PENDING`, `currentRound = 1`, `sequence`, `processStageId`, `currentProcessStageId`, `checklistId`, sem `assigneeId`) e uma `InternalControlChecklistAnswer` `PENDING` para cada item do checklist (RN-ICT-58).
3. Ainda na transação: auditoria `internal_control_review.open` (ator `SYSTEM`), timeline e o evento `InternalControlReviewOpened` (outbox). Após o commit, a notificação `INTERNAL_CONTROL_QUEUED` chega ao titular e ao substituto da unidade do Controle Interno.
4. O titular ou o analista abre **"Controle Interno"** (SCR-020, `/controle-interno`); o front chama `GET /internal-control/reviews` (ICT-08) com os filtros da aba ("Minhas", "Não atribuídas", "Todas em aberto", "Concluídas") e mostra, por linha: processo (número e objeto), situação, rodada, responsável, prazo da etapa, avanço das respostas obrigatórias, contagem de achados por criticidade e a contagem de avisos superados.
5. Ao escolher uma linha, o front navega para `/controle-interno/[reviewId]` e chama `GET /internal-control/reviews/{id}` (ICT-09). O painel mostra o cabeçalho, as abas **Visão de riscos**, **Checklist**, **Achados**, **Documentos** e, depois da US-161, **Manifestação**, e guarda `meta.etag`.
6. Na aba **Visão de riscos** o analista vê: o resumo e a lista do mapa de riscos (código, título, categoria, fase, probabilidade, impacto, nível, status, responsável, tratamentos por situação), com o atalho "Abrir matriz de riscos" (RSK-09) e o documento `RISK_MAP` vigente; a lista dos **avisos superados** (regra, mensagem, quem reconheceu, quando e em qual etapa); o cartão do **parecer jurídico** (situação, ressalvas abertas, versão e atalho para abrir); e os **achados abertos de manifestações anteriores** do mesmo processo.
7. O analista aciona **"Iniciar análise"** (visível apenas a quem atende a RN-ICT-61); o diálogo informa "Ao iniciar, a análise ficará sob sua responsabilidade e as versões vigentes dos documentos serão registradas como linha de base." com a lista (tipo, `vN`, data) e os tipos "não elaborados".
8. O front envia `POST /internal-control/reviews/{id}/start` (ICT-10) com `If-Match` e `Idempotency-Key`.
9. A API, em uma transação: trava a `InternalControlReview`; valida existência e tenant, permissão e independência (POL-20), designação, `PENDING` e processo `IN_PROGRESS` com a etapa ativa; atribui `assigneeId` quando vazio; grava `status = IN_REVIEW`, `startedAt` (primeira passagem) e a linha de base das versões vigentes (RN-ICT-69); incrementa `version` (ETag); grava a auditoria `internal_control_review.start` e publica `InternalControlReviewStarted` (outbox).
10. A API responde 200 com a análise; o painel passa a "Em análise" e habilita o checklist para a US-160.
11. **Aba do processo.** Em SCR-006, qualquer perfil com `PROCESS_VIEW` abre a aba "Controle Interno" (ICT-11) e vê a situação da manifestação vigente, o responsável, a rodada, o avanço e o histórico de manifestações; o conteúdo detalhado respeita a RN-ICT-65.
12. **Ciclo de vida com a tramitação.** Se o processo for devolvido, a manifestação segue `IN_REVIEW` e, na volta, abre a rodada seguinte (RN-ICT-63); se o processo ou o ramo for cancelado, a manifestação aberta vai a `CANCELED` com motivo (RN-ICT-64).

## Fluxos alternativos
- **FA-01 — Reentrada na etapa com manifestação aberta:** a entrada repetida (retentativa do listener ou volta do processo) não cria outra manifestação nem repete `InternalControlReviewOpened` na rodada 1; ver rodada nova em FA-05 (RN-ICT-56).
- **FA-02 — Sem checklist aplicável:** nenhum checklist `PUBLISHED` aplica-se e o tenant não tem padrão publicado; a entrada na etapa é recusada, a tramitação inteira é revertida e a API do encaminhamento responde 409 `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE` com a orientação de acionar o administrador (RN-ICT-57; ver lacuna 2).
- **FA-03 — Análise sem designação:** o titular/substituto ou um analista lotado na unidade assume a análise ao iniciar; o `assigneeId` passa a ser quem iniciou (RN-ICT-61).
- **FA-04 — Análise designada a outra pessoa:** quem não é o `assigneeId` nem titular/substituto vê o painel (com `INTERNAL_CONTROL_REVIEW_VIEW`) sem o botão; a chamada direta responde 403 `NOT_INTERNAL_CONTROL_ASSIGNEE`.
- **FA-05 — Processo devolvido e retornado:** a manifestação `IN_REVIEW` permanece; ao voltar para `CONTROLE_INTERNO` a API incrementa `currentRound`, atualiza `currentProcessStageId`, regrava a linha de base das versões e publica `InternalControlReviewOpened` com `round` ≥ 2 (ver lacuna 4); respostas e achados abertos são reaproveitados (RN-ICT-63, RN-ICT-18).
- **FA-06 — Devolvida ainda `PENDING`:** a manifestação não iniciada permanece `PENDING`, sem rodada nova; na volta apenas `currentProcessStageId` é preenchido de novo. Enquanto o processo estiver fora da etapa, a linha aparece na fila como "Aguardando retorno do processo" (RN-ICT-62).
- **FA-07 — Aviso superado desde a abertura:** o processo foi encaminhado de novo depois de a manifestação abrir e há mais avisos reconhecidos que o congelado em `warningsOverriddenCount`; o painel exibe a lista atual e o selo "N novo(s) desde a abertura" (RN-ICT-59).
- **FA-08 — Parecer jurídico ausente ou dispensado:** o cartão mostra "Sem parecer jurídico concluído" ou "Análise jurídica dispensada (hipótese: {rótulo})"; não bloqueia o início (RN-ICT-60).
- **FA-09 — Documento do tipo previsto não elaborado:** DFD, ETP, mapa de riscos, pesquisa de preços, TR, edital ou minuta ausentes aparecem como "não elaborado" na aba Documentos; é um dado para a análise, não um bloqueio.
- **FA-10 — Nova manifestação depois de uma concluída:** se o processo voltar a `CONTROLE_INTERNO` depois da conclusão, nasce a manifestação seguinte (`sequence + 1`), com checklist resolvido de novo; a anterior permanece imutável e os achados dela ainda abertos aparecem na seção "Achados de manifestações anteriores" (RN-ICT-68).
- **FA-11 — Processo suspenso, cancelado ou fora da etapa:** ICT-10 responde 409 `INVALID_PROCESS_STATUS`; o painel mostra o botão desabilitado com o motivo; leituras continuam disponíveis.
- **FA-12 — Análise já iniciada, concluída ou cancelada:** ICT-10 responde 409 `INVALID_STATE`; ICT-08, ICT-09 e ICT-11 seguem disponíveis em qualquer situação.
- **FA-13 — Visão de riscos vazia:** processo sem riscos registrados mostra "Nenhum risco registrado no mapa de riscos" e o aviso de que o mapa é pré-requisito comum da fase; o início não é bloqueado.

## Regras de negócio
- **RN-ICT-07** — A manifestação abre na entrada em `CONTROLE_INTERNO`, com o checklist publicado aplicável (regra de aplicabilidade, senão o padrão) fixado na abertura; há uma só aberta por processo (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-08** — A visão de riscos reúne o mapa de riscos do processo e os avisos `WARNING` superados; a contagem é congelada na abertura em `warningsOverriddenCount` (DEC-200, L-08). *(regra da feature, adotada)*
- **RN-ICT-18** — Na devolução do processo a manifestação permanece `IN_REVIEW`; na volta abre-se nova rodada reaproveitando as respostas e achados abertos (DEC-200, DEC-196). *(regra da feature, adotada)*
- **RN-ICT-19** — Cancelamento do processo ou do ramo cancela a manifestação aberta, com motivo (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-56** — A abertura é atômica e idempotente: manifestação, respostas, auditoria, timeline e evento no mesmo commit da tramitação; `sequence` é `1..n` por processo; se já houver manifestação `PENDING`/`IN_REVIEW` do processo, nada novo é criado (DEC-200).
- **RN-ICT-57** — Resolução do checklist na abertura: entre as versões `PUBLISHED` com `applicabilityRule` verdadeira para o processo escolhe-se uma; sem nenhuma aplicável usa-se o padrão do tenant (`isDefault`, `internalControl.defaultChecklistKey`); o `checklistId` fica fixado e imutável na manifestação (nova versão publicada depois não altera manifestações abertas). Sem checklist utilizável, a entrada na etapa é recusada com `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE` (DEC-200; ver lacunas 2 e 3).
- **RN-ICT-58** — Na abertura criam-se exatamente uma `InternalControlChecklistAnswer` `PENDING` por item do checklist fixado (`itemKey` = chave do item), sem nota nem evidência; o conjunto de itens não muda depois (DEC-200).
- **RN-ICT-59** — `warningsOverriddenCount` = número de avisos `WARNING` reconhecidos (`warningsAcknowledged`) nas movimentações do processo até a abertura, congelado na abertura; a lista da visão de riscos é lida ao vivo e pode ter mais itens que o congelado (selo "novos desde a abertura") (DEC-200, DEC-016).
- **RN-ICT-60** — A visão de riscos é somente leitura e composta por: mapa de riscos (`Risk` do processo, resumo por nível e lista ordenada por pontuação), documento `RISK_MAP` vigente (versão para abrir), avisos superados (regra, mensagem gravada, ator, data, etapa), parecer jurídico considerado (situação, ressalvas abertas, versão), e achados abertos de manifestações anteriores. Nenhum valor de orçamento sigiloso aparece (DEC-030, POL-09); texto livre só é mostrado a quem pode ver o processo.
- **RN-ICT-61** — Quem inicia: `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo, sem conflito de independência (autor de documento, aprovador ou procurador do processo → `INTERNAL_CONTROL_SEGREGATION`) e que seja (a) o `assigneeId`, (b) titular/substituto da unidade da etapa ou (c) pessoa lotada na unidade do Controle Interno quando a análise não tem `assigneeId` ("assumir da fila"); caso contrário `NOT_INTERNAL_CONTROL_ASSIGNEE`. O início atribui `assigneeId` ao iniciador apenas quando estiver vazio; nunca troca o responsável já designado (POL-20; ver lacuna 5).
- **RN-ICT-62** — Fila (ICT-08): lista as manifestações cobertas pelo escopo de `INTERNAL_CONTROL_REVIEW_VIEW` e pela visibilidade do processo (DEC-024); padrão `status IN (PENDING, IN_REVIEW)` e `inStage = true`; ordenação por prazo da etapa (mais antigo primeiro, sem prazo por último) e depois por entrada; paginação por cursor; `meta.counts` com contagens das abas; nenhum valor monetário nem prioridade derivada de orçamento (DEC-030).
- **RN-ICT-63** — Rodadas: a manifestação `IN_REVIEW` cujo processo é devolvido mantém o status; na volta o `currentRound` incrementa em 1, `currentProcessStageId` aponta a nova passagem e a linha de base de versões é regravada; respostas e achados persistem. Manifestação `PENDING` não muda de rodada (RN-ICT-18).
- **RN-ICT-64** — Processo ou ramo cancelado cancela a manifestação `PENDING`/`IN_REVIEW`: `status = CANCELED`, `canceledAt` e `cancellationReason` (`PROCESS_CANCELED` ou `BRANCH_CANCELED`); respostas, achados e o documento em rascunho são preservados; nenhuma ação de escrita vale depois (RN-ICT-19, RN-ICT-41).
- **RN-ICT-65** — Leitura: ICT-09 exige `INTERNAL_CONTROL_REVIEW_VIEW` cobrindo o processo (o `AUDITOR` lê pela trilha); quem tem só `PROCESS_VIEW` lê o painel somente de manifestação concluída ou cancelada. ICT-11 exige `PROCESS_VIEW`; com a análise `PENDING`/`IN_REVIEW`, quem não tem `INTERNAL_CONTROL_REVIEW_VIEW` recebe só situação, rodada, responsável, datas e avanço, sem respostas, achados, notas nem visão de riscos (escolha conservadora; ver lacuna 6).
- **RN-ICT-66** — Derivados calculados na leitura, sem persistir: `progress` (respostas obrigatórias diferentes de `PENDING` sobre o total de obrigatórias, e total geral), contagem de achados por criticidade e situação, `meta.actions` (`canStart`, `canManage`, `canConclude` e o motivo quando falso) e `newerVersionAvailable` por documento da aba Documentos.
- **RN-ICT-67** — A abertura notifica o titular e o substituto da unidade do Controle Interno da etapa (`INTERNAL_CONTROL_QUEUED`, in-app, sem e-mail); iniciar, rodada nova e cancelamento não geram notificação nesta story (events.md §6); a timeline registra a abertura.
- **RN-ICT-68** — Cada manifestação é independente: a nova (`sequence + 1`) não herda respostas nem achados da anterior; os achados `OPEN` de manifestações anteriores do mesmo processo são exibidos como contexto e continuam sob a US-162.
- **RN-ICT-69** — Linha de base: ao iniciar e a cada rodada nova grava-se em `reviewedDocumentVersionIds` o conjunto das versões vigentes (`Document.currentVersionId`) dos documentos do processo dos tipos `DFD`, `ETP`, `RISK_MAP`, `PRICE_RESEARCH`, `TR`, `EDITAL`, `MINUTA_CONTRATO` e `PARECER_JURIDICO` finalizado; `MANIFESTACAO_CONTROLE_INTERNO` nunca entra. A US-161 compara esse conjunto com as versões vigentes na conclusão (RN-ICT-46) e o substitui pelas versões analisadas (RN-ICT-16; ver lacuna 1).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Manifestação | `id` (path) | uuid | Sim | `InternalControlReview` do tenant | rota |
| Versão da análise | `If-Match` (ETag) | texto | Sim (ICT-10) | ETag da análise | `meta.etag` de ICT-09 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (ICT-10) | 24 h | gerada pelo front |
| Situação (filtro) | `status[]` | `InternalControlReviewStatus` multi | Não | padrão `PENDING`, `IN_REVIEW` | — |
| Responsável (filtro) | `assigneeId` / `assignee=me` / `unassigned=true` | uuid / literal / boolean | Não | RN-ICT-62 | — |
| Fora da etapa (filtro) | `inStage` | boolean | Não | padrão `true` | — |
| Busca | `q` | texto (até 100) | Não | número do processo ou trecho do objeto | — |
| Paginação | `cursor`, `limit` | texto, inteiro | Não | `limit` 1–100, padrão 25 | servidor |
| *(saída)* Situação | `status` | `InternalControlReviewStatus` | — | `IN_REVIEW` após o início | derivado |
| *(saída)* Rodada | `currentRound` | smallint | — | RN-ICT-63 | servidor |
| *(saída)* Checklist fixado | `checklist { id, key, versionNumber, name }` | objeto | — | imutável (RN-ICT-57) | abertura |
| *(saída)* Itens e respostas | `items[]` (com `answer`, `note`, `evidenceDocumentVersionId`, `suggestedAnswer?`) | lista | — | respostas escritas na US-160 | `ChecklistItem` + resposta |
| *(saída)* Avisos superados | `warningsOverriddenCount`, `riskView.overriddenWarnings[]` | inteiro / lista | — | RN-ICT-59 | abertura / movimentações |
| *(saída)* Visão de riscos | `riskView { summary, risks[], riskMapDocument, legalOpinion, previousOpenFindings[] }` | objeto | — | RN-ICT-60 | leitura ao vivo |
| *(saída)* Avanço | `meta.progress` | objeto | — | RN-ICT-66 | derivado |
| *(saída)* Ações | `meta.actions` | objeto | — | RN-ICT-66 | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `If-Match` ausente em ICT-10 | API | "Atualize a página e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-02 | `If-Match` divergente da ETag da análise | API | "Esta análise foi alterada por outra pessoa. Atualize a página." | `VERSION_CONFLICT` (412) |
| V-03 | Análise fora de `PENDING` | API | "Esta análise já foi iniciada ou encerrada." | `INVALID_STATE` (409) |
| V-04 | Processo fora de `IN_PROGRESS` ou sem a etapa `CONTROLE_INTERNO` ativa | API | "O processo não está disponível para análise no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-05 | Conflito de independência (autor, aprovador ou procurador do processo) | API | "Você atuou neste processo e não pode manifestar sobre ele." | `INTERNAL_CONTROL_SEGREGATION` (403) |
| V-06 | Usuário não é o designado, titular/substituto nem lotado na unidade (análise sem designação) | API | "Esta análise está designada a outra pessoa." | `NOT_INTERNAL_CONTROL_ASSIGNEE` (403) |
| V-07 | Filtros da fila inválidos (`status`, `limit`, `cursor`, `q`) | API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` |
| V-08 | Nenhum checklist publicado aplicável ou padrão na abertura | API (tramitação) | "Não há checklist do Controle Interno publicado. Peça ao administrador do órgão que publique um." | `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE` (409) |
| V-09 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `INTERNAL_CONTROL_REVIEW_VIEW` (fila e painel — ICT-08, ICT-09) com escopo que cubra o processo; `INTERNAL_CONTROL_REVIEW_MANAGE` (iniciar — ICT-10); `PROCESS_VIEW` (aba do processo — ICT-11; painel de análise concluída ou cancelada); `AUDITOR` com `AUDIT_VIEW` lê painel e trilha.
- **Políticas:** POL-20 (leitura ampla, independência e designação), DEC-024 (visibilidade do processo), POL-09 (orçamento sigiloso), POL-03 (processo editável para iniciar).
- **MFA:** `INTERNAL_CONTROL_REVIEW_MANAGE` tem risco `M`, portanto MFA apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** a UI oculta "Iniciar análise" e o item de menu "Controle Interno" sem `INTERNAL_CONTROL_REVIEW_VIEW`; a API responde 403 `PERMISSION_DENIED`, `INTERNAL_CONTROL_SEGREGATION` ou `NOT_INTERNAL_CONTROL_ASSIGNEE` e grava `access.denied`; análise de outro tenant ou de processo invisível responde 404 `INTERNAL_CONTROL_REVIEW_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `InternalControlReviewOpened` | `internal_control_review.opened` | Entrada em `CONTROLE_INTERNO` (e volta do processo, com `round` ≥ 2 — lacuna 4) | `reviewId`, `sequence`, `processStageId`, `checklistKey`, `checklistVersion`; timeline `INTERNAL_CONTROL_OPENED`, notificação `INTERNAL_CONTROL_QUEUED`, read model; sem valores de orçamento |
| `InternalControlReviewStarted` | `internal_control_review.started` | Commit de ICT-10 | `reviewId`, `round`; consumidores T (timeline) e R (read model); sem notificação |
| `InternalControlReviewCanceled` | `internal_control_review.canceled` | Cancelamento do processo ou do ramo | `reviewId`, `reason` (`PROCESS_CANCELED`, `BRANCH_CANCELED`); consumidores T e R |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `INTERNAL_CONTROL_QUEUED` | Titular e substituto da unidade do Controle Interno da etapa | in-app (sem e-mail) | `InternalControlReviewOpened` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Abrir a manifestação e painel do Controle Interno com visão de riscos

  Background:
    Given que o tenant "Prefeitura A" está ativo com a nova versão do workflow adotada
    And o checklist "FASE_PREPARATORIA" v1 está "PUBLISHED" como padrão, com 12 itens dos quais 10 obrigatórios
    And "Renata Prado" tem vínculo ativo no perfil "CONTROLE_INTERNO" com "INTERNAL_CONTROL_REVIEW_VIEW" e "INTERNAL_CONTROL_REVIEW_MANAGE", é lotada na unidade do Controle Interno e não atuou no processo "0045/2026"
    And "Dr. Otávio" é o titular da unidade do Controle Interno
    And o processo "0045/2026" tem 5 riscos no mapa de riscos e 2 avisos "WARNING" reconhecidos na tramitação
    And o parecer jurídico "PJ 0007/2026" está concluído como "FAVORABLE"

  Scenario: [Sucesso] Abertura automática na entrada da etapa
    When o processo "0045/2026" for encaminhado para a etapa "CONTROLE_INTERNO"
    Then deve existir uma manifestação "PENDING" na rodada 1 com "sequence" 1 e "warningsOverriddenCount" igual a 2
    And o checklist "FASE_PREPARATORIA" v1 deve estar fixado e devem existir 12 respostas "PENDING", uma por item
    And deve gerar a auditoria "internal_control_review.open", o evento "InternalControlReviewOpened" e a entrada de timeline "INTERNAL_CONTROL_OPENED"
    And "Dr. Otávio" e o substituto devem receber a notificação "INTERNAL_CONTROL_QUEUED"
    And a abertura e o encaminhamento devem ter sido gravados na mesma transação

  Scenario: [Sucesso] Painel com a visão de riscos
    Given que a manifestação do processo "0045/2026" está "PENDING"
    When "Renata Prado" chamar "GET /internal-control/reviews/{id}"
    Then a API deve responder 200 com o cabeçalho, os 12 itens, "meta.progress" e "meta.etag"
    And "riskView.risks" deve listar os 5 riscos ordenados por pontuação, com nível, tratamentos e responsável
    And "riskView.overriddenWarnings" deve listar 2 avisos com regra, mensagem, autor e data
    And "riskView.legalOpinion" deve mostrar "PJ 0007/2026" como "FAVORABLE"
    And nenhum valor de orçamento sigiloso deve aparecer na resposta

  Scenario: [Sucesso] Iniciar a análise assumindo a manifestação
    Given que a manifestação está "PENDING" e sem responsável
    When "Renata Prado" iniciar a análise com o "If-Match" atual
    Then a API deve responder 200 com status "IN_REVIEW", "assigneeId" de "Renata Prado" e "startedAt" preenchido
    And "reviewedDocumentVersionIds" deve conter as versões vigentes do DFD, ETP, mapa de riscos, pesquisa de preços, TR e do parecer "PJ 0007/2026"
    And deve gerar a auditoria "internal_control_review.start" e o evento "InternalControlReviewStarted"

  Scenario: [Sucesso] Fila do Controle Interno com filtros
    Given que existem 3 manifestações "PENDING" e 2 "IN_REVIEW" no tenant, uma delas de "Renata Prado"
    When "Dr. Otávio" chamar "GET /internal-control/reviews" com "unassigned" "true"
    Then a API deve responder 200 apenas com as manifestações sem responsável, ordenadas pelo prazo da etapa
    And "meta.counts" deve trazer "pending", "inReview", "mine" e "unassigned"
    And nenhuma linha deve conter valor monetário

  Scenario: [Sucesso] Processo devolvido e retornado abre a rodada seguinte
    Given que a manifestação está "IN_REVIEW" na rodada 1 com 4 respostas e 1 achado "OPEN"
    When o processo for devolvido para "PLANEJAMENTO" e encaminhado de novo para "CONTROLE_INTERNO"
    Then a manifestação deve continuar "IN_REVIEW" com "currentRound" igual a 2 e as 4 respostas e o achado preservados
    And "reviewedDocumentVersionIds" deve refletir as versões vigentes na volta
    And não deve existir uma segunda manifestação aberta do processo

  Scenario: [Sucesso] Aba "Controle Interno" do processo
    Given que a manifestação está "IN_REVIEW" com "Renata Prado" como responsável
    When "Carla Mendes", requisitante com "PROCESS_VIEW", chamar "GET /processes/{id}/internal-control"
    Then a API deve responder 200 com situação, rodada, responsável e avanço
    And a resposta não deve conter respostas, achados, notas nem visão de riscos
    When "Renata Prado" chamar a mesma rota
    Then a resposta deve incluir os achados e o histórico de manifestações

  Scenario: [Sucesso] Cancelamento com o processo
    Given que a manifestação está "IN_REVIEW" e o documento da manifestação existe em "DRAFT"
    When o processo "0045/2026" for cancelado
    Then a manifestação deve ficar "CANCELED" com motivo "PROCESS_CANCELED"
    And respostas, achados e o documento em rascunho devem ser preservados
    And deve gerar o evento "InternalControlReviewCanceled" e a auditoria "internal_control_review.cancel"

  Scenario: [Validação] Início fora do estado ou do processo e filtros inválidos
    Given que a manifestação já está "IN_REVIEW"
    When "Renata Prado" chamar "POST /internal-control/reviews/{id}/start"
    Then a API deve responder 409 com código "INVALID_STATE"
    Given que o processo está "SUSPENDED" e a manifestação "PENDING"
    When "Renata Prado" tentar iniciar a análise
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"
    When "Renata Prado" chamar "GET /internal-control/reviews" com "limit" 500
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Renata Prado" chamar "POST /internal-control/reviews/{id}/start" sem "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"

  Scenario: [Validação] Entrada na etapa sem checklist publicado
    Given que o tenant não tem nenhum checklist "PUBLISHED" aplicável nem padrão
    When "Paula Souza" encaminhar o processo "0046/2026" para "CONTROLE_INTERNO"
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE"
    And o processo deve continuar na etapa anterior e nenhuma manifestação deve ser criada

  Scenario: [Permissão] Sem permissão, sem independência e sem designação
    Given que "Paulo Dias" não tem "INTERNAL_CONTROL_REVIEW_MANAGE"
    When "Paulo Dias" chamar "POST /internal-control/reviews/{id}/start"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que "Marcos Lima" tem as permissões, mas foi aprovador do DFD do processo
    When "Marcos Lima" tentar iniciar a análise
    Then a API deve responder 403 com código "INTERNAL_CONTROL_SEGREGATION"
    Given que a manifestação está designada a "Renata Prado" e "Bruno Lopes" tem as permissões, sem ser titular nem substituto
    When "Bruno Lopes" tentar iniciar a análise
    Then a API deve responder 403 com código "NOT_INTERNAL_CONTROL_ASSIGNEE"
    Given que a manifestação está "IN_REVIEW" e "Carla Mendes" tem apenas "PROCESS_VIEW"
    When "Carla Mendes" chamar "GET /internal-control/reviews/{id}"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Manifestação de outro tenant
    Given que existe a manifestação "0031/2026" da "Prefeitura B"
    When "Renata Prado", da "Prefeitura A", chamar "GET /internal-control/reviews/{id-da-Prefeitura-B}"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    When "Renata Prado" chamar "POST /internal-control/reviews/{id-da-Prefeitura-B}/start"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    And a fila da "Prefeitura A" não deve conter manifestações da "Prefeitura B"
    And a visão de riscos não deve expor riscos nem avisos de processos da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio do início e reentrada na etapa
    Given que "Renata Prado" iniciou a análise com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único evento "InternalControlReviewStarted" e uma única auditoria "internal_control_review.start"
    Given que já existe manifestação "PENDING" do processo "0045/2026"
    When o listener de entrada na etapa for executado de novo para a mesma passagem
    Then não deve ser criada outra manifestação nem repetidos o evento "InternalControlReviewOpened" e a notificação

  Scenario: [Concorrência] Início simultâneo e ETag desatualizada
    When "Renata Prado" e "Dr. Otávio" iniciarem a mesma análise ao mesmo tempo
    Then exatamente um início deve responder 200
    And o outro deve responder 409 com código "INVALID_STATE" ou 412 com código "VERSION_CONFLICT"
    And deve existir um único evento "InternalControlReviewStarted"
    Given que "Renata Prado" carregou o painel com a ETag "E1" e a análise mudou em outra aba
    When ela iniciar com "If-Match" "E1"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e a UI deve recarregar o painel

  Scenario: [Falha de banco] Falha ao gravar a abertura ou o início
    Given que o banco de dados fica indisponível durante a transação de "POST /internal-control/reviews/{id}/start"
    When "Renata Prado" confirmar o início
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "PENDING" sem auditoria, evento nem linha de base gravados
    Given que a gravação da manifestação falha durante o encaminhamento do processo para "CONTROLE_INTERNO"
    Then o encaminhamento inteiro deve ser revertido e o processo deve continuar na etapa anterior

  Scenario: [Falha de integração] Broker de eventos indisponível
    Given que o broker de mensagens está indisponível
    When o processo "0045/2026" entrar em "CONTROLE_INTERNO"
    Then a manifestação deve ser gravada com o evento "InternalControlReviewOpened" no outbox para publicação posterior
    And a timeline e a notificação "INTERNAL_CONTROL_QUEUED" devem ocorrer quando o outbox for publicado
    And deve ser registrado log "warn" "outbox.publish_delayed"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta a ação; mensagem se acessada por link |
| Conflito de independência | 403 | `INTERNAL_CONTROL_SEGREGATION` | "Você atuou neste processo e não pode manifestar sobre ele." | Desabilita o botão e orienta pedir ao titular |
| Análise designada a outra pessoa | 403 | `NOT_INTERNAL_CONTROL_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Mostra o responsável |
| Análise inexistente ou de outro tenant | 404 | `INTERNAL_CONTROL_REVIEW_NOT_FOUND` | "Análise não encontrada." | Volta à fila |
| Análise fora de `PENDING` | 409 | `INVALID_STATE` | "Esta análise já foi iniciada ou encerrada." | Recarrega o painel |
| Processo suspenso, cancelado ou fora da etapa | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para análise no momento." | Botão desabilitado com o motivo |
| Sem checklist publicado ao entrar na etapa | 409 | `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE` | "Não há checklist do Controle Interno publicado. Peça ao administrador do órgão que publique um." | Exibido no encaminhamento do processo |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Esta análise foi alterada por outra pessoa. Atualize a página." | Recarrega o painel |
| Filtros inválidos | 422 | `VALIDATION_ERROR` | "Filtro inválido." | Restaura filtros padrão |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível iniciar agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-033 (registro de riscos — base da visão de riscos), US-047 (encaminhamento do processo, onde a ciência dos avisos `WARNING` é gravada — L-08), US-158 (checklists publicados e padrão do tenant). Indiretas: US-066/US-062 (versões e lista de documentos para a linha de base), US-055 (prazo da etapa), US-059 (timeline), US-125 (SCR-006 ampliado), US-155 (parecer jurídico concluído lido na visão de riscos), US-129 (`RuleContext` v2 — provedor `internalControl` publicado na US-161).
- **Decisões/ADRs:** DEC-016, DEC-024, DEC-030, DEC-194, DEC-196, DEC-199, DEC-200, ADR-008.
- **Configurações:** `internalControl.defaultChecklistKey` (padrão `FASE_PREPARATORIA`), `InternalControlChecklist.applicabilityRule` e `isDefault` (US-158).
- **Lacunas nas fontes canônicas:**
  1. **Linha de base das versões analisadas** (RN-ICT-69): `entities.md` só define `reviewedDocumentVersionIds` "na conclusão"; a US-161 (RN-ICT-46) compara versões "desde o início da rodada" sem coluna ou tabela que as guarde. Proposta adotada: regravar `reviewedDocumentVersionIds` no início de cada rodada e substituí-la na conclusão; alternativa: tabela `internal_control_review_documents` análoga a `LegalReviewDocument`. **Dúvida de produto/arquitetura.**
  2. **Entrada sem checklist utilizável** (`INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE`, FA-02): nenhuma fonte diz o que acontece. Proposta: recusar o encaminhamento (a US-158 deveria impedir aposentar o último padrão e o seed garante `FASE_PREPARATORIA` v1); alternativa: abrir sem checklist, o que `checklistId NOT NULL` não permite. **Dúvida de produto.**
  3. **Escolha entre vários checklists aplicáveis:** `entities.md` e DEC-200 dizem "regra de aplicabilidade, senão o padrão" sem desempate quando mais de uma regra é verdadeira. Proposta: a versão publicada mais recentemente; o `applicabilityRule` é avaliado com o `RuleContext` v2 (US-129, não listada em `depends_on`; a avaliação é entregue pela resolução de checklist da US-158). Confirmar o desempate com o piloto.
  4. **Rodada nova sem evento próprio:** `events.md` não tem equivalente de `LegalReviewResumed` para o Controle Interno nem tipo de timeline para início, rodada e cancelamento (`InternalControlReviewStarted` e `InternalControlReviewCanceled` têm consumidor T, mas só `INTERNAL_CONTROL_OPENED`, `_CONCLUDED` e `_FINDING_RESOLVED` estão catalogados). Proposta: `InternalControlReviewOpened` com `round` no payload ("Processo voltou à análise do Controle Interno (rodada {round})") e tipos `INTERNAL_CONTROL_STARTED` e `INTERNAL_CONTROL_CANCELED`.
  5. **Quem pode iniciar:** POL-20 reconhece só o `assigneeId` e o titular/substituto, e não há story de distribuição do Controle Interno (a US-150 é do jurídico). A RN-ICT-61(c) ("assumir da fila" por quem é lotado na unidade) é proposta desta story; também **não há redistribuição** de análise `IN_REVIEW` (a US-161 FA-05 manda pedir ao titular). **Dúvida de produto.**
  6. **Leitura do trabalho em andamento por `PROCESS_VIEW`:** `permissions.md` restringe só o rascunho da manifestação (POL-24); a RN-ICT-65 estende a restrição a respostas, achados e visão de riscos enquanto a análise está `PENDING`/`IN_REVIEW`. **Dúvida de produto.**
  7. **Códigos e ações novos a consolidar no card 9:** `INTERNAL_CONTROL_REVIEW_NOT_FOUND`, `NOT_INTERNAL_CONTROL_ASSIGNEE`, `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE`; auditoria `internal_control_review.open` (ausente da matriz de `events.md`); parâmetros de lista (`inStage`, `unassigned`, `meta.counts`) e o objeto `riskView` de ICT-09. `INTERNAL_CONTROL_SEGREGATION` já existe (POL-20).

## Impacto técnico
- Maior story do épico: toca a tramitação (porta `StageLifecycleListener`), leitura de quatro módulos (`risk`, `process`, `document`, `legal-review`) e a fila/painel de uma tela nova; por isso a estimativa **L**.
- A abertura roda dentro da transação do encaminhamento, que já é a mais sensível do MVP 1 (US-047); a inserção da manifestação e de até 200 respostas deve ficar em lote único (insert múltiplo) para não degradar o p95 do encaminhamento.
- A visão de riscos é uma leitura agregada somente para leitura via fachadas (`RiskFacade`, `LegalReviewFacade`, `ProcessFacade`, `DocumentFacade`); cada bloco carrega com limite (riscos ordenados por pontuação, avisos por data) e o painel degrada o bloco que falhar sem derrubar o restante.
- Índices: `(tenant_id, status, created_at)` e `(tenant_id, assignee_id) WHERE status IN ('PENDING','IN_REVIEW')` sustentam a fila; unique parcial garante uma só manifestação aberta por processo mesmo sob concorrência de ramos.
- Compatibilidade: rotas novas, eventos com `eventVersion = 1`, nenhuma rota do MVP 1 muda de contrato; o campo aditivo `meta.conclusionChecklist[]` entra em ICT-09 na US-161.

## Backend
- **Módulo(s):** `internal-control` (dono), `process` (porta `StageLifecycleListener`, movimentações, prazo), `risk` (leitura), `legal-review` (leitura), `document` (versões vigentes), `workflow`, `notification`, `timeline`, `audit`.
- **Casos de uso:** `OpenInternalControlReviewCommand` (listener), `ReopenInternalControlRoundCommand` (volta do processo), `CancelInternalControlReviewCommand` (processo/ramo cancelado), `StartInternalControlReviewCommand` (ICT-10), `ListInternalControlReviewsQuery` (ICT-08), `GetInternalControlReviewQuery` (ICT-09), `GetProcessInternalControlQuery` (ICT-11), `BuildRiskViewQuery`.
- **Domínio:** `InternalControlReview` (máquina de estados e invariantes da §4.4/§6.5), `ChecklistResolver` (consome US-158), `ReviewIndependencePolicy` (POL-20), `RiskViewAssembler`, `DocumentBaselineSnapshot`.
- **Integrações internas:** `ProcessFacade` (movimentações, autoria, aprovações, designações, prazo da etapa), `RiskFacade`, `LegalReviewFacade`, `DocumentFacade`, `OutboxWriter`, `AuditService`, `StageLifecycleListener`.
- **Transação:** abertura = parte da transação da tramitação (manifestação, respostas, auditoria, outbox, timeline); início = trava da análise → validações → atribuição e linha de base → auditoria → outbox → commit; notificação e demais efeitos fora da transação.

## Frontend
- **Tela(s):** SCR-020 (`/controle-interno` e `/controle-interno/[reviewId]`), SCR-006 (aba "Controle Interno").
- **Componentes:** `InternalControlQueueTable` (abas e filtros), `ReviewHeader`, `RiskOverviewPanel` (matriz e lista), `OverriddenWarningsList`, `LegalOpinionCard`, `ChecklistProgress`, `StartReviewDialog`, `ProcessInternalControlTab`.
- **Estados:** skeleton, vazio ("Nenhuma manifestação na fila"), erro com "Tentar novamente", bloco da visão de riscos indisponível com recarga isolada, sucesso com atualização da ETag.
- **Acessibilidade e responsividade:** situação, nível de risco e criticidade com texto e ícone (nunca só cor); tabela com cabeçalhos associados e ordenação por teclado; abas com `role="tablist"`; diálogo com foco preso; lista em cartões abaixo de 768 px.

## Banco de dados
- **Tabelas:** `internal_control_reviews`, `internal_control_checklist_answers`, `internal_control_checklists` (leitura); leitura de `risks`, `risk_treatments`, `process_movements`, `documents`, `document_versions`, `legal_reviews`.
- **Migrações:** nenhuma além da M2 do módulo (tabelas da §4.4, índices e trigger de imutabilidade); semente do checklist `FASE_PREPARATORIA` v1 (US-158); ajuste do check de `canceled_at`/`cancellation_reason` quando `status = CANCELED`.
- **Índices/constraints relevantes:** `(tenant_id, process_id, sequence)` único; `(tenant_id, process_id) WHERE status IN ('PENDING','IN_REVIEW')` único; `(tenant_id, status, created_at)`; `(tenant_id, assignee_id) WHERE status IN ('PENDING','IN_REVIEW')`; `(tenant_id, review_id, item_key)` único nas respostas; FKs compostas com o tenant e RLS `FORCE`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ICT-08` | GET | `/api/v1/internal-control/reviews` | filtros `status[]`, `assigneeId`, `assignee=me`, `unassigned`, `inStage`, `q`, `cursor`, `limit` | `200 { data: ReviewListItem[], meta { nextCursor, counts } }` | 200, 403, 422 |
| `ICT-09` | GET | `/api/v1/internal-control/reviews/{id}` | path `id` | `200 { data: { review, checklist, items[], findings[], riskView, documents[] }, meta { etag, progress, actions } }` | 200, 403, 404 |
| `ICT-10` | POST | `/api/v1/internal-control/reviews/{id}/start` | `If-Match` + `Idempotency-Key` | `200 { data: InternalControlReview }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `ICT-11` | GET | `/api/v1/processes/{id}/internal-control` | path `id` | `200 { data: { current, history[] } }` (detalhe conforme RN-ICT-65) | 200, 403, 404 |
| `RSK-09` | GET | `/api/v1/processes/{id}/risk-matrix` | MVP 1 (atalho "Abrir matriz de riscos") | MVP 1 | 200, 403, 404 |
| `DOC-17` | GET | `/api/v1/document-versions/{versionId}` | MVP 1 (abrir versão do documento) | MVP 1 | 200, 403, 404 |

## Logs
- `info` `internal_control.review_opened` — `reviewId`, `processId`, `checklistKey`, `checklistVersion`, `warningsOverriddenCount`, `round`, `correlationId`.
- `info` `internal_control.review_started` — `reviewId`, `round`, `assigned` (booleano), `durationMs`.
- `info` `internal_control.review_canceled` — `reviewId`, `reason`.
- `warn` `internal_control.start_rejected` — `reviewId`, `errorCode`; `warn` `internal_control.checklist_not_available` — `processId`, `tenantId`; `warn` `outbox.publish_delayed`.
- `warn` `internal_control.risk_view_block_failed` — `reviewId`, `block` (`risks`, `warnings`, `legalOpinion`).
- **Nunca logar:** objeto da contratação, texto de riscos, mensagens de avisos, valores de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `internal_control_review.open` | `WORKFLOW` | Abertura e rodada nova (ator `SYSTEM`) | `changes` de `status`; `metadata`: `processStageId`, `checklistId`, `round`, `warningsOverriddenCount` |
| `internal_control_review.start` | `WORKFLOW` | Commit de ICT-10 | `changes` de `status`/`assigneeId`; `metadata`: `round`, `assigned`, `baselineCount`, `idempotencyKey` |
| `internal_control_review.cancel` | `WORKFLOW` | Cancelamento com o processo ou ramo | `changes` de `status`; `metadata`: `reason` |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `reviewId` |

## Testes necessários
- **Unitários:** `ChecklistResolver` (aplicável, padrão, nenhum, desempate), criação das respostas por item, `RiskViewAssembler` (riscos, avisos superados, parecer, ausência), `ReviewIndependencePolicy` (autor, aprovador, procurador), regra de quem inicia (a/b/c), cálculo de `progress` e `meta.actions`, máquina de estados (início, rodada, cancelamento).
- **Integração (Testcontainers):** abertura dentro do encaminhamento (US-047) com rollback conjunto; unique de manifestação aberta sob concorrência; rodada nova na volta; cancelamento com processo e ramo; ICT-08/09/10/11 ponta a ponta com RLS; leitura dos avisos reconhecidos a partir de `process_movements`; linha de base de versões.
- **API/contrato:** corpo, filtros, paginação e erros de ICT-08 a ICT-11; idempotência e `If-Match` de ICT-10; ausência de valores monetários em qualquer resposta.
- **RBAC e multi-tenant:** 403/404 por papel e tenant, `PROCESS_VIEW` × `INTERNAL_CONTROL_REVIEW_VIEW`, independência (POL-20), visibilidade (DEC-024); teste novo na suíte "tenant leak" (fila, painel, visão de riscos, aba do processo).
- **Concorrência:** dois inícios simultâneos; início com ETag antiga; abertura concorrente de ramos.
- **E2E (Playwright):** encaminhar processo para `CONTROLE_INTERNO` → manifestação na fila → abrir painel → ler visão de riscos → iniciar análise → aba do processo mostra "Em análise".
- **Acessibilidade/performance:** axe na fila, no painel e no diálogo de início; p95 da fila < 1,5 s com 5.000 manifestações e do painel < 2 s (suíte de performance, medida no endurecimento).

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
- [ ] Teste prova que a abertura é atômica com o encaminhamento e que há uma só manifestação aberta por processo
- [ ] Teste prova que nenhuma resposta, rota ou regra preenche resposta ou situação automaticamente (sem IA)
- [ ] Decisões do piloto registradas sobre a linha de base de versões, o checklist ausente e quem pode iniciar

## Estimativa
**L** — abertura dentro da tramitação, resolução do checklist, fila, painel com visão de riscos agregada de quatro módulos, início com independência e atribuição, rodadas e cancelamento; o esforço está na integração transacional com o encaminhamento, nas leituras agregadas e na autorização por perfil.

## Prioridade
**P0** — sem a abertura e o painel não há manifestação para responder (US-160) nem concluir (US-161), e a etapa `CONTROLE_INTERNO` da fase preparatória v2 não funciona (DEC-196).
