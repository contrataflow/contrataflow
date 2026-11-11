---
id: US-160
title: "Responder o checklist e registrar achados e recomendações"
epic: EP-026
feature: FT-077
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-159]
modules: [internal-control, risk, document, files, process, timeline, rules, access, audit]
screens: [SCR-020, SCR-006]
endpoints: [ICT-12, ICT-13, ICT-14, ICT-15, ICT-09, ATT-02, ATT-03, DOC-17]
permissions: [INTERNAL_CONTROL_REVIEW_MANAGE, INTERNAL_CONTROL_REVIEW_VIEW, PROCESS_VIEW, ATTACHMENT_UPLOAD]
events: [InternalControlFindingRecorded, InternalControlFindingResolved]
---

# US-160 — Responder o checklist e registrar achados e recomendações

## Título
Responder o checklist item a item e registrar achados e recomendações com criticidade

## Descrição
**Como** analista do Controle Interno com a análise em andamento, **quero** responder cada item do checklist fixado (`COMPLIANT`, `NON_COMPLIANT` ou `NOT_APPLICABLE`) com nota e evidência, anexar os papéis de trabalho e registrar achados e recomendações com criticidade, vinculados ao item e, quando couber, a um risco do mapa, **para** que a manifestação nasça de uma análise rastreável item a item e os problemas encontrados virem itens acompanháveis até o atendimento, em vez de parágrafos soltos.

A story entrega o preenchimento da análise aberta e iniciada na US-159: gravar a resposta de um item (ICT-12), registrar um achado (ICT-13), editá-lo ou **cancelá-lo antes da conclusão** (ICT-14), listá-lo com todos os detalhes (ICT-15) e a subida de papéis de trabalho pelo anexo do MVP 1. Também estende o painel (ICT-09) com as etags por resposta e por achado, a sugestão de resposta por `autoCheck` e os indicadores derivados de pendência. A **sugestão do `autoCheck` nunca preenche resposta sozinha**: a resposta é sempre ato de uma pessoa (DEC-200). Emitir a manifestação e concluir com a situação é da US-161; o atendimento do achado e o risco aceito são da US-162 e da decisão da autoridade.

## Contexto
- DEC-200: o analista responde cada item com `COMPLIANT`, `NON_COMPLIANT` ou `NOT_APPLICABLE`; `NOT_APPLICABLE` e `NON_COMPLIANT` exigem nota; todo item `NON_COMPLIANT` exige achado vinculado antes de concluir (RN-ICT-09). O achado tem criticidade (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) e recomendação opcional; pode apontar para um `Risk` do mapa de riscos.
- As respostas já existem como linhas `PENDING`, uma por item do checklist fixado na abertura (US-159, RN-ICT-58). Esta story só as atualiza; nunca cria nem remove linhas e o conjunto de itens não muda.
- O item do checklist (`ChecklistItem`, `entities.md` §7.6) traz `key`, `group`, `question`, `legalBasis?`, `required`, `evidenceHint?` e `autoCheck?` (`RuleRef` que sugere resposta a partir do `RuleContext` v2 — "nunca preenche sozinha").
- A evidência de uma resposta é uma **versão de documento** (`evidenceDocumentVersionId`, FK para `document_versions`). Os papéis de trabalho são anexos do MVP 1 com `targetType = INTERNAL_CONTROL_REVIEW` (`AttachmentTargetResolver` do módulo `internal-control`, `entities.md` §5.11).
- Independência (POL-20): quem escreve na análise precisa de `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo, ser o `assigneeId` ou o titular/substituto da unidade da etapa e não ter atuado no processo como autor de documento, aprovador ou procurador. O Controle Interno não edita documentos de outros tipos nem decide aprovações.
- A análise concluída é imutável (US-161, RN-ICT-41); antes disso, achados `OPEN` podem ser editados e cancelados pelo Controle Interno. `ADDRESSED` e `RISK_ACCEPTED` não são registrados aqui: o primeiro é da US-162 (custódia) e o segundo da decisão da autoridade em `AUTORIZACAO_LICITACAO` (POL-23).
- Orçamento sigiloso (DEC-030/POL-09): como o texto dos achados é lido por quem pode ver o processo (US-162, RN-ICT-53), notas, títulos, descrições e recomendações são validados contra os campos sigilosos conhecidos; eventos e logs não carregam texto.

## Objetivo
Garantir que 100% das respostas e dos achados sejam gravados com autor, data e vínculos válidos, que o avanço das respostas obrigatórias e os itens `NON_COMPLIANT` sem achado estejam sempre visíveis ao analista, e que gravar uma resposta ou um achado leve p95 < 800 ms, sem que nenhuma regra, integração ou sugestão preencha a análise por conta própria.

## Persona
- **Principal:** Analista do Controle Interno (`CONTROLE_INTERNO`), designado como `assigneeId` da análise, com `INTERNAL_CONTROL_REVIEW_MANAGE` (Renata Prado).
- **Secundárias:** Titular/substituto da unidade do Controle Interno (conduz no lugar do analista, se não houver conflito — Dr. Otávio); Auditor (`AUDITOR`, lê respostas, achados e trilha); Autoridade competente e demais perfis com `PROCESS_VIEW` (leem achados depois da conclusão); responsáveis pela etapa que receberão a recomendação (US-162).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; MFA conforme `security.mfaPolicy` (`INTERNAL_CONTROL_REVIEW_MANAGE` é risco `M`: MFA só com política `ALL`).
- `InternalControlReview` em `IN_REVIEW` (iniciada na US-159), de processo editável (POL-03: não `SUSPENDED`, não em status final), com a etapa `CONTROLE_INTERNO` ativa.
- Usuário com `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo, sem conflito de independência e que seja o `assigneeId` ou titular/substituto da unidade da etapa.
- Para evidência: versões de documentos do mesmo processo com versão salva; para papéis de trabalho: `ATTACHMENT_UPLOAD` e o storage de arquivos disponível.

## Fluxo principal
1. O analista abre o painel (`/controle-interno/[reviewId]`, ICT-09), aba **Checklist**, e vê os itens agrupados por `group`, com pergunta, base legal, indicação de evidência, marcador "obrigatório", resposta atual, avanço (`meta.progress`) e, quando houver, a **sugestão** do `autoCheck` ("Sugestão: não conforme — {motivo}") com o botão "Aplicar sugestão" (apenas preenche o formulário, não grava).
2. Escolhe o item e a resposta (`COMPLIANT`, `NON_COMPLIANT`, `NOT_APPLICABLE`), escreve a nota (obrigatória nas duas últimas) e, opcionalmente, seleciona a versão do documento que serve de evidência na lista "Documentos do processo".
3. O front envia `PUT /internal-control/reviews/{id}/answers/{itemKey}` (ICT-12) com `{ answer, note?, evidenceDocumentVersionId? }`, `If-Match` (etag da resposta, `items[].etag` de ICT-09) e `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id`: trava a resposta; verifica a análise `IN_REVIEW`; confere `If-Match`; autoriza (permissão, independência, designação); valida nota, evidência e conteúdo sigiloso (RN-ICT-71 a RN-ICT-74, RN-ICT-84); grava `answer`, `note`, `evidenceDocumentVersionId`, `answeredById`, `answeredAt`; incrementa a `version` da resposta e da análise; grava a auditoria `internal_control_review.answer_update` e responde 200 com a resposta, a nova ETag da análise e o `progress`.
5. Se a resposta for `NON_COMPLIANT`, o painel marca o item como "sem achado" e oferece **"Registrar achado"**, abrindo o formulário já com o item vinculado.
6. O analista informa título, descrição do achado, criticidade, recomendação (opcional) e, se couber, o item e o risco do mapa de riscos (lista "Riscos do processo", da visão de riscos) e confirma.
7. O front envia `POST /internal-control/reviews/{id}/findings` (ICT-13) com `Idempotency-Key`. A API, em uma transação: trava a análise; valida os campos, o vínculo ao item e ao risco e o conteúdo sigiloso; atribui `sequence = max + 1` sob a trava; cria o achado `OPEN`; recalcula os contadores do `RuleContext` (`internalControl.openFindings`, `openFindingsHighOrCritical`); grava a auditoria `internal_control_review.finding_create`, incrementa a ETag da análise e publica `InternalControlFindingRecorded` (outbox, sem texto). Responde 201.
8. Para anexar um papel de trabalho (planilha, parecer técnico, imagem), o analista usa "Papéis de trabalho" no painel; o front pede a URL de upload (ATT-02, alvo `INTERNAL_CONTROL_REVIEW`) e confirma o envio (ATT-03); o arquivo passa pela verificação de vírus do MVP 1 antes de ficar disponível.
9. Para corrigir um achado, o analista abre "Editar" e envia `PATCH /internal-control/reviews/{id}/findings/{findingId}` (ICT-14) com os campos alterados, `If-Match` (etag do achado) e `Idempotency-Key`; para **cancelar**, usa "Cancelar achado" e informa o motivo (`status = CANCELED`, `cancellationReason`), o que publica `InternalControlFindingResolved` e atualiza os contadores.
10. Em "Achados" (ICT-15) o analista filtra por situação, criticidade, item e risco e confere, antes da US-161, os itens que ainda precisam de resposta ou de achado.
11. O painel atualiza o avanço e a lista de verificação; quando todas as respostas obrigatórias estão preenchidas e todo item `NON_COMPLIANT` tem achado, a aba "Manifestação" (US-161) é liberada para redigir.

## Fluxos alternativos
- **FA-01 — Sugestão do `autoCheck` divergente:** o analista pode responder diferente da sugestão; a divergência não exige justificativa extra e a sugestão não é gravada (RN-ICT-73).
- **FA-02 — Resposta `COMPLIANT` sem nota:** permitida; a nota é opcional nesta resposta (RN-ICT-72).
- **FA-03 — Limpar a resposta:** `answer = PENDING` desfaz a resposta (zera nota, evidência, autor e data); só vale enquanto a análise está `IN_REVIEW` (RN-ICT-71).
- **FA-04 — Item mudou de `NON_COMPLIANT` para `COMPLIANT` com achado vinculado:** a resposta é gravada e o achado continua `OPEN`; o painel avisa "Este achado está vinculado a um item conforme. Revise ou cancele o achado." (RN-ICT-78).
- **FA-05 — Achado sem item:** achado geral do processo (`checklistItemKey` nulo) é permitido; não satisfaz a exigência de nenhum item `NON_COMPLIANT` (RN-ICT-77).
- **FA-06 — Cancelar o único achado de um item `NON_COMPLIANT`:** o cancelamento é aceito e o painel volta a marcar o item "sem achado"; a conclusão (US-161) exigirá um novo achado (RN-ICT-78, RN-ICT-81).
- **FA-07 — Achado já resolvido:** editar ou cancelar achado `ADDRESSED`, `RISK_ACCEPTED` ou `CANCELED` responde 409 `FINDING_NOT_OPEN` (RN-ICT-82).
- **FA-08 — Análise ainda `PENDING`:** escrever responde 409 `INVALID_STATE`; o painel orienta "Inicie a análise antes de responder." (RN-ICT-70).
- **FA-09 — Análise concluída ou cancelada:** toda escrita responde 409 `INVALID_STATE`; leituras seguem disponíveis (RN-ICT-83).
- **FA-10 — Rodada nova:** respostas e achados abertos da rodada anterior permanecem; evidências cuja versão ficou para trás aparecem com "há versão mais recente (vN)" e a resposta continua válida até o analista revisá-la (RN-ICT-89).
- **FA-11 — Documento usado como evidência foi excluído ou ocultado:** a versão é imutável e continua referenciada; o painel exibe o título e o status, e o conteúdo segue as regras de leitura do documento (DOC-17, POL-09/POL-24).
- **FA-12 — Risco do mapa excluído depois do vínculo:** o achado mantém o `riskId` e o painel mostra "Risco removido do mapa"; o vínculo pode ser trocado pela edição (RN-ICT-77).
- **FA-13 — Processo suspenso:** escrita bloqueada com 409 `INVALID_PROCESS_STATUS`; leituras seguem (POL-03).

## Regras de negócio
- **RN-ICT-09** — `NOT_APPLICABLE` e `NON_COMPLIANT` exigem nota; todo item `NON_COMPLIANT` exige achado vinculado antes de concluir (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-17** — Achado `ADDRESSED` ou `RISK_ACCEPTED` exige resposta; `RISK_ACCEPTED` só é registrado pela autoridade com motivação na decisão de `AUTORIZACAO_LICITACAO`, e `CANCELED` só pelo Controle Interno antes da conclusão (DEC-200). *(regra da feature, adotada: esta story trata o cancelamento)*
- **RN-ICT-20** — Não há geração por IA na manifestação, nas respostas nem nos achados (DEC-200, DEC-202). *(regra da feature, adotada)*
- **RN-ICT-70** — Escrever (ICT-12, ICT-13, ICT-14 e papéis de trabalho) exige: análise `IN_REVIEW`, `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo, independência (autor de documento, aprovador ou procurador do processo → `INTERNAL_CONTROL_SEGREGATION`) e ser o `assigneeId` ou o titular/substituto da unidade da etapa (`NOT_INTERNAL_CONTROL_ASSIGNEE`); análise `PENDING` responde `INVALID_STATE` (POL-20).
- **RN-ICT-71** — A resposta de um item é uma de `PENDING` (limpar), `COMPLIANT`, `NON_COMPLIANT` ou `NOT_APPLICABLE`; `itemKey` deve existir no checklist fixado da análise (`INTERNAL_CONTROL_ITEM_NOT_FOUND`); gravar registra `answeredById` e `answeredAt` do usuário; a mesma resposta reenviada sem mudança é um no-op (RN-ICT-87).
- **RN-ICT-72** — A nota é obrigatória em `NON_COMPLIANT` e `NOT_APPLICABLE` (10 a 2.000 caracteres) e opcional em `COMPLIANT`; em `PENDING` é descartada (RN-ICT-09).
- **RN-ICT-73** — A sugestão do `autoCheck` é calculada na leitura (`suggestedAnswer`, `suggestionReason`) a partir do `RuleContext` v2 e **nunca** é gravada nem aplicada sozinha; item sem `autoCheck` ou com regra indisponível não traz sugestão, sem erro (DEC-200, `entities.md` §7.6).
- **RN-ICT-74** — A evidência (`evidenceDocumentVersionId`) deve ser versão de documento do mesmo processo e tenant, de qualquer tipo, exceto `MANIFESTACAO_CONTROLE_INTERNO`; a leitura devolve o indicador derivado `evidenceOutdated`/`newerVersionNumber` quando a versão vigente do documento é outra (não persistido).
- **RN-ICT-75** — Papéis de trabalho são anexos `targetType = INTERNAL_CONTROL_REVIEW` do MVP 1 (ATT-02/ATT-03, verificação de vírus); sobem apenas em análise `IN_REVIEW` por quem atende a RN-ICT-70; a leitura dos anexos é do Controle Interno, do Auditor e, depois da conclusão, de `PROCESS_VIEW` (ver lacuna 3).
- **RN-ICT-76** — O achado tem título (5 a 200 caracteres), descrição (10 a 10.000), criticidade (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), recomendação opcional (até 10.000) e `sequence` sequencial `1..n` por análise, atribuído sob a trava da análise, sem lacunas nem repetição; nasce `OPEN`.
- **RN-ICT-77** — Vínculos: `checklistItemKey` (opcional) deve existir no checklist fixado; `riskId` (opcional) deve ser risco do mesmo processo e tenant e não excluído (`RiskFacade`, somente leitura — o módulo nunca escreve em `risk`); o achado pode existir sem vínculo algum.
- **RN-ICT-78** — Item `NON_COMPLIANT` conta como "com achado" quando existe ao menos um achado não `CANCELED` com seu `checklistItemKey`; a leitura devolve `findingRequired` por item e a lista de itens `NON_COMPLIANT` sem achado; a exigência é validada na conclusão (US-161, V-04).
- **RN-ICT-79** — "Achado com recomendação" é aquele com `recommendation` não vazia; a contagem alimenta a validação de `COMPLIANT_WITH_RECOMMENDATIONS` (RN-ICT-11, US-161).
- **RN-ICT-80** — Achado `OPEN` pode ser editado (título, descrição, criticidade, recomendação, item, risco) enquanto a análise está `IN_REVIEW`; a auditoria registra os campos alterados e o antes/depois apenas dos não textuais (criticidade, item, risco); o texto não vai ao log nem ao evento.
- **RN-ICT-81** — Cancelar (`OPEN` para `CANCELED`) exige `cancellationReason` de 10 a 500 caracteres, só em análise `IN_REVIEW` e só pelo Controle Interno (RN-ICT-70); o estado é terminal, grava motivo, autor e data e publica `InternalControlFindingResolved` (`status = CANCELED`) (RN-ICT-17).
- **RN-ICT-82** — Achado fora de `OPEN` não é editável nem cancelável (`FINDING_NOT_OPEN`).
- **RN-ICT-83** — Análise concluída ou cancelada é imutável: respostas, achados e papéis de trabalho não mudam (RN-ICT-41); o único trânsito permitido depois da conclusão é o atendimento da US-162.
- **RN-ICT-84** — Nota, título, descrição, recomendação e motivo de cancelamento são validados contra os campos de orçamento sigiloso conhecidos do processo (DEC-030); violação responde 422 `VALIDATION_ERROR` (`CONFIDENTIAL_CONTENT`).
- **RN-ICT-85** — Registrar, reclassificar a criticidade ou cancelar um achado recalcula `internalControl.openFindings` e `internalControl.openFindingsHighOrCritical` (RN-ICT-51, US-129); `InternalControlFindingRecorded` leva `reviewId`, `findingId`, `sequence`, `severity` e `checklistItemKey?`, nunca texto nem valores.
- **RN-ICT-86** — Concorrência otimista: ICT-12 usa a etag da resposta e ICT-14 a do achado; toda escrita de resposta ou achado também incrementa a `version` (ETag) da análise, que é o `If-Match` da conclusão (US-161). ICT-13 não exige `If-Match`, mas serializa a numeração pela trava da análise.
- **RN-ICT-87** — Idempotência: `Idempotency-Key` em ICT-12, ICT-13 e ICT-14 por 24 h devolve o mesmo resultado sem novo evento ou auditoria; ICT-12 com conteúdo idêntico ao gravado não altera a `version`, a auditoria nem a ETag.
- **RN-ICT-88** — Leitura (ICT-15 e ICT-09): `INTERNAL_CONTROL_REVIEW_VIEW` cobrindo o processo; `PROCESS_VIEW` só depois da conclusão ou do cancelamento (RN-ICT-65); filtros `status[]`, `severity[]`, `checklistItemKey`, `riskId`, `hasRecommendation`, ordenação por criticidade e depois por `sequence`, paginação por cursor.
- **RN-ICT-89** — Rodada nova (RN-ICT-18) reaproveita respostas e achados; nada é limpo na volta; achados `OPEN` continuam editáveis e a rodada corrente é a única em que se escreve.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Item | `itemKey` (path) | texto (até 60) | Sim | existe no checklist fixado | rota |
| Resposta | `answer` | `ChecklistAnswer` | Sim | RN-ICT-71 | — |
| Nota | `note` | texto (10–2.000) | Condicional | obrigatória em `NON_COMPLIANT` e `NOT_APPLICABLE` (RN-ICT-72); sem dado sigiloso | — |
| Evidência | `evidenceDocumentVersionId` | uuid | Não | versão do mesmo processo (RN-ICT-74) | lista de documentos |
| Título do achado | `title` | texto (5–200) | Sim | sem dado sigiloso | — |
| Descrição do achado | `description` | texto (10–10.000) | Sim | sem dado sigiloso | — |
| Criticidade | `severity` | `FindingSeverity` | Sim | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | — |
| Recomendação | `recommendation` | texto (até 10.000) | Não | RN-ICT-79 | — |
| Item de origem | `checklistItemKey` | texto (até 60) | Não | existe no checklist fixado | item em edição |
| Risco relacionado | `riskId` | uuid | Não | risco do mesmo processo | mapa de riscos |
| Situação | `status` | `FindingStatus` | Só em ICT-14 | apenas `CANCELED` aqui | — |
| Motivo do cancelamento | `cancellationReason` | texto (10–500) | Condicional | obrigatório ao cancelar (RN-ICT-81) | — |
| ETag da resposta / do achado | `If-Match` | texto | Sim (ICT-12, ICT-14) | RN-ICT-86 | `items[].etag`, `findings[].etag` |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| Filtros da lista | `status[]`, `severity[]`, `checklistItemKey`, `riskId`, `hasRecommendation`, `cursor`, `limit` | vários | Não | `limit` 1–100, padrão 50 | — |
| *(saída)* Sugestão | `suggestedAnswer`, `suggestionReason` | `ChecklistAnswer` / texto | — | só leitura (RN-ICT-73) | `autoCheck` |
| *(saída)* Achado exigido | `findingRequired` | boolean | — | RN-ICT-78 | derivado |
| *(saída)* Evidência desatualizada | `evidenceOutdated`, `newerVersionNumber?` | boolean / int | — | RN-ICT-74 | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `answer` ausente ou fora dos quatro valores | Front + API (Zod) | "Escolha a resposta do item." | `VALIDATION_ERROR` |
| V-02 | Nota ausente ou fora de 10–2.000 em `NON_COMPLIANT`/`NOT_APPLICABLE` | Front + API | "Explique a resposta (mínimo 10 caracteres)." | `VALIDATION_ERROR` |
| V-03 | `itemKey` fora do checklist fixado | API | "Este item não faz parte do checklist desta análise." | `INTERNAL_CONTROL_ITEM_NOT_FOUND` (404) |
| V-04 | Evidência de outro processo ou tenant, inexistente ou da manifestação | API | "A evidência informada não pertence a este processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Título, descrição ou criticidade ausentes ou fora dos limites | Front + API | "Informe título, descrição e criticidade do achado." | `VALIDATION_ERROR` |
| V-06 | `checklistItemKey` fora do checklist ou `riskId` de outro processo/tenant ou excluído | API | "O item ou o risco informado não pertence a esta análise." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-07 | Texto com valor de orçamento sigiloso | API | "O texto não pode conter valores de orçamento sigiloso." | `VALIDATION_ERROR` (`CONFIDENTIAL_CONTENT`) |
| V-08 | Cancelamento sem motivo válido ou misturado com edição de campos | Front + API | "Informe o motivo do cancelamento (mínimo 10 caracteres)." | `VALIDATION_ERROR` |
| V-09 | Análise não está `IN_REVIEW` | API | "Esta análise não está em andamento." | `INVALID_STATE` (409) |
| V-10 | Achado fora de `OPEN` | API | "Este achado já foi resolvido." | `FINDING_NOT_OPEN` (409) |
| V-11 | Processo suspenso ou em status final | API | "O processo não aceita alterações agora." | `INVALID_PROCESS_STATUS` (409) |
| V-12 | Conflito de independência | API | "Você atuou neste processo e não pode manifestar sobre ele." | `INTERNAL_CONTROL_SEGREGATION` (403) |
| V-13 | Usuário não é o designado nem titular/substituto | API | "Esta análise está designada a outra pessoa." | `NOT_INTERNAL_CONTROL_ASSIGNEE` (403) |
| V-14 | `If-Match` ausente | API | "Recarregue o item e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-15 | `If-Match` divergente | API | "Este item foi alterado por outra pessoa. Recarregue e confira." | `VERSION_CONFLICT` (412) |
| V-16 | Filtros da lista inválidos | API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` com escopo que cubra o processo (ICT-12, ICT-13, ICT-14); `ATTACHMENT_UPLOAD` mais a mesma condição para os papéis de trabalho (ATT-02/ATT-03); `INTERNAL_CONTROL_REVIEW_VIEW` para ICT-15 e ICT-09; `PROCESS_VIEW` apenas depois da conclusão ou do cancelamento (RN-ICT-88).
- **Políticas:** POL-20 (independência e designação), POL-03 (processo editável), DEC-024 (visibilidade), POL-09 (orçamento sigiloso), POL-02 (documentos e coleções tipadas seguem o documento dono — `InternalControlChecklistAnswer` e `InternalControlFinding`).
- **MFA:** risco `M` (`INTERNAL_CONTROL_REVIEW_MANAGE`): exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** a UI oculta os controles de edição; a API responde 403 `PERMISSION_DENIED`, `INTERNAL_CONTROL_SEGREGATION` ou `NOT_INTERNAL_CONTROL_ASSIGNEE` e grava `access.denied`; análise de outro tenant ou de processo invisível responde 404 `INTERNAL_CONTROL_REVIEW_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `InternalControlFindingRecorded` | `internal_control_review.finding_recorded` | Commit de ICT-13 | `reviewId`, `findingId`, `sequence`, `severity`, `checklistItemKey?` (sem texto); sem consumidor de timeline; dispara o recálculo do `RuleContext` |
| `InternalControlFindingResolved` | `internal_control_review.finding_resolved` | Cancelamento em ICT-14 (`status = CANCELED`) | `reviewId`, `findingId`, `status`; timeline `INTERNAL_CONTROL_FINDING_RESOLVED` |

A gravação de resposta (ICT-12) e a edição de campos do achado (ICT-14) não geram evento de domínio: ficam na auditoria (`events.md` §4.6 não prevê evento para elas).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhum tipo catalogado em `events.md` §6 para respostas e achados; o painel e a timeline cumprem o acompanhamento (a notificação do atendimento é a lacuna 1 da US-162) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Responder o checklist e registrar achados e recomendações

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" tem a manifestação "IN_REVIEW" na rodada 1, designada a "Renata Prado"
    And o checklist fixado "FASE_PREPARATORIA" v1 tem 12 itens, 10 obrigatórios, todos "PENDING"
    And "Renata Prado" tem "INTERNAL_CONTROL_REVIEW_MANAGE" e "ATTACHMENT_UPLOAD", é do perfil "CONTROLE_INTERNO" e não atuou no processo
    And o mapa de riscos do processo tem o risco "R02" e o processo tem a pesquisa de preços na versão 2

  Scenario: [Sucesso] Responder um item como conforme com evidência
    When "Renata Prado" gravar o item "I-05" como "COMPLIANT" com a evidência na versão 2 da pesquisa de preços
    Then a API deve responder 200 com a resposta "COMPLIANT", "answeredBy" "Renata Prado" e "answeredAt" preenchido
    And "meta.progress" deve passar de 0 para 1 resposta obrigatória preenchida
    And deve gerar registro de auditoria "internal_control_review.answer_update"
    And a ETag da análise deve mudar

  Scenario: [Sucesso] Item não conforme exige nota e achado vinculado
    When "Renata Prado" gravar o item "I-07" como "NON_COMPLIANT" com a nota "Matriz de riscos não prevê tratamento para o risco de reajuste."
    Then a API deve responder 200 e o item "I-07" deve ficar com "findingRequired" verdadeiro
    When "Renata Prado" registrar o achado "Risco de reajuste sem tratamento" com criticidade "HIGH", recomendação "Incluir tratamento preventivo na matriz.", item "I-07" e risco "R02"
    Then a API deve responder 201 com o achado "OPEN" e "sequence" 1
    And o item "I-07" deve passar a "findingRequired" falso
    And "internalControl.openFindingsHighOrCritical" deve ser 1
    And deve gerar registro de auditoria "internal_control_review.finding_create" e o evento "InternalControlFindingRecorded" sem texto no payload

  Scenario: [Sucesso] A sugestão do autoCheck não preenche a resposta
    Given que o item "I-09" tem "autoCheck" e o contexto sugere "NON_COMPLIANT"
    When "Renata Prado" abrir o painel
    Then o item "I-09" deve trazer "suggestedAnswer" "NON_COMPLIANT" e "suggestionReason"
    And a resposta gravada do item deve continuar "PENDING" e "answeredBy" deve ser nulo
    When "Renata Prado" gravar o item "I-09" como "COMPLIANT"
    Then a API deve responder 200 e a sugestão não deve ter sido gravada

  Scenario: [Sucesso] Editar e cancelar achados antes da conclusão
    Given que existem os achados "A1" (HIGH, "OPEN") e "A2" (LOW, "OPEN")
    When "Renata Prado" alterar "A1" para criticidade "MEDIUM"
    Then a API deve responder 200 e "internalControl.openFindingsHighOrCritical" deve passar de 1 para 0
    When "Renata Prado" cancelar "A2" com o motivo "Achado duplicado do achado A1."
    Then a API deve responder 200 com "A2" em "CANCELED" com motivo, autor e data
    And deve gerar o evento "InternalControlFindingResolved" e a entrada de timeline "INTERNAL_CONTROL_FINDING_RESOLVED"
    And "A2" não deve poder ser editado nem cancelado de novo

  Scenario: [Sucesso] Listar os achados com filtros
    Given que a análise tem 3 achados "OPEN" e 1 "CANCELED"
    When "Renata Prado" chamar "GET /internal-control/reviews/{id}/findings" com "status" "OPEN" e "severity" "HIGH"
    Then a API deve responder 200 apenas com os achados "OPEN" de criticidade "HIGH", ordenados por criticidade e "sequence"
    And cada achado deve trazer descrição, recomendação, vínculo ao item e ao risco e a etag

  Scenario: [Sucesso] Rodada nova reaproveita respostas e achados
    Given que a resposta do item "I-05" aponta para a versão 2 da pesquisa de preços e a análise ganhou a rodada 2
    And a pesquisa de preços ganhou a versão 3
    When "Renata Prado" abrir o painel
    Then as respostas e os achados "OPEN" da rodada 1 devem estar preservados
    And o item "I-05" deve exibir "evidenceOutdated" verdadeiro com "newerVersionNumber" 3

  Scenario: [Validação] Nota ausente, evidência e vínculos inválidos
    When "Renata Prado" gravar o item "I-07" como "NON_COMPLIANT" sem nota
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "note" e a resposta deve continuar "PENDING"
    When ela informar como evidência uma versão de documento de outro processo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e motivo "REFERENCE_NOT_FOUND"
    When ela gravar o item "X-99", que não existe no checklist
    Then a API deve responder 404 com código "INTERNAL_CONTROL_ITEM_NOT_FOUND"
    When ela registrar um achado com o risco "R77" de outro processo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e motivo "REFERENCE_NOT_FOUND"
    When ela registrar um achado sem título e com a criticidade "SEVERE"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nada deve ser gravado

  Scenario: [Validação] Estado da análise e conteúdo sigiloso
    Given que a análise ainda está "PENDING"
    When "Renata Prado" gravar qualquer item
    Then a API deve responder 409 com código "INVALID_STATE"
    Given que o orçamento do processo é sigiloso
    When "Renata Prado" registrar um achado com a descrição "Valor estimado de R$ 1.250.000,00 acima do praticado."
    Then a API deve responder 422 com código "VALIDATION_ERROR" e motivo "CONFIDENTIAL_CONTENT" e o achado não deve ser gravado
    Given que a análise já está concluída
    When "Renata Prado" tentar editar um achado
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Permissão] Sem permissão, sem independência, sem designação e leitura restrita
    Given que "Paulo Dias" não tem "INTERNAL_CONTROL_REVIEW_MANAGE"
    When "Paulo Dias" gravar o item "I-05"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que "Marcos Lima" tem a permissão, mas foi aprovador do DFD do processo
    When "Marcos Lima" tentar registrar um achado
    Then a API deve responder 403 com código "INTERNAL_CONTROL_SEGREGATION"
    Given que "Bruno Lopes" tem a permissão, mas a análise está designada a "Renata Prado" e ele não é titular nem substituto
    When "Bruno Lopes" tentar gravar o item "I-05"
    Then a API deve responder 403 com código "NOT_INTERNAL_CONTROL_ASSIGNEE"
    Given que "Carla Mendes" tem apenas "PROCESS_VIEW" e a análise está "IN_REVIEW"
    When "Carla Mendes" chamar "GET /internal-control/reviews/{id}/findings"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Análise, achado e risco de outro tenant
    Given que existe a análise "0031/2026" e o achado "B1" da "Prefeitura B"
    When "Renata Prado", da "Prefeitura A", chamar "PUT /internal-control/reviews/{id-da-Prefeitura-B}/answers/I-05"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    When ela chamar "PATCH /internal-control/reviews/{id}/findings/{id-de-B1}"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    When ela registrar um achado com o "riskId" de um risco da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e motivo "REFERENCE_NOT_FOUND"
    And "B1" não deve aparecer em "GET /internal-control/reviews/{id}/findings" da "Prefeitura A"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência e resposta idêntica
    Given que "Renata Prado" registrou o achado "A1" com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo achado e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único achado, um único evento "InternalControlFindingRecorded" e uma única auditoria "internal_control_review.finding_create"
    Given que o item "I-05" já está gravado como "COMPLIANT"
    When "Renata Prado" enviar de novo exatamente a mesma resposta
    Then a API deve responder 200 sem alterar a ETag da análise nem gerar nova auditoria

  Scenario: [Concorrência] Edição simultânea e numeração dos achados
    Given que a resposta do item "I-05" tem a etag "R1"
    When "Renata Prado" e "Dr. Otávio" gravarem o item "I-05" ao mesmo tempo com "If-Match" "R1"
    Then exatamente uma gravação deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT"
    When "Renata Prado" e "Dr. Otávio" registrarem achados ao mesmo tempo
    Then os dois devem ser criados com "sequence" 1 e 2, sem repetição nem lacuna
    Given que "Renata Prado" abriu a edição do achado "A1" com a etag "F1" e ele foi cancelado em outra aba
    When ela salvar com "If-Match" "F1"
    Then a API deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "FINDING_NOT_OPEN"

  Scenario: [Falha de banco] Falha ao gravar o achado
    Given que o banco de dados fica indisponível durante a transação de "POST /internal-control/reviews/{id}/findings"
    When "Renata Prado" confirmar o registro
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum achado, auditoria ou evento deve ter sido gravado e a numeração não deve ter avançado

  Scenario: [Falha de integração] Armazenamento de arquivos indisponível ao anexar papel de trabalho
    Given que o armazenamento de arquivos está indisponível
    When "Renata Prado" pedir o envio de um papel de trabalho
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e a UI deve oferecer "Tentar novamente"
    And as respostas e os achados já gravados devem permanecer intactos
    Given que o broker de mensagens está indisponível
    When "Renata Prado" registrar o achado "A3"
    Then o achado deve ser gravado com o evento no outbox para publicação posterior e o recálculo do "RuleContext" deve ocorrer quando o outbox for publicado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Resposta, nota ou achado inválidos | 422 | `VALIDATION_ERROR` | "Explique a resposta (mínimo 10 caracteres)." | Marca o campo |
| Evidência, item ou risco fora da análise | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "O item ou o risco informado não pertence a esta análise." | Marca o campo |
| Texto com valor sigiloso | 422 | `VALIDATION_ERROR` (`CONFIDENTIAL_CONTENT`) | "O texto não pode conter valores de orçamento sigiloso." | Marca o campo |
| Item inexistente no checklist | 404 | `INTERNAL_CONTROL_ITEM_NOT_FOUND` | "Este item não faz parte do checklist desta análise." | Recarrega o painel |
| Análise ou achado inexistente ou de outro tenant | 404 | `INTERNAL_CONTROL_REVIEW_NOT_FOUND` | "Análise não encontrada." | Volta à fila |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar esta análise." | Oculta a ação |
| Conflito de independência | 403 | `INTERNAL_CONTROL_SEGREGATION` | "Você atuou neste processo e não pode manifestar sobre ele." | Desabilita a edição |
| Análise designada a outra pessoa | 403 | `NOT_INTERNAL_CONTROL_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Mostra o responsável |
| Análise não está em andamento | 409 | `INVALID_STATE` | "Esta análise não está em andamento." | Recarrega; orienta iniciar |
| Achado já resolvido | 409 | `FINDING_NOT_OPEN` | "Este achado já foi resolvido." | Recarrega a lista |
| Processo suspenso ou encerrado | 409 | `INVALID_PROCESS_STATUS` | "O processo não aceita alterações agora." | Desabilita a edição |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este item foi alterado por outra pessoa. Recarregue e confira." | Recarrega o item |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue o item e tente de novo." | Recarrega |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou armazenamento indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-159 (abertura, painel, início e checklist fixado). Indiretas: US-068/US-069 (anexos e verificação de vírus), US-066 (versões de documento), US-033 (riscos), US-129 (`RuleContext` v2 — `autoCheck` e contadores `internalControl.*`), US-161 (conclusão, que valida as pendências), US-162 (atendimento dos achados).
- **Decisões/ADRs:** DEC-030, DEC-024, DEC-196, DEC-200, DEC-202 (sem IA), ADR-008.
- **Configurações:** nenhuma (o checklist vem fixado da abertura).
- **Lacunas nas fontes canônicas:**
  1. **Motivo do cancelamento de achado:** `InternalControlFinding` não tem coluna para o motivo (só `response`, `respondedById`, `respondedAt`). Proposta adotada: gravar o motivo em `response` e o cancelador/data em `respondedById`/`respondedAt` (satisfaz o check `status NOT IN ('ADDRESSED','RISK_ACCEPTED') OR response IS NOT NULL`), e exibir com rótulo próprio para `CANCELED`. **Dúvida de produto.**
  2. **Auditoria do cancelamento e do atendimento:** `events.md` lista `internal_control_review.finding_resolve` para a resolução de achado, mas a US-162 propôs `internal_control_finding.respond`; esta story usa `internal_control_review.finding_update` na edição e `internal_control_review.finding_resolve` no cancelamento. Unificar o nome no card 9.
  3. **Papéis de trabalho:** o anexo `INTERNAL_CONTROL_REVIEW` aponta para a análise, não para o item ou o achado (a US-162 cita `evidenceAttachmentIds` com a mesma lacuna), e `permissions.md` não define quem lê papéis de trabalho de análise em andamento. Proposta: anexos da análise inteira, leitura restrita ao Controle Interno e ao Auditor até a conclusão (RN-ICT-75). **Dúvida de produto.**
  4. **Etags por resposta e por achado e `suggestedAnswer`/`findingRequired`/`evidenceOutdated`:** são acréscimos aditivos ao contrato de ICT-09 (DEC-108) e não constam do catálogo de API. A avaliação do `autoCheck` depende do `RuleContext` v2 (US-129), que não está em `depends_on`; sem ele a sugestão simplesmente não aparece.
  5. **Códigos novos:** `INTERNAL_CONTROL_ITEM_NOT_FOUND`; `FINDING_NOT_OPEN` e `INTERNAL_CONTROL_REVIEW_NOT_FOUND` são definidos pela US-162 e pela US-159 e reutilizados aqui; consolidar no card 9. Limites de tamanho de nota (2.000), título (5–200) e motivo de cancelamento (500) são propostas desta story; descrição (10–10.000) e título (200) seguem `entities.md`.

## Impacto técnico
- Duas rotas de escrita simples (ICT-12, ICT-13), uma de edição e cancelamento (ICT-14) e uma de leitura (ICT-15) sobre tabelas já definidas na §4.4; sem tabela nova.
- A numeração `sequence` exige serialização: trava da linha da análise (`SELECT … FOR UPDATE`) ou contador na própria análise, sob a constraint `(tenant_id, review_id, sequence)`, para evitar lacunas e repetições sob concorrência.
- Cada escrita incrementa duas versões (linha e análise) para que o `If-Match` da conclusão detecte qualquer mudança em outra aba; isso aumenta a chance de 412 em uso simultâneo, mitigada pela recarga automática do painel.
- Recalcular os contadores do `RuleContext` fica a cargo do consumidor do outbox (US-129/US-161), com leitura barata por `review_id` e índice parcial de achados `OPEN`.
- A validação de conteúdo sigiloso reaproveita o `ConfidentialContentGuard` das stories de conclusão e atendimento; nenhum texto vai a log nem a evento.

## Backend
- **Módulo(s):** `internal-control` (dono), `document` (versão como evidência), `risk` (leitura do risco), `files` (anexos), `process` (independência), `rules` (`autoCheck`), `timeline`, `audit`.
- **Casos de uso:** `UpsertInternalControlAnswerCommand` (ICT-12), `RecordInternalControlFindingCommand` (ICT-13), `UpdateInternalControlFindingCommand` (ICT-14, edição e cancelamento), `ListInternalControlFindingsQuery` (ICT-15), extensão de `GetInternalControlReviewQuery` (ICT-09).
- **Domínio:** `InternalControlChecklistAnswer` (regras de nota e limpeza), `InternalControlFinding` (transição `OPEN → CANCELED`, numeração), `ReviewIndependencePolicy` (POL-20, compartilhada com a US-159), `ConfidentialContentGuard`, `FindingRequirementCalculator`.
- **Integrações internas:** `RiskFacade.getRisk`, `DocumentFacade.getVersion`, `AttachmentFacade`/`AttachmentTargetResolver`, `RuleFacade.evaluate` (`autoCheck`), `OutboxWriter`, `AuditService`.
- **Transação:** trava da análise (e da linha) → validações → gravação → incremento das versões → auditoria → outbox (quando houver evento) → timeline (cancelamento) → commit.

## Frontend
- **Tela(s):** SCR-020 (`/controle-interno/[reviewId]`, abas Checklist e Achados), SCR-006 (aba "Controle Interno", leitura).
- **Componentes:** `ChecklistGroupList`, `ChecklistItemRow` (resposta, nota, evidência, sugestão), `AnswerForm`, `EvidencePicker` (lista de versões do processo), `SuggestionBadge`, `FindingForm`, `FindingsTable` (compartilhado com a US-162), `CancelFindingDialog`, `WorkPapersPanel` (anexos), `ProgressSummary`.
- **Estados:** skeleton, vazio ("Nenhum achado registrado"), erro com "Tentar novamente", gravação otimista com reversão no 412, item "sem achado" destacado, painel somente leitura quando a análise não está `IN_REVIEW`.
- **Acessibilidade e responsividade:** resposta e criticidade por texto e ícone (nunca só cor); grupos do checklist como regiões com títulos; formulários com rótulos e erros associados (`aria-describedby`); foco devolvido ao item depois de salvar; diálogo de cancelamento com foco preso; itens em cartões abaixo de 768 px.

## Banco de dados
- **Tabelas:** `internal_control_checklist_answers` (escrita), `internal_control_findings` (escrita), `internal_control_reviews` (versão/ETag), `attachments` (papéis de trabalho), leitura de `document_versions` e `risks`.
- **Migrações:** nenhuma além da M2 do módulo (tabelas da §4.4 e trigger de imutabilidade); o trigger aceita escrita em respostas e achados somente com a análise `IN_REVIEW` (exceção da US-162 para `OPEN → ADDRESSED`).
- **Índices/constraints relevantes:** `(tenant_id, review_id, item_key)` único; `(tenant_id, review_id, sequence)` único; índice parcial `(tenant_id, status) WHERE status = 'OPEN'`; check `status NOT IN ('ADDRESSED','RISK_ACCEPTED','CANCELED') OR response IS NOT NULL` (ajuste proposto para o cancelamento, lacuna 1); check `answer NOT IN ('NON_COMPLIANT','NOT_APPLICABLE') OR note IS NOT NULL`; FKs compostas com o tenant e RLS `FORCE`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ICT-12` | PUT | `/api/v1/internal-control/reviews/{id}/answers/{itemKey}` | `{ answer, note?, evidenceDocumentVersionId? }` + `If-Match` + `Idempotency-Key` | `200 { data: Answer, meta { reviewEtag, progress } }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `ICT-13` | POST | `/api/v1/internal-control/reviews/{id}/findings` | `{ title, description, severity, recommendation?, checklistItemKey?, riskId? }` + `Idempotency-Key` | `201 { data: Finding }` + `ETag` | 201, 403, 404, 409, 422, 503 |
| `ICT-14` | PATCH | `/api/v1/internal-control/reviews/{id}/findings/{findingId}` | campos alterados **ou** `{ status: "CANCELED", cancellationReason }` + `If-Match` + `Idempotency-Key` | `200 { data: Finding }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `ICT-15` | GET | `/api/v1/internal-control/reviews/{id}/findings` | filtros `status[]`, `severity[]`, `checklistItemKey`, `riskId`, `hasRecommendation`, `cursor`, `limit` | `200 { data: Finding[], meta.nextCursor }` | 200, 403, 404, 422 |
| `ICT-09` | GET | `/api/v1/internal-control/reviews/{id}` | path `id` | estendido com `items[].etag`, `suggestedAnswer`, `findingRequired`, `evidenceOutdated` e `findings[].etag` | 200, 403, 404 |
| `ATT-02` | POST | `/api/v1/attachments` | MVP 1 (alvo `INTERNAL_CONTROL_REVIEW`) | MVP 1 (URL de upload) | 201, 403, 404, 422, 503 |
| `ATT-03` | POST | `/api/v1/attachments/{id}/confirm` | MVP 1 | MVP 1 (verificação de vírus em fila) | 202, 403, 404, 409 |
| `DOC-17` | GET | `/api/v1/document-versions/{versionId}` | MVP 1 (abrir a evidência) | MVP 1 | 200, 403, 404 |

## Logs
- `info` `internal_control.answer_saved` — `reviewId`, `itemKey`, `answer`, `hasEvidence`, `correlationId`.
- `info` `internal_control.finding_recorded` — `reviewId`, `findingId`, `sequence`, `severity`; `info` `internal_control.finding_updated` / `internal_control.finding_canceled` — `findingId`, `severity`.
- `warn` `internal_control.write_rejected` — `reviewId`, `errorCode`; `warn` `outbox.publish_delayed`.
- `error` `internal_control.write_failed` — `errorCode`, causa resumida.
- **Nunca logar:** nota, título, descrição, recomendação, motivo de cancelamento, nome do arquivo anexado, valores de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `internal_control_review.answer_update` | `DATA_CHANGE` | Commit de ICT-12 com mudança | `changes` de `answer` e `evidenceDocumentVersionId` (sem a nota); `metadata`: `itemKey`, `round` |
| `internal_control_review.finding_create` | `DATA_CHANGE` | Commit de ICT-13 | `metadata`: `findingId`, `sequence`, `severity`, `checklistItemKey?`, `riskId?` (sem texto) |
| `internal_control_review.finding_update` | `DATA_CHANGE` | Commit de ICT-14 (edição) | `changes` de `severity`, `checklistItemKey`, `riskId`; lista dos campos textuais alterados sem o conteúdo |
| `internal_control_review.finding_resolve` | `DATA_CHANGE` | Commit de ICT-14 (cancelamento) | `changes` de `status`; `metadata`: `findingId`, `round` (sem o motivo) |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `reviewId` |

## Testes necessários
- **Unitários:** regras de nota por resposta, limpeza de resposta, `FindingRequirementCalculator` (item `NON_COMPLIANT` com e sem achado, achado cancelado), numeração de `sequence`, transição `OPEN → CANCELED`, `ConfidentialContentGuard`, sugestão do `autoCheck` apenas na leitura, no-op de resposta idêntica.
- **Integração (Testcontainers):** ICT-12 a ICT-15 ponta a ponta com auditoria, outbox e timeline; trigger de imutabilidade (escrita bloqueada em análise concluída ou cancelada); numeração sob concorrência; rollback total na falha; contadores do `RuleContext` depois de registrar, reclassificar e cancelar; papéis de trabalho com o resolvedor de alvo.
- **API/contrato:** corpos, filtros, paginação e erros; idempotência e `If-Match`; ausência de texto nos eventos e de valores monetários nas respostas.
- **RBAC e multi-tenant:** 403/404 por papel e tenant, independência (POL-20), designação, `PROCESS_VIEW` depois da conclusão; `riskId` e evidência de outro tenant; teste novo na suíte "tenant leak" (respostas, achados, papéis de trabalho).
- **Concorrência:** duas gravações da mesma resposta com a mesma etag; dois achados simultâneos; edição de achado cancelado em outra aba; escrita × conclusão.
- **E2E (Playwright):** iniciar a análise → responder itens (incluindo uma sugestão `autoCheck`) → item `NON_COMPLIANT` → registrar achado vinculado a um risco → editar a criticidade → cancelar um achado → conferir o avanço e a lista de verificação.
- **Acessibilidade/performance:** axe no checklist, nos formulários e no diálogo de cancelamento; p95 de ICT-12/ICT-13 < 800 ms e de ICT-15 < 1,5 s com 200 achados (suíte de performance, medida no endurecimento).

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
- [ ] Teste prova que a sugestão do `autoCheck` e nenhuma IA ou regra preenchem resposta ou achado sozinhas
- [ ] Teste prova que eventos, logs e auditoria não carregam texto de notas, achados ou valores sigilosos
- [ ] Decisões do piloto registradas sobre o motivo do cancelamento e a leitura dos papéis de trabalho

## Estimativa
**M** — quatro rotas sobre tabelas já definidas; o esforço está nas validações cruzadas (item, risco, evidência, conteúdo sigiloso), na independência POL-20, na numeração e na concorrência das escritas, e na extensão do painel com etags e indicadores derivados.

## Prioridade
**P0** — sem respostas e achados registrados a manifestação não pode ser redigida nem concluída (US-161), e a regra de saída da etapa `CONTROLE_INTERNO` não é satisfeita.
