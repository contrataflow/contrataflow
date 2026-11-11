---
id: US-147
title: "Confirmar a reserva com evidência e cancelar dotação"
epic: EP-024
feature: FT-072
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-068, US-146]
modules: [budget, process, files, document, timeline, notification, audit, platform]
screens: [SCR-006]
endpoints: [BUD-10, BUD-11, BUD-12, ATT-01, ATT-02, ATT-03, ATT-04, ATT-05, DOC-21, DOC-22, DOC-23]
permissions: [BUDGET_ALLOCATION_CONFIRM, BUDGET_ALLOCATION_MANAGE, ATTACHMENT_UPLOAD, DOCUMENT_CREATE, DOCUMENT_SUBMIT, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [BudgetAllocationConfirmed, BudgetAllocationCanceled, DocumentCreated, DocumentFinalized, DocumentVersionCreated, DocumentRenditionReady, DocumentRenditionFailed]
---

# US-147 — Confirmar a reserva com evidência e cancelar dotação

## Título
Confirmar a reserva com evidência e cancelar dotação

## Descrição
**Como** servidor da Contabilidade, **quero** confirmar a reserva de uma dotação indicada — informando o número e a data da reserva ou pré-empenho e anexando o documento de bloqueio/reserva como evidência — e, se a reserva cair, cancelá-la com motivo, **para** que só conte para o processo a dotação que tem lastro verificável, que a confirmação seja um ato humano, rastreável e imutável, e que o cancelamento tardio seja visível a quem responde pelo processo.

A confirmação leva a dotação de `DRAFT` para `CONFIRMED` (RN-BUD-03 da feature) e a torna imutável: a partir daí só o cancelamento com motivo a altera (`CONFIRMED → CANCELED`). A evidência é um `Attachment` (`targetType = BUDGET_ALLOCATION`) que precisa estar `AVAILABLE`, isto é, ter passado pela verificação de tipo e antivírus (US-068); a plataforma não consulta sistemas contábeis nem confirma nada sozinha (DEC-198, RN-BUD-10 da feature). Depois de confirmada, a Contabilidade pode gerar a **Declaração de dotação orçamentária** em PDF (Gotenberg), como documento do processo, para instruir a fase seguinte.

## Contexto
- DEC-198: a Contabilidade (perfil `CONTABILIDADE`, único com `BUDGET_ALLOCATION_CONFIRM` por padrão) indica e confirma; "a confirmação é ato humano com evidência". Sem integração contábil no MVP 2: o número e a data são digitados e a evidência é o documento do sistema contábil do órgão (nota de bloqueio, pré-empenho, reserva), anexado.
- POL-25: confirmar e cancelar dotação confirmada exigem `BUDGET_ALLOCATION_CONFIRM` + a mesma custódia da etapa `DOTACAO` (ou titular/substituto da unidade) + processo editável + evidência anexada e verificada (`AVAILABLE`). Erros: `BUDGET_ALLOCATION_NOT_EDITABLE` (409) e `BUDGET_EVIDENCE_REQUIRED` (422). `BUDGET_ALLOCATION_CONFIRM` tem risco `H`: a sessão pode exigir MFA conforme `security.mfaPolicy` (POL-14).
- Entities MVP 2 §4.2 e §6.3: unicidade `(tenant_id, reservation_number, fiscal_year) WHERE status = 'CONFIRMED'`; `CONFIRMED` imutável salvo cancelamento (trigger); cancelar recalcula a cobertura e, se o processo já passou de `DOTACAO`, gera aviso na timeline e para o responsável (RN-BUD-06 da feature).
- US-068 define o upload seguro: intenção → `PUT` na quarentena → confirmação → varredura do worker `file-scan` (ClamAV); o anexo só é `AVAILABLE` depois de limpo, e fica retido em `SCANNING` se o antivírus estiver fora. A categoria de anexo do catálogo `ATTACHMENT_CATEGORY` (`CERTIDAO`, `OUTRO`…) é opcional.
- Sigilo (DEC-030, POL-09): o valor reservado nunca sai em evento, notificação, timeline, log ou auditoria; a evidência (um documento do sistema contábil) contém o valor e, em processo sigiloso, só é baixada por quem pode ver o orçamento.
- A Declaração de dotação reaproveita o tipo de documento semeado `DECLARACAO` (FREE_TEXT, máscara `DECL {seq:4}/{year}`, entities MVP 1 §7) e o pipeline de PDF da US-067 (job `document-render`, Gotenberg), em vez de um gerador novo.
- O cálculo de cobertura (Σ `CONFIRMED` ÷ valor estimado) é formalizado na US-148; aqui ele é usado apenas para o campo `coverageReached` dos eventos, pela mesma regra (RN-BUD-07 da feature).

## Objetivo
Garantir que 100% das dotações `CONFIRMED` tenham número, data e evidência `AVAILABLE` do próprio órgão, que nenhuma reserva seja usada por duas dotações confirmadas no mesmo exercício, que a confirmação e o cancelamento só ocorram por ato humano autorizado (permissão, custódia e MFA) e fiquem auditados com motivo, e que o cancelamento posterior à saída da etapa `DOTACAO` avise quem responde pelo processo sem expor valores.

## Persona
- **Principal:** Contabilidade (perfil `CONTABILIDADE`) — confirma, cancela e emite a declaração.
- **Secundárias:** Responsável da etapa `DOTACAO` e criador do processo (notificados da confirmação); responsáveis das etapas ativas e gestor (`GESTOR_CONTRATACOES`, notificados do cancelamento); Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`), que verificam a evidência; Administrador do órgão (política de MFA).

## Pré-condições
- Dotação em `DRAFT` (US-146) de processo do tenant, visível ao usuário, com `ProcessStage` `ACTIVE` de `WorkflowStage.key = 'DOTACAO'` e status `IN_PROGRESS` (para confirmar e para cancelar durante a etapa); para o cancelamento depois da saída da etapa vale a RN-BUD-40.
- Usuário com `BUDGET_ALLOCATION_CONFIRM` cobrindo o processo, vínculo `ACTIVE`, custódia da etapa `DOTACAO` (ou titular/substituto da unidade) e, se a política do órgão exigir, sessão com MFA.
- Evidência enviada como anexo da própria dotação (`ATT-02` com `targetType = BUDGET_ALLOCATION` e `targetId` = id da dotação) e já `AVAILABLE`.
- Para a declaração: ao menos uma dotação `CONFIRMED`, tipo de documento `DECLARACAO` ativo com modelo publicado e as permissões `DOCUMENT_CREATE` e `DOCUMENT_SUBMIT`.

## Fluxo principal
1. No painel "Dotação orçamentária" (SCR-006), a Contabilidade vê a dotação em `Rascunho` e aciona **"Anexar evidência"**: escolhe o arquivo (documento de bloqueio/reserva), o front cria a intenção (`ATT-02`, `targetType = BUDGET_ALLOCATION`), envia direto à quarentena, confirma (`ATT-03`) e acompanha a verificação; o anexo aparece como "Verificando…" e passa a "Disponível" quando o `file-scan` o libera (US-068).
2. Com o anexo disponível, aciona **"Confirmar reserva"**: o formulário pede o **número da reserva/pré-empenho**, a **data da reserva** e a **evidência** (lista dos anexos disponíveis da dotação) e mostra o resumo da classificação, sem valor se o usuário não puder vê-lo.
3. O diálogo de confirmação avisa: "Confirmar é um ato definitivo. Depois disso, a dotação só pode ser alterada pelo cancelamento, com motivo." Se a política de MFA exigir, o front faz o *step-up* antes de enviar.
4. O front envia `POST /processes/{id}/budget-allocations/{allocationId}/confirm` (BUD-10) com `If-Match` (versão da dotação) e `Idempotency-Key`.
5. A API, em uma transação: trava o processo (`SELECT … FOR UPDATE`, DEC-055) e a dotação; autoriza (`CONFIRM` + custódia + status + MFA + ator `USER`); confere o estado `DRAFT`; valida número, data e evidência (`AVAILABLE`, mesmo tenant, alvo = esta dotação); verifica a unicidade da reserva no exercício; grava `status = CONFIRMED`, `reservationNumber`, `reservationDate`, `evidenceAttachmentId`, `confirmedAt`, `confirmedById`, `version + 1`; calcula `coverageReached`; grava auditoria `budget_allocation.confirm`, publica `BudgetAllocationConfirmed` no outbox e projeta a timeline `BUDGET_ALLOCATION_CONFIRMED`.
6. Depois do *commit*, o sistema notifica o responsável da etapa `DOTACAO` (se não for o ator) e o criador do processo (`BUDGET_ALLOCATION_CONFIRMED`, in-app). A resposta traz a dotação `CONFIRMED`, o novo `ETag` e `meta.coverageReached`; o painel mostra "Confirmada em {data}" e bloqueia a edição.
7. Para instruir as próximas etapas, a Contabilidade aciona **"Gerar declaração de dotação"** (BUD-12). A API cria o documento `DECLARACAO` do processo com o texto montado a partir das dotações `CONFIRMED`, finaliza a versão e enfileira o PDF (job `document-render`/Gotenberg); responde **202** com o documento, a versão e a `DocumentRendition`.
8. O painel acompanha a geração (`DOC-22`) e, quando `READY`, oferece o download (`DOC-23`, URL assinada de até 300 s).
9. Se a reserva cair ou for substituída, a Contabilidade aciona **"Cancelar dotação"** na dotação confirmada, informa o motivo (10 a 1.000 caracteres) e confirma (MFA se exigido); a API (BUD-11, `If-Match`) leva a dotação a `CANCELED`, recalcula a cobertura, publica `BudgetAllocationCanceled` (`fromStatus = CONFIRMED`) e registra a timeline.
10. Se o processo **já saiu** da etapa `DOTACAO` e a cobertura ficou insuficiente, a entrada de timeline destaca a perda de cobertura e a notificação `BUDGET_ALLOCATION_CANCELED` chega aos responsáveis das etapas ativas e ao gestor; o processo **não** é devolvido automaticamente (a devolução é decisão humana, US-148).

## Fluxos alternativos
- **FA-01 — Evidência ainda em verificação:** com o anexo em `UPLOADED`/`SCANNING`, a confirmação é recusada com `BUDGET_EVIDENCE_REQUIRED` (`meta.reason = NOT_AVAILABLE`, `meta.attachmentStatus`), e a UI mantém o formulário com "A evidência ainda está sendo verificada. Tente confirmar em instantes". Se o antivírus estiver fora, o anexo fica retido (RN-DOC-75) e a confirmação espera; nada é liberado sem varredura limpa.
- **FA-02 — Evidência infectada ou rejeitada:** anexo `INFECTED`/`REJECTED` nunca é aceito; a UI pede novo envio (o evento `AttachmentRejected` notifica quem enviou).
- **FA-03 — Número já usado em outra dotação confirmada do exercício:** `BUDGET_RESERVATION_DUPLICATED` (409); a mensagem não revela o processo (RN-BUD-34). O usuário confere o número ou, se for a mesma reserva legítima, orienta-se a cancelar a anterior com motivo.
- **FA-04 — Confirmação repetida:** reenvio com a mesma `Idempotency-Key` devolve o mesmo resultado; nova tentativa em dotação já `CONFIRMED` (outra chave) → `BUDGET_ALLOCATION_NOT_EDITABLE`.
- **FA-05 — Cancelar durante a etapa `DOTACAO`:** o processo ainda está na etapa; o cancelamento reabre a possibilidade de indicar/confirmar outra dotação e a regra de saída (US-148) volta a bloquear até a cobertura ser refeita.
- **FA-06 — Cancelar depois da saída da etapa:** autorizado a quem tem `CONFIRM` e pertence à unidade que respondeu pela etapa (RN-BUD-40); a timeline e a notificação alertam; o responsável decide se devolve o processo (PRC-20) à `DOTACAO`.
- **FA-07 — Dotação em `DRAFT` pelo caminho do cancelamento:** `POST …/cancel` em rascunho responde `INVALID_STATE`; rascunho é removido por BUD-05 (US-146).
- **FA-08 — Reuso do número depois do cancelamento:** cancelar libera o número no exercício; outra dotação pode confirmá-lo (a dotação cancelada nunca volta a `CONFIRMED`).
- **FA-09 — Processo sigiloso:** quem confirma precisa poder ver o orçamento; a evidência só é baixada por quem pode ver o orçamento; o PDF da declaração omite os valores (RN-BUD-46).
- **FA-10 — Falha na geração do PDF:** a dotação continua `CONFIRMED`; a `DocumentRendition` fica `FAILED` após as tentativas, o solicitante é notificado (`DOCUMENT_RENDER_FAILED`) e pode pedir de novo (`DOC-21`).
- **FA-11 — Sem dotação confirmada para a declaração:** BUD-12 recusa com `BUSINESS_RULE_VIOLATION` (`NO_CONFIRMED_ALLOCATION`).

## Regras de negócio
- **RN-BUD-29** — Quem confirma e onde: `BUDGET_ALLOCATION_CONFIRM` cobrindo o processo + custódia da etapa `DOTACAO` (responsável atual; lotado na unidade da etapa sem responsável; ou titular/substituto da unidade — POL-25) + processo `IN_PROGRESS` com `ProcessStage` ativa de `DOTACAO` + sessão com MFA quando `security.mfaPolicy` exigir (POL-14, risco `H`). Sem `CONFIRM` (ex.: gestor só com `MANAGE`) → `PERMISSION_DENIED`; sem custódia → `NOT_PROCESS_CUSTODIAN`; fora da etapa → `INVALID_STATE` (`NO_ACTIVE_BUDGET_STAGE`); status do processo → `INVALID_PROCESS_STATUS`; MFA ausente → `MFA_REQUIRED` (403). O ator é sempre `USER`: token de integração, job ou regra não confirma dotação (RN-BUD-10 da feature); participante do processo nunca confirma.
- **RN-BUD-30** — Só `DRAFT` confirma: dotação `CONFIRMED` ou `CANCELED` → `BUDGET_ALLOCATION_NOT_EDITABLE` (409, `meta.status`). `If-Match` com a `version` da dotação é obrigatório (428/412).
- **RN-BUD-31** — Número da reserva (`reservationNumber`): obrigatório, 1 a 60 caracteres; letras, dígitos, espaço e `. / - _`; a API remove espaços nas pontas, comprime espaços internos e **normaliza para maiúsculas** antes de gravar e de comparar (`pe 12/2026` e `PE 12/2026` são a mesma reserva).
- **RN-BUD-32** — Data da reserva (`reservationDate`): obrigatória, data pura `YYYY-MM-DD`; não pode ser futura (fuso do tenant) e seu ano não pode ser posterior ao exercício da dotação (`fiscalYear`). Valores fora disso → `VALIDATION_ERROR` (`RESERVATION_DATE_IN_FUTURE`, `RESERVATION_DATE_AFTER_FISCAL_YEAR`). Regra "a validar com o piloto" (dotação de exercício seguinte só é reservável depois da LOA do exercício).
- **RN-BUD-33** — Evidência obrigatória e verificada (RN-BUD-03 da feature, POL-25): `evidenceAttachmentId` deve apontar um `Attachment` do **mesmo tenant**, com `targetType = BUDGET_ALLOCATION` e `targetId` = esta dotação, não excluído e com `status = AVAILABLE` (limpo na varredura, com `sha256` e `scannedAt`). Falta de número, data ou evidência → `BUDGET_EVIDENCE_REQUIRED` (422, `meta.missing[]` ⊂ {`reservationNumber`, `reservationDate`, `evidence`}); evidência existente, mas ainda não `AVAILABLE` → `BUDGET_EVIDENCE_REQUIRED` com `meta.reason = NOT_AVAILABLE` e `meta.attachmentStatus`. Id inexistente, de outro tenant, de outro alvo ou excluído → `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`), igual para os quatro casos (sem vazar existência). Formato inválido (data malformada, número fora do padrão) → `VALIDATION_ERROR`.
- **RN-BUD-34** — Unicidade da reserva (RN-BUD-04 da feature): não pode haver duas dotações `CONFIRMED` com o mesmo (`reservationNumber` normalizado, `fiscalYear`) no tenant → `BUDGET_RESERVATION_DUPLICATED` (409, `meta.fiscalYear`). A resposta **não** cita processo, código nem unidade da outra dotação (o processo pode ser invisível ao usuário, DEC-024); `meta.sameProcess: boolean` indica se o conflito é no próprio processo. Garantida por índice único parcial; o mesmo número em outro tenant não conflita.
- **RN-BUD-35** — Efeito da confirmação (atômico): `status = CONFIRMED`; `reservationNumber`, `reservationDate`, `evidenceAttachmentId`, `confirmedAt = agora`, `confirmedById = ator`; `version + 1`; auditoria; evento; timeline; notificação após o *commit*. A confirmação **não** avança o processo nem altera a etapa; quem encaminha é a pessoa, depois da regra de saída (US-148).
- **RN-BUD-36** — Imutabilidade de `CONFIRMED` (RN-BUD-02 da feature): nenhum campo de negócio muda (classificação, valor, exercício, número, data, evidência, observações); trigger no banco recusa `UPDATE` que não seja a transição para `CANCELED` (e a atualização de `version`/`updatedAt`/`updatedById`). O `Attachment` da evidência e os anexos complementares de uma dotação `CONFIRMED` não podem ser excluídos nem substituídos por ninguém (o alvo deixa de ser editável): `ATT-06` responde `BUDGET_ALLOCATION_NOT_EDITABLE`, mesmo com `ATTACHMENT_DELETE`; o binário segue a retenção (DEC-034).
- **RN-BUD-37** — Concorrência e travas: confirmar e cancelar travam primeiro `processes` (`FOR UPDATE`, DEC-055 — a mesma trava do encaminhamento) e depois `budget_allocations` (ordem fixa, sem *deadlock*); `If-Match` protege a dotação. Duas confirmações da mesma dotação: a segunda recebe 412 `VERSION_CONFLICT` (ou 409 `BUDGET_ALLOCATION_NOT_EDITABLE` se já viu `CONFIRMED`). Duas dotações com o mesmo número no exercício: o índice único faz uma falhar com `BUDGET_RESERVATION_DUPLICATED`. Confirmar e encaminhar simultaneamente são serializados pela trava do processo.
- **RN-BUD-38** — Cobertura no ato: dentro da transação, com o processo travado, o sistema calcula `coverageReached` = Σ `reservedAmount` das `CONFIRMED` (incluindo esta) ≥ `Process.estimatedValue` vigente (`false` quando o valor estimado é nulo ou zero), pela regra da US-148, e publica só o booleano. Alterar o valor estimado enquanto se confirma é seguro: o `PATCH` do processo (PRC-05) e a conclusão da pesquisa de preços (US-032) escrevem a mesma linha do processo e, portanto, esperam ou são esperados pela trava; o resultado reflete o valor efetivamente comprometido e a regra de saída reavalia no encaminhamento.
- **RN-BUD-39** — Cancelar dotação `CONFIRMED` (`POST …/cancel`, BUD-11): `BUDGET_ALLOCATION_CONFIRM` + MFA (POL-14) + `If-Match` + `reason` de 10 a 1.000 caracteres; `CONFIRMED → CANCELED` com `canceledAt`, `canceledById`, `cancellationReason`; o texto do motivo fica na dotação (visível a quem tem `PROCESS_VIEW`) e **não** vai em evento nem em log (o evento leva `hasReason: true`). Dotação `CANCELED` é terminal: não reabre nem reconfirma; para refazer, indica-se nova dotação.
- **RN-BUD-40** — Autorização do cancelamento depois da saída da etapa: enquanto a etapa `DOTACAO` está ativa vale a RN-BUD-29. Depois da saída (ninguém tem custódia da etapa), o cancelamento é permitido a quem tem `BUDGET_ALLOCATION_CONFIRM` e é lotado na unidade da `ProcessStage` em que a dotação foi registrada (`processStageId`) ou é titular/substituto dela; fora disso → `NOT_PROCESS_CUSTODIAN`. A trava de processo e as demais regras se mantêm. *(Interpretação de POL-25 — "ou titular/substituto da unidade" — a validar com produto.)*
- **RN-BUD-41** — Status do processo no cancelamento: aceito em `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED` e `COMPLETED` (a reserva pode cair em qualquer ponto da vida do processo); recusado em `DRAFT` e `CANCELED` (`INVALID_PROCESS_STATUS`). A confirmação, ao contrário, só ocorre em `IN_PROGRESS` na etapa `DOTACAO`. *(Entities §4.2 diz "status editável"; ver Lacunas.)*
- **RN-BUD-42** — Efeitos do cancelamento (RN-BUD-06 da feature): a cobertura é recalculada na mesma transação (`coverageReached` no evento); se o processo ainda está em `DOTACAO`, a regra de saída volta a bloquear até nova cobertura (US-148); se **já passou** de `DOTACAO`, a entrada de timeline acrescenta "A cobertura do valor estimado ficou insuficiente." quando `coverageReached = false`, e a notificação `BUDGET_ALLOCATION_CANCELED` vai aos responsáveis das etapas ativas e ao gestor; **não há devolução nem bloqueio automático** do processo; os provedores `budget.*` das etapas seguintes (jurídico, controle interno, edital) passam a ler o novo estado.
- **RN-BUD-43** — Caminho do rascunho: `POST …/cancel` em `DRAFT` → `INVALID_STATE` (usar a remoção de rascunho, BUD-05, US-146); `DELETE` em `CONFIRMED` → `BUDGET_ALLOCATION_NOT_EDITABLE`. O cancelamento é idempotente por `Idempotency-Key`; repetir em dotação já `CANCELED` com outra chave → `BUDGET_ALLOCATION_NOT_EDITABLE`.
- **RN-BUD-44** — Evidência e anexos: o upload usa o mecanismo único da US-068 (`ATT-02`/`ATT-03`, ClamAV, allowlist e limite do tenant) com `targetType = BUDGET_ALLOCATION`; o alvo é editável enquanto a dotação está `DRAFT`, o processo está na etapa e o usuário tem `ATTACHMENT_UPLOAD` + (`BUDGET_ALLOCATION_MANAGE` ou `BUDGET_ALLOCATION_CONFIRM`) com custódia (POL-25). Uma dotação tem **uma** evidência (`evidenceAttachmentId`); anexos complementares são permitidos em `DRAFT`. Download (`ATT-05`) exige `PROCESS_VIEW` e, com orçamento sigiloso, `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (ou ser o responsável atual); auditoria `attachment.download`.
- **RN-BUD-45** — Declaração de dotação (BUD-12): `POST /processes/{id}/budget-allocations/declaration` exige `BUDGET_ALLOCATION_CONFIRM` + `DOCUMENT_CREATE` + `DOCUMENT_SUBMIT` + POL-02 para o tipo `DECLARACAO` na etapa atual + ao menos uma dotação `CONFIRMED` do processo. Cria `Document` `DECLARACAO` (título padrão "Declaração de dotação orçamentária — {código do processo}", `code` `DECL {seq:4}/{year}` pela máscara do tipo), preenche o corpo, finaliza (`DocumentFinalized`, versão `CONTENT`) e pede o PDF (`DocumentRendition` `CONTENT`, job `document-render` → Gotenberg). Resposta **202** com `documentId`, `documentVersionId` e `renditionId`; o PDF segue DOC-22/DOC-23. Cada chamada gera um documento novo (o tipo admite vários por processo); a mesma `Idempotency-Key` não duplica.
- **RN-BUD-46** — Conteúdo da declaração: cabeçalho do órgão e do processo (código, objeto); para cada dotação `CONFIRMED`, exercício, unidade orçamentária, programa de trabalho/ação, natureza da despesa, fonte de recursos, número e data da reserva e o nome do arquivo de evidência; **valor reservado** somente se o processo **não** for sigiloso — caso contrário o texto traz "Valor sigiloso (art. 24 da Lei 14.133/2021)" e o documento nasce com `confidentiality = RESTRICTED`; fecho com "Documento gerado em {data/hora} por {nome do usuário}, a partir das dotações confirmadas no ContrataFlow" e a observação de que não substitui a evidência anexada. Sem assinatura digital no MVP 2 (`SIGNED` é do MVP 3).
- **RN-BUD-47** — Independência e falhas da declaração: a geração do documento é transacional com o `DocumentFinalized`; o PDF é assíncrono (padrão da US-067: tentativas com *backoff*, `FAILED` + `DocumentRenditionFailed` + `DOCUMENT_RENDER_FAILED`). A falha ou a demora do Gotenberg **não** afeta a dotação nem a regra de saída; a declaração é derivada e não é pré-requisito de nada no MVP 2.
- **RN-BUD-48** — Eventos, timeline, notificação e auditoria sem valores: `BudgetAllocationConfirmed` (`budgetAllocationId`, `fiscalYear`, `hasEvidence: true`, `coverageReached`) e `BudgetAllocationCanceled` (`budgetAllocationId`, `fromStatus`, `hasReason`, `coverageReached`) não carregam valor; timeline `BUDGET_ALLOCATION_CONFIRMED`/`_CANCELED` com `reservationNumber` e `coverageReached` (visibilidade `STANDARD`; nunca valor); notificações `BUDGET_ALLOCATION_CONFIRMED` (responsável da etapa `DOTACAO` se ≠ ator e criador do processo; in-app; e-mail desligado) e `BUDGET_ALLOCATION_CANCELED` (de `CONFIRMED`: responsáveis das etapas ativas e gestor com `PROCESS_ASSIGN` no escopo; e-mail ligado); nunca notificar o próprio ator.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Número da reserva/pré-empenho | `reservationNumber` | texto (60) | Sim (confirmar) | RN-BUD-31; normalizado em maiúsculas; único por exercício entre `CONFIRMED` | — |
| Data da reserva | `reservationDate` | data (`YYYY-MM-DD`) | Sim (confirmar) | RN-BUD-32; não futura; ano ≤ exercício | — |
| Evidência | `evidenceAttachmentId` | uuid (`Attachment`) | Sim (confirmar) | RN-BUD-33; `AVAILABLE`, alvo = a dotação | lista dos anexos da dotação |
| Observações | `notes` | texto (2.000) | Não | só em `DRAFT`; na confirmação pode complementar | valor atual |
| Motivo do cancelamento | `reason` | texto (corpo do cancelamento) | Sim (cancelar) | 10 a 1.000 caracteres (RN-BUD-39) | — |
| Título da declaração | `title` | texto (5 a 250) | Não | RN-BUD-45 | "Declaração de dotação orçamentária — {código}" |
| *(sistema)* Situação | `status` | `BudgetAllocationStatus` | — | `DRAFT → CONFIRMED → CANCELED` | `CONFIRMED` / `CANCELED` |
| *(sistema)* Confirmação | `confirmedAt` / `confirmedById` | timestamptz / uuid | — | RN-BUD-35 | agora / ator |
| *(sistema)* Cancelamento | `canceledAt` / `canceledById` / `cancellationReason` | timestamptz / uuid / texto | — | RN-BUD-39 | agora / ator / motivo |
| *(sistema)* Cobertura atingida | `meta.coverageReached` | booleano | — | RN-BUD-38 | cálculo da transação |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Número, data ou evidência ausente | Front + API | "Para confirmar, informe o número e a data da reserva e anexe a evidência." | `BUDGET_EVIDENCE_REQUIRED` (`meta.missing[]`) |
| V-02 | Evidência ainda não verificada (`UPLOADED`/`SCANNING`) ou rejeitada | API | "A evidência ainda está sendo verificada ou foi rejeitada. Aguarde a verificação ou envie outro arquivo." | `BUDGET_EVIDENCE_REQUIRED` (`NOT_AVAILABLE`, `attachmentStatus`) |
| V-03 | Evidência inexistente, de outro órgão, de outra dotação ou excluída | API | "Selecione uma evidência válida desta dotação." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Número fora do padrão (caracteres, tamanho) | Front + API (Zod) | "O número da reserva aceita letras, números, espaço e . / - _ (até 60 caracteres)." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-05 | Data futura | Front + API | "A data da reserva não pode ser futura." | `VALIDATION_ERROR` (`RESERVATION_DATE_IN_FUTURE`) |
| V-06 | Ano da data posterior ao exercício | Front + API | "A reserva não pode ser de um ano posterior ao exercício da dotação." | `VALIDATION_ERROR` (`RESERVATION_DATE_AFTER_FISCAL_YEAR`) |
| V-07 | Reserva já usada em outra dotação confirmada do exercício | API | "Esta reserva já foi usada em outra dotação confirmada do órgão neste exercício. Confira o número." | `BUDGET_RESERVATION_DUPLICATED` |
| V-08 | Dotação não está em rascunho | API | "Esta dotação já foi confirmada ou cancelada e não pode ser confirmada de novo." | `BUDGET_ALLOCATION_NOT_EDITABLE` |
| V-09 | Motivo do cancelamento ausente ou fora de 10 a 1.000 caracteres | Front + API | "Informe o motivo do cancelamento (10 a 1.000 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`) |
| V-10 | Cancelar dotação em rascunho por este caminho | API | "Rascunhos são removidos, não cancelados. Use \"Remover rascunho\"." | `INVALID_STATE` |
| V-11 | Processo fora da etapa `DOTACAO` ao confirmar | API | "Só é possível confirmar a reserva enquanto o processo está na etapa de dotação." | `INVALID_STATE` (`NO_ACTIVE_BUDGET_STAGE`) |
| V-12 | Processo em status que não permite a operação | API | "O processo está {status} e não aceita esta operação." | `INVALID_PROCESS_STATUS` |
| V-13 | Sem dotação confirmada para gerar a declaração | API | "Confirme ao menos uma dotação para gerar a declaração." | `BUSINESS_RULE_VIOLATION` (`NO_CONFIRMED_ALLOCATION`) |
| V-14 | Sessão sem MFA quando exigido | API | "Confirme sua identidade com o segundo fator para continuar." | `MFA_REQUIRED` |

## Permissões
- **Permissão:** `BUDGET_ALLOCATION_CONFIRM` (risco `H`) com escopo que cubra o processo, para confirmar, cancelar dotação confirmada e gerar a declaração; `ATTACHMENT_UPLOAD` + (`BUDGET_ALLOCATION_MANAGE` ou `CONFIRM`) para anexar a evidência; `DOCUMENT_CREATE` e `DOCUMENT_SUBMIT` para a declaração; `PROCESS_VIEW` (+ `PROCESS_VIEW_CONFIDENTIAL_BUDGET` em orçamento sigiloso) para ler e baixar. Perfil padrão com `CONFIRM`: apenas `CONTABILIDADE`.
- **Políticas:** POL-25 (permissão + custódia da etapa `DOTACAO` ou titular/substituto + processo editável + evidência `AVAILABLE`); POL-09 (valor e evidência em processo sigiloso); POL-14 (MFA); POL-02 (documento `DECLARACAO` na etapa); DEC-024 (visibilidade).
- **MFA:** exigido em confirmar e cancelar quando `security.mfaPolicy` for `ADMINS` (perfil com permissão `HIGH`) ou `ALL`; sem MFA na sessão → `MFA_REQUIRED` (403) e a UI oferece o *step-up*. Não se aplica à geração da declaração.
- **Sem permissão:** a UI oculta "Confirmar reserva", "Cancelar dotação" e "Gerar declaração" para quem não tem a permissão (o gestor com `MANAGE` vê a dotação e o motivo "Somente a Contabilidade confirma a reserva"); na API, 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`/`MFA_REQUIRED` com auditoria `access.denied`; processo ou dotação invisível/de outro tenant → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `BudgetAllocationConfirmed` | `budget_allocation.confirmed` | Commit de BUD-10 | `budgetAllocationId`, `fiscalYear`, `hasEvidence: true`, `coverageReached`; sem valores; consumidores `T N R NR` |
| `BudgetAllocationCanceled` | `budget_allocation.canceled` | Commit de BUD-11 (e de BUD-05, US-146) | `budgetAllocationId`, `fromStatus = CONFIRMED`, `hasReason: true`, `coverageReached`; sem valores; consumidores `T N R NR` |
| `DocumentCreated` / `DocumentVersionCreated` / `DocumentFinalized` (`declaracao`) | `document.created.declaracao`, `document.version_created.declaracao`, `document.finalized.declaracao` | Commit de BUD-12 | Eventos genéricos de documento (US-063/US-065); `typedSummary` ausente |
| `DocumentRenditionReady` / `DocumentRenditionFailed` | `document.rendition_ready` / `document.rendition_failed` | Worker `document-render` | US-067; a falha notifica `DOCUMENT_RENDER_FAILED` |
| `AttachmentUploaded` / `AttachmentRejected` | `attachment.uploaded` / `attachment.rejected` | Worker `file-scan` | US-068 para a evidência (`targetType = BUDGET_ALLOCATION`) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `BUDGET_ALLOCATION_CONFIRMED` | Responsável da etapa `DOTACAO` (se ≠ ator) e criador do processo | in-app (e-mail desligado por padrão; não obrigatória) | `BudgetAllocationConfirmed` |
| `BUDGET_ALLOCATION_CANCELED` | Responsáveis das etapas ativas; gestor (`PROCESS_ASSIGN` no escopo) — nunca o ator (máx. 50) | in-app + e-mail (padrão ligado); não obrigatória | `BudgetAllocationCanceled` de dotação `CONFIRMED` |
| `ATTACHMENT_REJECTED` | Quem enviou a evidência | in-app (obrigatória) | `AttachmentRejected` (US-068) |
| `DOCUMENT_RENDER_FAILED` | Quem pediu a declaração | in-app | `DocumentRenditionFailed` após esgotar tentativas (US-067) |

Texto das notificações sem valores: "A dotação (reserva {reservationNumber}) do processo {código} foi confirmada." / "…foi cancelada." e, se `coverageReached = false`, "A cobertura do valor estimado ficou insuficiente."

## Critérios de aceite em Gherkin
```gherkin
Feature: Confirmar a reserva com evidência e cancelar dotação

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "DOTACAO" com valor estimado de 100.000,00
    And "Marcos", da Contabilidade, tem "BUDGET_ALLOCATION_CONFIRM" e é o responsável pela etapa "DOTACAO"
    And existe a dotação "DRAFT" de 60.000,00 no exercício 2026 com "version" 1
    And existe o anexo "reserva-123.pdf" "AVAILABLE" com alvo "BUDGET_ALLOCATION" nessa dotação

  Scenario: [Sucesso] Confirmar a reserva com número, data e evidência
    When "Marcos" confirmar a dotação com número "PE 123/2026", data de 2026-03-10 e a evidência "reserva-123.pdf", enviando "If-Match" "1"
    Then a API deve responder 200 com "status" "CONFIRMED", "reservationNumber" "PE 123/2026" e "version" 2
    And "confirmedAt" e "confirmedById" devem estar preenchidos
    And deve gerar registro de auditoria "budget_allocation.confirm"
    And deve gerar o evento "BudgetAllocationConfirmed" com "hasEvidence" verdadeiro e sem valores
    And a timeline deve registrar "Marcos confirmou a dotação (reserva PE 123/2026)"
    And o responsável da etapa e o criador do processo, se diferentes de "Marcos", devem receber a notificação "BUDGET_ALLOCATION_CONFIRMED"
    And o processo deve continuar na etapa "DOTACAO"

  Scenario: [Sucesso] Segunda dotação completa a cobertura
    Given que a primeira dotação de 60.000,00 já está "CONFIRMED" e existe outra "DRAFT" de 40.000,00 com evidência disponível
    When "Marcos" confirmar a segunda dotação com o número "PE 124/2026"
    Then o evento "BudgetAllocationConfirmed" deve ter "coverageReached" verdadeiro

  Scenario: [Sucesso] Cancelar dotação confirmada depois da saída da etapa
    Given que existem duas dotações "CONFIRMED" (60.000,00 e 40.000,00) e o processo já está na etapa "JURIDICO"
    And "Marcos" pertence à unidade que respondeu pela etapa "DOTACAO" e tem "BUDGET_ALLOCATION_CONFIRM"
    When "Marcos" cancelar a dotação de 40.000,00 informando o motivo "Reserva anulada pela Contabilidade em 12/03"
    Then a dotação deve ficar "CANCELED" com o motivo e "canceledById" de "Marcos"
    And o evento "BudgetAllocationCanceled" deve ter "fromStatus" "CONFIRMED" e "coverageReached" falso, sem valores
    And a timeline deve registrar o cancelamento e "A cobertura do valor estimado ficou insuficiente."
    And o responsável da etapa "JURIDICO" e o gestor com "PROCESS_ASSIGN" devem receber a notificação "BUDGET_ALLOCATION_CANCELED"
    And o processo não deve ser devolvido nem bloqueado automaticamente

  Scenario: [Sucesso] Gerar a declaração de dotação em PDF
    Given que existe uma dotação "CONFIRMED" no processo "0045/2026"
    When "Marcos" gerar a declaração de dotação
    Then a API deve responder 202 com "documentId", "documentVersionId" e "renditionId"
    And deve existir um documento "DECLARACAO" finalizado com o código no formato "DECL 0001/2026"
    And o PDF deve ficar "READY" e ser baixável por URL assinada de até 300 s

  Scenario: [Sucesso] Orçamento sigiloso: declaração e evidência sem valores para quem não pode vê-los
    Given que o processo é sigiloso e "Paulo" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Marcos" gerar a declaração
    Then o documento deve ter "confidentiality" "RESTRICTED" e o texto "Valor sigiloso" no lugar do valor
    And "Paulo" não deve conseguir baixar a evidência da dotação

  Scenario: [Validação] Confirmar sem número, sem data ou sem evidência
    When "Marcos" confirmar a dotação sem informar a evidência
    Then a API deve responder 422 com "BUDGET_EVIDENCE_REQUIRED" e "meta.missing" contendo "evidence"
    When "Marcos" confirmar a dotação sem número e sem data
    Then a API deve responder 422 com "BUDGET_EVIDENCE_REQUIRED" e "meta.missing" contendo "reservationNumber" e "reservationDate"
    And a dotação deve continuar "DRAFT"

  Scenario: [Validação] Data futura, ano posterior ao exercício e evidência em verificação
    When "Marcos" confirmar com data de amanhã
    Then a API deve responder 422 com o código "RESERVATION_DATE_IN_FUTURE"
    Given que o anexo da evidência está "SCANNING"
    When "Marcos" confirmar a dotação com essa evidência
    Then a API deve responder 422 com "BUDGET_EVIDENCE_REQUIRED", "meta.reason" "NOT_AVAILABLE" e "meta.attachmentStatus" "SCANNING"

  Scenario: [Validação] Cancelar sem motivo suficiente e cancelar rascunho
    When "Marcos" cancelar uma dotação confirmada com o motivo "erro"
    Then a API deve responder 422 com "VALIDATION_ERROR" no campo "reason"
    When "Marcos" chamar o cancelamento sobre uma dotação em "DRAFT"
    Then a API deve responder 409 com "INVALID_STATE"

  Scenario: [Permissão] Gestor só indica, não confirma
    Given que "Clara", gestora, tem "BUDGET_ALLOCATION_MANAGE" mas não "BUDGET_ALLOCATION_CONFIRM"
    When "Clara" tentar confirmar a dotação
    Then a API deve responder 403 com "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    And a UI não deve exibir "Confirmar reserva"

  Scenario: [Permissão] Sem custódia, sem MFA e unidade errada no cancelamento tardio
    Given que "Rui" tem "BUDGET_ALLOCATION_CONFIRM" mas não é responsável pela etapa "DOTACAO"
    When "Rui" tentar confirmar a dotação
    Then a API deve responder 403 com "NOT_PROCESS_CUSTODIAN"
    Given que a política de MFA do órgão exige o segundo fator e a sessão de "Marcos" não o tem
    When "Marcos" tentar confirmar a dotação
    Then a API deve responder 403 com "MFA_REQUIRED"
    Given que o processo já saiu de "DOTACAO" e "Rui" é de outra unidade
    When "Rui" tentar cancelar uma dotação confirmada
    Then a API deve responder 403 com "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Evidência, processo e reserva de outro tenant
    Given que existe o anexo "reserva-b.pdf" "AVAILABLE" no tenant "Prefeitura B" e o processo "0031/2026" nesse tenant
    When "Marcos", no tenant "Prefeitura A", usar o id desse anexo como evidência
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" no campo "evidenceAttachmentId", idêntico ao de um id inexistente
    When "Marcos" tentar confirmar ou cancelar uma dotação do processo "0031/2026"
    Then a API deve responder 404 com "NOT_FOUND" sem revelar dado do tenant "Prefeitura B"
    Given que o tenant "Prefeitura B" já confirmou a reserva "PE 123/2026" no exercício 2026
    When "Marcos" confirmar "PE 123/2026" no exercício 2026
    Then a confirmação deve ser aceita, sem conflito e sem pista de que o outro tenant usa o número

  Scenario: [Duplicidade] Mesma reserva em duas dotações e reenvio idempotente
    Given que a dotação "A" já está "CONFIRMED" com a reserva "PE 123/2026" no exercício 2026
    When "Marcos" tentar confirmar a dotação "B", de outro processo, com o número "pe 123/2026"
    Then a API deve responder 409 com "BUDGET_RESERVATION_DUPLICATED" e "meta.fiscalYear" 2026
    And a resposta não deve citar o processo da dotação "A"
    Given que "Marcos" confirmou a dotação "B" com a reserva "PE 124/2026" e "Idempotency-Key" "k-147"
    When a mesma requisição for reenviada
    Then a API deve responder com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir um único evento "BudgetAllocationConfirmed" e uma única auditoria "budget_allocation.confirm"
    When "Marcos" tentar confirmar a dotação "B" de novo com outra chave
    Then a API deve responder 409 com "BUDGET_ALLOCATION_NOT_EDITABLE"

  Scenario: [Concorrência] Duas confirmações simultâneas da mesma dotação
    Given que "Marcos" e "Carla", da Contabilidade, confirmam a mesma dotação com a "version" 1 ao mesmo tempo
    When as duas requisições chegarem
    Then somente uma deve responder 200 com "CONFIRMED"
    And a outra deve responder 412 com "VERSION_CONFLICT" ou 409 com "BUDGET_ALLOCATION_NOT_EDITABLE"
    And deve existir um único evento "BudgetAllocationConfirmed"

  Scenario: [Concorrência] Mesmo número de reserva em duas dotações ao mesmo tempo
    When "Marcos" confirmar a dotação "A" e "Carla" a dotação "B", ambas com "PE 125/2026" no exercício 2026, ao mesmo tempo
    Then uma delas deve ser confirmada e a outra deve responder 409 com "BUDGET_RESERVATION_DUPLICATED"

  Scenario: [Concorrência] Valor estimado muda enquanto a dotação é confirmada
    Given que a pesquisa de preços é concluída e eleva o valor estimado de 100.000,00 para 130.000,00 no mesmo instante da confirmação
    When a confirmação e a atualização do processo disputam a trava do processo
    Then as duas operações devem ser serializadas
    And o evento "BudgetAllocationConfirmed" deve refletir o valor estimado vigente quando a trava foi obtida
    And a regra de saída deve ser reavaliada no encaminhamento

  Scenario: [Falha de banco] Falha ao gravar a confirmação
    Given que o banco falha ao gravar o evento de outbox depois de atualizar a dotação
    When "Marcos" confirmar a dotação
    Then a API deve responder 503 com "DEPENDENCY_UNAVAILABLE"
    And a dotação deve continuar "DRAFT" com "version" 1
    And nenhuma auditoria, entrada de timeline, notificação ou evento deve ter sido gravado
    And a evidência deve continuar "AVAILABLE" e disponível para nova tentativa

  Scenario: [Falha de integração] Antivírus fora do ar retém a evidência
    Given que o ClamAV está indisponível e o anexo da evidência está retido em "SCANNING"
    When "Marcos" tentar confirmar a dotação
    Then a API deve responder 422 com "BUDGET_EVIDENCE_REQUIRED" e "meta.reason" "NOT_AVAILABLE"
    And o anexo nunca deve ser promovido a "AVAILABLE" sem varredura limpa
    When o ClamAV voltar e o anexo ficar "AVAILABLE"
    Then a confirmação deve ser aceita

  Scenario: [Falha de integração] Gotenberg fora do ar não afeta a dotação
    Given que o Gotenberg está indisponível
    When "Marcos" gerar a declaração de dotação
    Then a API deve responder 202 e o documento "DECLARACAO" deve ser criado e finalizado
    And a renderização deve falhar após as tentativas com "DocumentRenditionFailed"
    And "Marcos" deve receber a notificação "DOCUMENT_RENDER_FAILED"
    And a dotação deve continuar "CONFIRMED"
    When "Marcos" pedir o PDF de novo depois que o Gotenberg voltar
    Then a renderização deve terminar "READY"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Número, data ou evidência ausente | 422 | `BUDGET_EVIDENCE_REQUIRED` | "Para confirmar, informe o número e a data da reserva e anexe a evidência." | Destaca os campos faltantes |
| Evidência ainda em verificação ou rejeitada | 422 | `BUDGET_EVIDENCE_REQUIRED` | "A evidência ainda está sendo verificada ou foi rejeitada. Aguarde a verificação ou envie outro arquivo." | Mantém o formulário; mostra o estado do anexo |
| Evidência inexistente/de outro alvo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma evidência válida desta dotação." | Recarrega a lista de anexos |
| Formato, data futura, ano posterior | 422 | `VALIDATION_ERROR` | "Corrija os campos destacados." | Erro por campo |
| Reserva duplicada no exercício | 409 | `BUDGET_RESERVATION_DUPLICATED` | "Esta reserva já foi usada em outra dotação confirmada do órgão neste exercício. Confira o número." | Foco no campo número |
| Dotação não está em rascunho | 409 | `BUDGET_ALLOCATION_NOT_EDITABLE` | "Esta dotação já foi confirmada ou cancelada." | Recarrega a dotação |
| Cancelar rascunho por este caminho | 409 | `INVALID_STATE` | "Rascunhos são removidos, não cancelados." | Oferece "Remover rascunho" |
| Processo fora da etapa ao confirmar | 409 | `INVALID_STATE` | "Só é possível confirmar a reserva enquanto o processo está na etapa de dotação." | Painel em leitura |
| Status do processo não permite | 409 | `INVALID_PROCESS_STATUS` | "O processo está {status} e não aceita esta operação." | Mostra o motivo |
| Sem a permissão de confirmar | 403 | `PERMISSION_DENIED` | "Somente a Contabilidade pode confirmar a reserva." | Oculta a ação |
| Sem custódia / unidade incorreta | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não responde pela etapa de dotação deste processo." | Mostra o motivo |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Abre o *step-up* e reenvia |
| Dotação/processo de outro tenant ou invisível | 404 | `NOT_FOUND` | "Dotação não encontrada." | Volta ao processo |
| Sem dotação confirmada para a declaração | 422 | `BUSINESS_RULE_VIOLATION` | "Confirme ao menos uma dotação para gerar a declaração." | Desabilita a ação |
| Dotação alterada por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou esta dotação. Recarregue e tente de novo." | Recarrega e mantém o digitado |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a dotação e tente de novo." | Recarrega |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega |
| Renderização do PDF falhou | 200 (`rendition.status = FAILED`) | `DOCUMENT_RENDER_FAILED` (notificação) | "Não foi possível gerar o PDF agora. Tente novamente." | Botão "Gerar PDF novamente" |
| Banco/armazenamento indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | "Tentar novamente"; mantém o formulário |

## Dependências
- **Stories:** US-068 (upload seguro e varredura da evidência), US-146 (dotação em rascunho, painel, sigilo e catálogos). Indiretas: US-063/US-065 (documento livre e finalização, para a declaração), US-067 (PDF por Gotenberg), US-047 (trava de processo no encaminhamento), US-097 (autorização), US-103 (política de MFA). Habilita a US-148 (cobertura e regra de saída) e as conferências do jurídico e do controle interno.
- **Decisões/ADRs:** DEC-198, DEC-196, DEC-030, DEC-136, DEC-055, DEC-034, DEC-104, DEC-105, DEC-161; POL-25, POL-09, POL-14, POL-02.
- **Configurações:** `security.mfaPolicy` (MVP 1). A severidade da regra de cobertura (`budget.coverageRuleSeverity`) é da US-148.
- **Lacunas nas fontes canônicas:**
  1. **IDs de endpoint** `BUD-10` (confirmar), `BUD-11` (cancelar dotação confirmada) e `BUD-12` (gerar declaração), faixa BUD-10..BUD-19; as rotas indicativas da feature (`POST /budget-allocations/{id}/confirm|cancel`) foram aninhadas no processo. Consolidar no `api.md` do MVP 2.
  2. **Código de erro novo:** `BUDGET_RESERVATION_DUPLICATED` (409). Códigos de campo novos em `VALIDATION_ERROR`: `RESERVATION_DATE_IN_FUTURE`, `RESERVATION_DATE_AFTER_FISCAL_YEAR`, `INVALID_FORMAT` (número). Subcódigos: `NO_CONFIRMED_ALLOCATION` (`BUSINESS_RULE_VIOLATION`); `meta.missing[]`, `meta.reason`/`meta.attachmentStatus` em `BUDGET_EVIDENCE_REQUIRED`; `meta.sameProcess` em `BUDGET_RESERVATION_DUPLICATED`. `BUDGET_EVIDENCE_REQUIRED` cobre também número e data ausentes (POL-25/RN-BUD-03 falam em "sem elas").
  3. **Status do processo no cancelamento:** entities §4.2 e POL-25 exigem "processo em status editável" para confirmar **e cancelar**; o cenário da feature (cancelar depois da saída da etapa) exige cancelar com o processo fora de `DOTACAO` e, às vezes, em `AWAITING_APPROVAL`/`COMPLETED`. Adotado: confirmar só em `IN_PROGRESS` na etapa; cancelar em qualquer status exceto `DRAFT`/`CANCELED` (RN-BUD-41). Confirmar com produto.
  4. **Autorização do cancelamento depois da saída da etapa** (RN-BUD-40): POL-25 fala de "custódia da etapa `DOTACAO`", inexistente depois da saída. Adotada a unidade da passagem em que a dotação foi registrada (`processStageId` → unidade). Confirmar com produto.
  5. **Declaração de dotação:** não existe `DocumentType` próprio. Usado o `DECLARACAO` semeado (FREE_TEXT, `DECL {seq:4}/{year}`) e é preciso (a) uma capacidade de criação de documento pelo servidor com **corpo preenchido** (`DocumentFacade`: criar `DECLARACAO` a partir do modelo e gravar as seções com o texto das dotações; hoje o corpo só nasce do `defaultContent` do modelo com variáveis do §5.2) e (b) um modelo de `DECLARACAO` com a seção "Dotação orçamentária". Alternativa para produto: tipo novo `DECLARACAO_DOTACAO` com modelo próprio e variáveis `budget.*`. Confirmar se a declaração deve existir no MVP 2.
  6. **Anexos de `BUDGET_ALLOCATION`:** o `AttachmentTargetResolver` do módulo `budget` (previsto em entities MVP 2, ampliação de `AttachmentTargetType`) precisa definir "alvo editável" (RN-BUD-44), a imutabilidade após `CONFIRMED` (inclusive contra `ATTACHMENT_DELETE`, RN-BUD-36) e o sigilo no download (`ATT-05` hoje só cita POL-09 para documentos). POL-09 (permissions MVP 2) não menciona anexos de dotação; propõe-se estendê-la à evidência.
  7. **Normalização do número da reserva** (maiúsculas, espaços) e limite de 1.000 caracteres do motivo de cancelamento: regras novas (a entidade só exige ≥ 10).
  8. **Índice único parcial** `(tenant_id, reservation_number, fiscal_year) WHERE status = 'CONFIRMED'` já está em entities §4.2; o número gravado já é o normalizado (RN-BUD-31).
  9. **Notificação em lote:** o limite de 50 destinatários vale para `BUDGET_ALLOCATION_CANCELED` (regra geral do MVP 1).

## Impacto técnico
- **Atomicidade e travas:** a transação trava `processes` e depois `budget_allocations` (ordem fixa), valida a evidência dentro da transação (releitura do `Attachment`, que só pode sair de `AVAILABLE` por exclusão lógica, bloqueada para alvos confirmados) e grava dotação, auditoria, outbox e timeline juntos. A notificação e o pedido de PDF só saem depois do *commit* (padrão B de queues.md).
- **Ato humano:** a política rejeita `actorType ≠ USER`; sem endpoint de confirmação em lote e sem automação por regra (RN-BUD-29); MFA conforme POL-14.
- **Evidência verificável:** `sha256`, tamanho e `scannedAt` do anexo entram na auditoria da confirmação; o arquivo é baixado por URL assinada de uso único (ATT-05) e auditado.
- **Imutabilidade em duas camadas:** serviço (`BudgetAllocation.confirm()`/`cancel()`) e trigger do banco; testes tentam `UPDATE` direto com a role da aplicação.
- **Performance:** confirmar e cancelar fazem 2 travas, 1 agregação de cobertura (índice `(tenant_id, process_id, status)`) e inserções; meta p95 ≤ 300 ms (suíte de performance, endurecimento). A geração da declaração é assíncrona: PDF p95 ≤ 30 s (SLO de `CONTENT`, US-067).
- **Sigilo:** valores nunca em evento, notificação, timeline, log ou `metadata` de auditoria; declaração em processo sigiloso sem valor e `RESTRICTED`. Risco residual: ativar o sigilo **depois** de gerar uma declaração com valor (RN-PROC-139 só trata a pesquisa de preços) — propor que PRC-33 marque as declarações de dotação do processo como `RESTRICTED` (ajuste à US-013).
- **Compatibilidade:** respostas aditivas (DEC-108); nenhuma mudança em contratos do MVP 1 além do resolvedor de anexos.

## Backend
- **Módulo(s):** `budget` (dono de `BudgetAllocation`, confirmação, cancelamento, declaração), `process` (trava, etapa, custódia, status, sigilo), `files` (resolvedor de anexos `BUDGET_ALLOCATION`), `document` (fachada de criação, finalização e renderização), `timeline`, `notification`, `audit`, `platform` (outbox, idempotência, MFA).
- **Casos de uso:** `ConfirmBudgetAllocationCommand`, `CancelBudgetAllocationCommand`, `GenerateBudgetDeclarationCommand`, `BudgetAttachmentTargetResolver` (alvo `BUDGET_ALLOCATION`), `BudgetCoverageCalculator` (função de domínio usada também pela US-148).
- **Domínio:** `BudgetAllocation.confirm({ reservationNumber, reservationDate, evidence, actor })` e `cancel({ reason, actor })` (transições e invariantes de RN-BUD-30..43); `ReservationNumber` (normalização); `EvidencePolicy` (anexo `AVAILABLE` do alvo e do tenant); `BudgetCancellationPolicy` (RN-BUD-40/41); `BudgetDeclarationBuilder` (conteúdo, RN-BUD-46).
- **Integrações internas:** `ProcessFacade` (trava `FOR UPDATE`, etapa, status, custódia da etapa ou da unidade, `estimatedValue`, `isBudgetConfidential`), `AttachmentFacade` (leitura do anexo e estado de varredura), `DocumentFacade` (criar `DECLARACAO`, finalizar, pedir `CONTENT`), `AuthorizationService` + `IdentityFacade` (MFA da sessão, POL-14), `OutboxWriter`, `NotificationDispatcher`.
- **Transação:** confirmar/cancelar: `app.tenant_id` → trava do processo → trava da dotação → autorização → validações → transição → auditoria → outbox → timeline; declaração: autorização → documento + versão `CONTENT` + `DocumentRendition` `PENDING` → auditoria → outbox; job de PDF enfileirado após o *commit*.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — painel "Dotação orçamentária": ações "Anexar evidência", "Confirmar reserva", "Cancelar dotação" e "Gerar declaração de dotação" por dotação/processo. Sem rota nova.
- **Componentes:** `EvidenceUploader` (reaproveita o fluxo de anexos da US-068, com estados "Enviando", "Verificando…", "Disponível", "Rejeitado"), `ConfirmReservationDialog` (número, data, evidência, aviso de ato definitivo), `CancelAllocationDialog` (motivo, contagem de caracteres), `MfaStepUp` (MVP 1), `AllocationStatusBadge`, `DeclarationButton`/`RenditionStatus`, `TimelineNotice` (aviso de cobertura insuficiente).
- **Estados:** loading (skeleton); anexo em verificação (botão "Confirmar" desabilitado com o motivo); erro por campo; sucesso (toast "Reserva confirmada" e cartão `Confirmada` sem ações de edição); conflito 412 (diálogo de recarga); falha de PDF com "Gerar PDF novamente"; modo somente leitura quando o usuário não tem `CONFIRM`.
- **Acessibilidade e responsividade:** diálogos com foco preso e retorno do foco, `aria-describedby` no aviso de ato definitivo, progresso do upload em `aria-live="polite"`, situação do anexo por texto e ícone; data com `DatePicker` navegável por teclado e entrada digitada `dd/mm/aaaa`; formulário em tela cheia abaixo de 640 px; ações do cartão no menu "⋯" em telas estreitas.

## Banco de dados
- **Tabelas:** `budget_allocations` (campos de confirmação e cancelamento), `attachments` (alvo `BUDGET_ALLOCATION`), `documents`, `document_versions`, `document_renditions` (declaração), `audit_logs`, `outbox_events`, `process_timeline_entries`, `notifications`.
- **Migrações:** nenhuma tabela nova além de `budget_allocations` (US-146); o valor `BUDGET_ALLOCATION` de `AttachmentTargetType` vem do M2-01; semeadura do modelo de `DECLARACAO` com a seção da dotação (lacuna 5).
- **Índices/constraints relevantes:** único parcial `(tenant_id, reservation_number, fiscal_year) WHERE status = 'CONFIRMED' AND reservation_number IS NOT NULL`; check `status <> 'CONFIRMED' OR (reservation_number IS NOT NULL AND reservation_date IS NOT NULL AND evidence_attachment_id IS NOT NULL AND confirmed_at IS NOT NULL)`; check `status <> 'CANCELED' OR cancellation_reason IS NOT NULL`; FK composta `(tenant_id, evidence_attachment_id)` → `attachments`; trigger de imutabilidade de `CONFIRMED` (só transição para `CANCELED`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `BUD-10` | POST | `/processes/{id}/budget-allocations/{allocationId}/confirm` | `{ reservationNumber, reservationDate, evidenceAttachmentId, notes? }` + `If-Match` + `Idempotency-Key` | `200 { data: BudgetAllocation (CONFIRMED), meta: { coverageReached } }` + novo `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `BUD-11` | POST | `/processes/{id}/budget-allocations/{allocationId}/cancel` | `{ reason }` + `If-Match` + `Idempotency-Key` | `200 { data: BudgetAllocation (CANCELED), meta: { coverageReached } }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `BUD-12` | POST | `/processes/{id}/budget-allocations/declaration` | `{ title? }` + `Idempotency-Key` | `202 { data: { documentId, documentVersionId, renditionId, code } }` | 202, 403, 404, 409, 422, 503 |
| `ATT-02` | POST | `/attachments` | `{ targetType: "BUDGET_ALLOCATION", targetId, fileName, declaredMimeType, sizeBytes, categoryId? }` (US-068) | `201` com URL assinada | 201, 403, 404, 409, 413, 415, 422 |
| `ATT-03` | POST | `/attachments/{id}/confirm` | — | `202` (varredura) | 202, 409 |
| `ATT-01` | GET | `/processes/{id}/attachments` | como na US-069 (o painel filtra a lista por `targetType = BUDGET_ALLOCATION` e `targetId`) | lista com `status` | 200 |
| `ATT-04` | GET | `/attachments/{id}` | — | anexo e estado de varredura | 200, 404 |
| `ATT-05` | GET | `/attachments/{id}/download` | — | `{ url, expiresAt }` (POL-09 para alvo de dotação em processo sigiloso) | 200, 403, 404, 409 |
| `DOC-21` | POST | `/document-versions/{versionId}/renditions` | `{ kind: "CONTENT" }` | `202` (nova tentativa de PDF) | 202, 403, 404 |
| `DOC-22` | GET | `/document-renditions/{renditionId}` | — | estado do PDF | 200 |
| `DOC-23` | GET | `/document-renditions/{renditionId}/download` | — | `{ url, expiresAt }` | 200, 409 |

Exemplo de erro de `BUD-10` sem evidência:
```json
{
  "error": {
    "code": "BUDGET_EVIDENCE_REQUIRED",
    "message": "Para confirmar, informe o número e a data da reserva e anexe a evidência.",
    "meta": { "missing": ["reservationDate", "evidence"] },
    "correlationId": "…"
  }
}
```

## Logs
- `info` `budget.allocation.confirmed` — `allocationId`, `processId`, `fiscalYear`, `coverageReached`, `evidenceAttachmentId`, `durationMs`; `info` `budget.allocation.canceled` — `allocationId`, `fromStatus`, `afterStageExit` (booleano), `coverageReached`; `info` `budget.declaration.requested` — `documentId`, `renditionId`.
- `warn` `budget.allocation.confirm_rejected` — `reason` (`EVIDENCE_NOT_AVAILABLE`, `EVIDENCE_MISSING`, `RESERVATION_DUPLICATED`, `NOT_EDITABLE`, `NO_CUSTODY`, `MFA_REQUIRED`); `warn` `budget.declaration.rendition_failed` — `renditionId`, `errorCode`.
- `error` `budget.allocation.persist_failed` — `processId`, causa técnica.
- **Nunca logar:** `reservedAmount` ou outro valor monetário, `reservationNumber` junto de identificação de pessoa, texto do motivo do cancelamento, conteúdo ou nome do arquivo da evidência, URL assinada, `Idempotency-Key`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `budget_allocation.confirm` | `WORKFLOW` | Commit de BUD-10 | `changes`: `status` DRAFT → CONFIRMED, `reservationNumber`, `reservationDate`, `evidenceAttachmentId`. `metadata`: `processId`, `fiscalYear`, `evidenceSha256`, `coverageReached`, `mfa` (nível usado), `idempotencyKey`; sem valor |
| `budget_allocation.cancel` | `WORKFLOW` | Commit de BUD-11 (e BUD-05) | `changes`: `status` CONFIRMED → CANCELED. `metadata`: `processId`, `fromStatus`, `afterStageExit`, `coverageReached`, `hasReason` (o texto fica em `cancellationReason`); sem valor |
| `document.create` / `document.finalize` | `WORKFLOW` | Commit de BUD-12 | como na US-063/US-065, com `metadata.source = "BUDGET_DECLARATION"` |
| `attachment.upload_intent` / `attachment.confirm` / `attachment.scan_result` / `attachment.download` | `DATA_CHANGE` / `ACCESS` | Fluxo da evidência | como na US-068/US-069 (`targetType = BUDGET_ALLOCATION`) |
| `access.denied` | `ACCESS` | Tentativa sem permissão, custódia ou MFA | `reasonCode` (`PERMISSION_DENIED`, `NOT_PROCESS_CUSTODIAN`, `MFA_REQUIRED`) |

## Testes necessários
- **Unitários:** `ReservationNumber` (normalização, caracteres, tamanho); validação de data (hoje no fuso do tenant, virada de dia, ano ≤ exercício); `EvidencePolicy` (alvo, tenant, `AVAILABLE`, excluído); transições de `BudgetAllocation` (`DRAFT → CONFIRMED → CANCELED`, terminalidade, imutabilidade); `BudgetCancellationPolicy` (durante a etapa, depois da saída, unidade da passagem, status do processo); `BudgetCoverageCalculator` (soma em centavos, valor estimado nulo/zero); `BudgetDeclarationBuilder` (com e sem sigilo).
- **Integração (Testcontainers PostgreSQL + Redis + MinIO + ClamAV/stub + Gotenberg/stub):** confirmação atômica (rollback com falha de outbox); índice único da reserva e liberação do número após cancelar; trigger de imutabilidade (UPDATE direto recusado); `ATT-06` recusado em alvo confirmado; anexo `SCANNING`/`INFECTED` recusado como evidência; trava `FOR UPDATE` serializando confirmar, cancelar, encaminhar e `PATCH` do valor estimado; declaração (documento, versão, rendition) e falha do Gotenberg com nova tentativa; notificações e timeline.
- **API/contrato:** BUD-10 a BUD-12 contra o OpenAPI; `meta.missing[]`; `Idempotent-Replayed`; `ETag`/`If-Match`; códigos V-01..V-14; resposta de `BUDGET_RESERVATION_DUPLICATED` sem dados de outro processo.
- **RBAC e multi-tenant:** matriz perfil × permissão (`CONTABILIDADE`, gestor só com `MANAGE`, sem custódia, unidade errada no cancelamento tardio, MFA); evidência, dotação e processo de outro tenant → 404/`REFERENCE_NOT_FOUND` indistinguível do inexistente; mesmo número em dois tenants sem conflito (suíte `test/tenant-leak`, arquivo `budget-confirmation.tenant-leak.test.ts`); evidência e declaração sem valores para quem não pode vê-los; nenhum valor em eventos, notificações, timeline, logs e auditoria.
- **Concorrência:** duas confirmações da mesma dotação; duas dotações com o mesmo número; cancelar × encaminhar (serializados pela trava); confirmar × alteração do valor estimado; reenvio idempotente em paralelo.
- **E2E (Playwright):** anexar evidência, esperar a verificação, confirmar com MFA e ver a dotação imutável; cancelar depois da saída da etapa e ver o aviso na timeline; gerar a declaração e baixar o PDF; evidência rejeitada e novo envio.
- **Acessibilidade/performance:** axe nos diálogos de confirmação e cancelamento e no envio da evidência; p95 de confirmar/cancelar e do PDF da declaração na suíte de performance (medida no endurecimento).

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
- [ ] Imutabilidade de `CONFIRMED` verificada no serviço e no banco (trigger)
- [ ] Teste prova que nenhuma regra, job ou integração confirma dotação sem ator `USER`
- [ ] Teste de falha do ClamAV e do Gotenberg sem efeito indevido sobre a dotação

## Estimativa
**M** — transição com evidência verificada (reuso da US-068), unicidade da reserva, imutabilidade em serviço e banco, MFA e travas de processo, cancelamento com regras de autorização depois da saída da etapa, notificações e a declaração em PDF por documento do processo.

## Prioridade
**P0** — sem a confirmação com evidência não existe dotação que conte para a cobertura (US-148) nem para a regra de saída da etapa `DOTACAO`; é o ato de controle central do épico (DEC-198) e requisito da v2 do workflow padrão (US-130).
