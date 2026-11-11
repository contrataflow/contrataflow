---
id: US-153
title: "Pedir diligência e retomar a análise"
epic: EP-025
feature: FT-074
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-048, US-066, US-152]
modules: [legal-review, process, workflow, document, timeline, notification, audit, access]
screens: [SCR-019, SCR-006, SCR-104, SCR-013]
endpoints: [LGL-13, LGL-14, LGL-15, LGL-02, LGL-11, LGL-12, PRC-20]
permissions: [LEGAL_REVIEW_MANAGE, LEGAL_REVIEW_VIEW, PROCESS_RETURN, PROCESS_VIEW]
events: [LegalReviewDiligenceRequested, LegalReviewDiligenceReminderDue, LegalReviewResumed]
---

# US-153 — Pedir diligência e retomar a análise

## Título
Pedir diligência ao requisitante e retomar a análise jurídica em nova rodada

## Descrição
**Como** procurador que está analisando um processo e percebe que falta informação ou documento, **quero** pedir uma diligência (texto do pedido, etapa para onde o processo volta e prazo sugerido) e, quando o processo voltar à etapa `JURIDICO`, ter a **mesma análise retomada** em nova rodada, com as versões novas registradas e comparáveis com a rodada anterior, **para** que o pedido, o prazo, a resposta e o que mudou nos documentos fiquem no processo, e não em e-mails soltos.

A story entrega: o pedido de diligência (`IN_REVIEW` para `DILIGENCE`) com a devolução do processo (`RETURN`) na mesma transação; a resposta de quem atendeu; os lembretes do prazo; a **retomada** automática quando o processo volta a `JURIDICO` (`DILIGENCE` para `IN_REVIEW`, `currentRound` + 1, novo snapshot em `LegalReviewDocument`); e a consulta das diligências. A pausa e a retomada do prazo da etapa `JURIDICO` são consequência dos eventos aqui publicados e pertencem à US-191; a elaboração do parecer é da US-154; concluir é da US-155.

## Contexto
- A DEC-196 permite que `JURIDICO` devolva (`RETURN`) o processo para qualquer etapa já percorrida (`ESTUDOS_PRELIMINARES`, `PESQUISA_PRECOS`, `TERMO_REFERENCIA`, `DOTACAO`, `MINUTA_EDITAL`) e define que a `LegalReview` fica em `DILIGENCE` e é **retomada, não recriada**, quando o processo volta. A DEC-199 acrescenta o pedido de diligência registrado e a comparação das versões entre rodadas; a DEC-205 pausa o prazo da análise durante a diligência.
- A devolução reaproveita as regras da US-048 (PRC-20): custódia (POL-01), processo `IN_PROGRESS`, destino já percorrido e permitido pela transição `RETURN` da etapa, responsável de destino por `PREVIOUS_ASSIGNEE`, e nenhuma mudança automática no status de documentos (POL-11). O que esta story acrescenta é o **registro tipado** do pedido (`LegalReviewDiligence`) e o vínculo com o `ProcessMovement` do `RETURN`.
- A US-152 já definiu o snapshot por rodada e a comparação (LGL-11/LGL-12); aqui se grava o snapshot da rodada seguinte no ato da retomada e o painel passa a oferecer "O que mudou desde a rodada anterior".
- Diligência é uma comunicação para quem atende o pedido (Planejamento, Compras, Licitações, Contabilidade), que normalmente não tem `LEGAL_REVIEW_VIEW`; por isso a leitura do pedido e da resposta segue `PROCESS_VIEW` (DEC-024), e o texto, por ser livre, não pode carregar valor de orçamento sigiloso (DEC-030/POL-09).
- O parecer em rascunho (US-154) e as ressalvas pertencem à análise, não à rodada: sobrevivem à diligência. Os documentos do processo não mudam sozinhos na devolução; quem atende reabre e revisa o que for preciso (POL-11, `DOCUMENT_REOPEN`).
- Eventos e notificações já previstos em `events.md` §4.5/§6: `LegalReviewDiligenceRequested` (notificação obrigatória in-app `LEGAL_DILIGENCE_REQUESTED`), `LegalReviewDiligenceReminderDue` (`LEGAL_DILIGENCE_REMINDER`) e `LegalReviewResumed` (`LEGAL_DILIGENCE_ANSWERED`, timeline `LEGAL_REVIEW_STARTED` com texto "Análise jurídica retomada (rodada {round})").

## Objetivo
Garantir que 100% das diligências tenham pedido, etapa de retorno, prazo e `ProcessMovement` gravados na mesma transação que muda a análise para `DILIGENCE`, que 100% das retomadas gerem nova rodada com snapshot completo sem exigir novo "Iniciar análise", e que o requisitante receba o pedido e o procurador a notícia da volta em até 1 minuto após o commit.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) designado como `assigneeId` da análise — pede a diligência e, na volta, retoma o trabalho.
- **Secundárias:** titular ou substituto da unidade jurídica (podem pedir diligência em análise sem designação ou designada a outra pessoa, POL-19); responsável da etapa de destino da devolução (Planejamento, Compras, Licitações, Contabilidade), que atende e responde; criador do processo e titular da secretaria solicitante (acompanham); Auditor (`AUDITOR`) e Controle Interno (leem o histórico de rodadas).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`LEGAL_REVIEW_MANAGE` é risco `M`; `PROCESS_RETURN` é risco `M`).
- Para **pedir**: `LegalReview` em `IN_REVIEW`, de processo `IN_PROGRESS` com a etapa `JURIDICO` ativa; usuário com `LEGAL_REVIEW_MANAGE` e `PROCESS_RETURN` cobrindo o processo, sem conflito de POL-19, `assigneeId` ou titular/substituto da unidade jurídica, e com a custódia do processo (POL-01).
- Para **responder**: diligência sem retomada (`answeredAt` nulo) de análise em `DILIGENCE`; usuário com `PROCESS_VIEW` e a custódia do processo (POL-01) na etapa de destino.
- Para **retomar**: análise em `DILIGENCE` e processo que volta a ser encaminhado para `JURIDICO` (US-047 ou decisão de aprovação) — não há ação do procurador.
- Configurações do tenant `legalReview.diligenceDueBusinessDays` (padrão 10; 1..60) e `legalReview.diligenceReminderBusinessDays` (padrão 2; 0..10).

## Fluxo principal
1. O procurador, com a análise `IN_REVIEW` no painel (`/juridico/[reviewId]`, SCR-019), aciona **"Pedir diligência"**, visível quando `canRequestDiligence` (LGL-02) é verdadeiro.
2. O diálogo (variação do SCR-104) pede: **o que precisa ser esclarecido ou providenciado** (20 a 10.000 caracteres), a **etapa de retorno** (lista `diligenceTargets[]` de LGL-02: etapas já percorridas e permitidas, com a data da última passagem e o responsável anterior) e o **prazo de atendimento**, com sugestão de hoje + `legalReview.diligenceDueBusinessDays` dias úteis, editável.
3. O diálogo avisa o que acontece ao confirmar: o processo será devolvido, a análise ficará em diligência, o prazo da etapa jurídica ficará pausado, e (se o destino for anterior a uma ramificação) os demais ramos serão cancelados (DEC-194).
4. O procurador confirma; o front envia LGL-13 com `{ request, returnStageKey, dueAt }`, `If-Match` (ETag da `LegalReview`) e `Idempotency-Key`.
5. A API valida na ordem: existência e tenant, permissões e POL-19, `assigneeId`/titularidade, status `IN_REVIEW`, processo e etapa, custódia, dados do pedido (tamanho, sigilo, prazo) e destino da devolução.
6. Na **mesma transação**, a API trava a `LegalReview` e o processo, executa a devolução com as regras do PRC-20 (encerra a `ProcessStage` de `JURIDICO` como `RETURNED`, abre a do destino, resolve o responsável por `PREVIOUS_ASSIGNEE`, cria o `ProcessMovement` `RETURN` com comentário gerado pelo sistema, sem copiar o texto do pedido), grava `LegalReviewDiligence` (rodada corrente, `movementId`, `dueAt`), muda `status` para `DILIGENCE`, incrementa o `version`, grava a auditoria `legal_review.diligence_request` e a timeline `LEGAL_DILIGENCE_REQUESTED`.
7. Pelo outbox, publica `LegalReviewDiligenceRequested` (e os eventos do `RETURN` do MVP 1) e responde 201 com a diligência, a análise e o `movementId`. O responsável da etapa de destino e o criador do processo recebem a notificação `LEGAL_DILIGENCE_REQUESTED`; o evento de prazo é consumido pelo `SlaEvaluator` (US-191), que pausa o prazo da etapa jurídica.
8. O responsável da etapa de destino abre o processo na caixa de tarefas (SCR-013) e vê, em SCR-006, o aviso "Diligência da análise jurídica" com o pedido, o prazo e a ação **"Responder diligência"**; ele atende (por exemplo, reabre a pesquisa de preços e salva a versão nova) e registra um resumo do atendimento (LGL-14, opcional), que pode ser editado até a retomada.
9. Ao terminar, ele encaminha o processo de volta (US-047) até `JURIDICO`. Na mesma transação do encaminhamento, o `StageLifecycleListener` encontra a análise em `DILIGENCE` e a **retoma**: `status` para `IN_REVIEW`, `currentRound` + 1, `currentProcessStageId` da nova passagem, `LegalReviewDocument` da nova rodada (RN-LGL-41), `answeredAt` na diligência, auditoria `legal_review.resume`, timeline "Análise jurídica retomada (rodada 2)" e o evento `LegalReviewResumed`.
10. O procurador designado recebe `LEGAL_DILIGENCE_ANSWERED`, abre o painel e vê a rodada 2 com o selo "Retomada", a resposta de quem atendeu e **"O que mudou desde a rodada anterior"** (LGL-12 com `fromRound` 1 e `toRound` 2: documentos alterados, adicionados, removidos ou inalterados, com atalho para o diff de DOC-18). O prazo da etapa volta a correr (US-191).
11. Antes do prazo, o job `deadlines` publica `LegalReviewDiligenceReminderDue` (lembrete e vencimento), e o responsável da etapa de destino é notificado.

## Fluxos alternativos
- **FA-01 — Prazo ajustado:** o procurador escolhe outra data útil entre o dia seguinte e 60 dias úteis; datas passadas, não úteis ou além do limite são recusadas (RN-LGL-48).
- **FA-02 — Análise sem designação, pedida pelo titular:** o titular ou substituto da unidade jurídica pede a diligência; `assigneeId` não muda (RN-LGL-46).
- **FA-03 — Análise `PENDING`:** não se pede diligência antes de iniciar a análise (não há snapshot); LGL-13 responde 409 `LEGAL_REVIEW_INVALID_STATE` e o painel oferece "Iniciar análise" (US-152).
- **FA-04 — Destino fora das etapas permitidas:** etapa não percorrida ou sem transição `RETURN` configurada responde 422 `TRANSITION_NOT_AVAILABLE`; o seletor só lista `diligenceTargets[]` válidos (RN-LGL-47).
- **FA-05 — Procurador sem custódia do processo:** quem tem `LEGAL_REVIEW_MANAGE` mas não detém a custódia (POL-01) recebe 403 `NOT_PROCESS_CUSTODIAN`; o botão fica desabilitado com o motivo (RN-LGL-46).
- **FA-06 — Texto com valor de orçamento sigiloso:** com orçamento sigiloso no processo, pedido ou resposta com padrão de valor monetário é recusado com 422 `LEGAL_TEXT_CONFIDENTIAL` (RN-LGL-56).
- **FA-07 — Retomada sem nenhuma versão nova:** o requisitante encaminha sem alterar documentos; a retomada ocorre normalmente (a regra de saída de quem devolveu não é desta story), a rodada 2 é gravada e o painel avisa "Nenhum documento mudou desde a rodada anterior" (RN-LGL-53).
- **FA-08 — Resposta editada antes da retomada:** LGL-14 pode ser chamada de novo enquanto não houver retomada; a última versão do resumo prevalece e cada alteração é auditada. Depois da retomada, 409 `LEGAL_DILIGENCE_ALREADY_ANSWERED` (RN-LGL-51).
- **FA-09 — Processo suspenso durante a diligência:** a suspensão (US-008) segue o MVP 1; os lembretes não são enviados enquanto o processo estiver `SUSPENDED` e o `dueAt` da diligência não é estendido (RN-LGL-58). **Dúvida de produto.**
- **FA-10 — Análise ou processo cancelado durante a diligência:** a análise vai a `CANCELED` (cancelamento é tratado pela tramitação) e os lembretes cessam; nenhuma retomada ocorre (RN-LGL-58).
- **FA-11 — Retomada com falha ao gravar o snapshot:** a transação do encaminhamento inteira é desfeita (o processo continua na etapa de origem) e a API responde 503; o requisitante tenta de novo (RN-LGL-52).
- **FA-12 — Devolução a etapa anterior a uma ramificação:** os outros ramos são cancelados (DEC-194) e a mensagem do diálogo informa antes da confirmação; com mais de uma etapa ativa, `processStageId` é resolvido pela passagem de `JURIDICO` da própria análise (`currentProcessStageId`).

## Regras de negócio
- **RN-LGL-09** — A análise considera as **versões exatas** dos documentos; cada rodada tem o seu `LegalReviewDocument`, imutável (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-10** — Segregação: quem elaborou o processo ou seus documentos não analisa nem pede diligência (POL-19). *(regra da feature, adotada)*
- **RN-LGL-11** — Situações do produto; aqui as transições são `IN_REVIEW` para `DILIGENCE` e `DILIGENCE` para `IN_REVIEW` (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-12** — Diligência devolve o processo (`RETURN`) para qualquer etapa já percorrida; a análise passa a `DILIGENCE` e o prazo da etapa `JURIDICO` fica pausado, o que é efeito dos eventos publicados e pertence à US-191 (DEC-196, DEC-205). *(regra da feature, adotada)*
- **RN-LGL-13** — A análise é **retomada**, não recriada, quando o processo volta a `JURIDICO`: rodada + 1, novo snapshot e comparação com a rodada anterior (DEC-196, DEC-199). *(regra da feature, adotada)*
- **RN-LGL-14** — Prazo de atendimento por `legalReview.diligenceDueBusinessDays` e lembrete por `legalReview.diligenceReminderBusinessDays` (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-46** *(nova)* — Quem pede: `LEGAL_REVIEW_MANAGE` **e** `PROCESS_RETURN` cobrindo o processo, sem conflito de POL-19 (`LEGAL_REVIEW_SEGREGATION`), sendo `assigneeId` ou titular/substituto da unidade jurídica (`NOT_LEGAL_REVIEW_ASSIGNEE`), com a custódia do processo (POL-01, `NOT_PROCESS_CUSTODIAN`). Estado exigido: análise `IN_REVIEW`, processo `IN_PROGRESS` com a etapa `JURIDICO` ativa; fora disso, 409 `LEGAL_REVIEW_INVALID_STATE` ou `INVALID_PROCESS_STATUS`. Há no máximo **uma diligência por rodada** (unique `(legal_review_id, round)`).
- **RN-LGL-47** *(nova)* — Pedido e destino: `request` tem de 20 a 10.000 caracteres, texto puro, gravado aparado nas pontas; `returnStageKey` (até 60 caracteres) identifica uma `WorkflowStage` já percorrida pelo processo e permitida como destino da transição `RETURN` da etapa `JURIDICO` (RN-TRAM-24); caso contrário, 422 `TRANSITION_NOT_AVAILABLE`. O responsável de destino é resolvido por `PREVIOUS_ASSIGNEE` (RN-TRAM-28).
- **RN-LGL-48** *(nova)* — Prazo de atendimento: `dueAt` é opcional no corpo; ausente, a API calcula hoje + `legalReview.diligenceDueBusinessDays` dias úteis (CAL-06, calendário do tenant); informado, deve ser um dia útil entre o dia seguinte e 60 dias úteis, e é gravado como o fim desse dia no fuso do tenant. O prazo é **sugerido**: vencê-lo não bloqueia nada, apenas gera o lembrete de vencimento.
- **RN-LGL-49** *(nova)* — Atomicidade: devolução do processo, `ProcessMovement` `RETURN`, `LegalReviewDiligence`, mudança de `status`, incremento de `version`, auditoria, timeline e outbox saem no mesmo commit, com `SELECT … FOR UPDATE` na análise e no processo; falha em qualquer passo desfaz tudo. O comentário do `ProcessMovement` é gerado pelo sistema ("Diligência da análise jurídica (rodada {round}); consulte o pedido na análise") e nunca reproduz o texto do pedido.
- **RN-LGL-50** *(nova)* — Efeitos sobre dados: a diligência não altera documentos (POL-11), o snapshot da rodada em curso permanece intocado, o `opinionDocumentId` e o rascunho do parecer são mantidos, as ressalvas continuam registradas e `assigneeId` não muda. Enquanto a análise estiver em `DILIGENCE`, o parecer não pode ser editado nem finalizado e não se registram novas ressalvas (US-154).
- **RN-LGL-51** *(nova)* — Resposta (LGL-14): `answerSummary` de 10 a 10.000 caracteres, texto puro, sem valor sigiloso (RN-LGL-56); quem responde tem `PROCESS_VIEW` e a custódia do processo (POL-01) na etapa de destino; vale enquanto `answeredAt` for nulo e a análise estiver em `DILIGENCE`; depois da retomada, 409 `LEGAL_DILIGENCE_ALREADY_ANSWERED`. A resposta é **opcional para a retomada**: o processo pode voltar sem ela (`answerSummary` nulo). A resposta não publica evento de domínio (a volta é anunciada por `LegalReviewResumed`).
- **RN-LGL-52** *(nova)* — Retomada: gatilho é a entrada do processo na etapa `JURIDICO` com `LegalReview` em `DILIGENCE`, na **mesma transação** do encaminhamento; ações na transação: `status` `IN_REVIEW`, `currentRound` + 1, `currentProcessStageId` da nova passagem, snapshot da nova rodada pela regra RN-LGL-41, `answeredAt` na diligência da rodada anterior, auditoria `legal_review.resume`, timeline, outbox. Não exige "Iniciar análise" nem altera `assigneeId`, `startedAt` e `assignedAt`. A retomada nunca bloqueia o encaminhamento por regra de negócio; só uma falha técnica desfaz a transação.
- **RN-LGL-53** *(nova)* — Comparação na retomada: a rodada nova é comparável com a anterior por LGL-12 (RN-LGL-44); o painel destaca `CHANGED`, `ADDED` e `REMOVED` e exibe o aviso "Nenhum documento mudou desde a rodada anterior" quando todos são `UNCHANGED`. O snapshot da retomada usa as versões vigentes no instante do commit.
- **RN-LGL-54** *(nova)* — Lembretes (job `deadlines`, a cada 15 minutos): para diligência sem retomada, em análise `DILIGENCE`, de processo que não esteja `SUSPENDED` nem `CANCELED`, publica `LegalReviewDiligenceReminderDue` (a) **uma vez** quando faltarem `legalReview.diligenceReminderBusinessDays` dias úteis ou menos (0 desliga o lembrete antecipado) e (b) **uma vez** no vencimento (`now` >= `dueAt`); `lastReminderAt` impede repetição (o lembrete de vencimento só dispara se `lastReminderAt` for anterior ao `dueAt`). Depois do vencimento não há novos lembretes.
- **RN-LGL-55** *(nova)* — Situação da diligência (derivada, não persistida): `OPEN` (sem retomada e dentro do prazo), `OVERDUE` (sem retomada e `dueAt` vencido) e `ANSWERED` (com `answeredAt`, isto é, o processo voltou a `JURIDICO`). Uma diligência `ANSWERED` é imutável.
- **RN-LGL-56** *(nova)* — Sigilo e texto livre: com orçamento sigiloso no processo (DEC-030, POL-09), `request` e `answerSummary` não podem conter valor monetário (padrão `R$` ou número com formato de moeda); a API recusa com 422 `LEGAL_TEXT_CONFIDENTIAL` (regra reutilizada nas US-154 e US-156). Pedido e resposta nunca entram em evento, notificação, log, auditoria (só tamanho e hash) ou prompt de IA; a notificação carrega apenas o código do processo, o nome da etapa de retorno e o prazo.
- **RN-LGL-57** *(nova)* — Leitura: a lista (LGL-15) e o detalhe do pedido e da resposta são lidos por quem tem `PROCESS_VIEW` cobrindo o processo (DEC-024) ou `LEGAL_REVIEW_VIEW`; `AUDITOR` com `AUDIT_VIEW` e Controle Interno leem também. `canRequestDiligence` e `diligenceTargets[]` são devolvidos em LGL-02 só para quem pode pedir.
- **RN-LGL-58** *(nova)* — Interação com outros estados: análise `CANCELED` ou processo `CANCELED` encerra os lembretes e congela a diligência no estado em que estiver; processo `SUSPENDED` suspende os lembretes sem alterar `dueAt`; a retomada depois de uma suspensão segue normalmente. Mudança de `assigneeId` durante a diligência (US-150) não altera a diligência e o aviso de retomada vai ao novo designado.
- **RN-LGL-59** *(nova)* — Notificações e prazo da etapa: a devolução da diligência substitui a notificação `PROCESS_RETURNED` do MVP 1 pela `LEGAL_DILIGENCE_REQUESTED` (o `ProcessStageChanged` do `RETURN` carrega a referência `legalReviewDiligenceId` para a supressão da duplicata); a pausa e a retomada do SLA são feitas pelo `SlaEvaluator` ao consumir `LegalReviewDiligenceRequested` e `LegalReviewResumed` (US-191), sem notificação.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Análise | `id` (path) | uuid | Sim | `LegalReview` do tenant | rota |
| O que precisa ser esclarecido | `request` | texto longo (20..10.000) | Sim | texto puro; RN-LGL-47/56 | em branco |
| Etapa de retorno | `returnStageKey` | texto (≤ 60) | Sim | etapa já percorrida e permitida; RN-LGL-47 | `diligenceTargets[]` |
| Prazo de atendimento | `dueAt` | datetime (dia útil) | Não | dia seguinte..60 dias úteis; RN-LGL-48 | hoje + `diligenceDueBusinessDays` dias úteis |
| Versão da análise | `If-Match` (ETag) | texto | Sim (LGL-13) | ETag da `LegalReview` | `GET` LGL-02 |
| Versão da diligência | `If-Match` (ETag) | texto | Sim (LGL-14) | ETag da `LegalReviewDiligence` | `GET` LGL-15 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| Diligência | `diligenceId` (path) | uuid | Sim (LGL-14) | do tenant | rota |
| Resumo do atendimento | `answerSummary` | texto longo (10..10.000) | Não | RN-LGL-51/56 | nulo |
| *(saída)* Rodada, pedido, destino | `round`, `request`, `returnStageKey`, `returnStageName`, `movementId` | smallint / texto / texto / texto / uuid | — | congelados | `LegalReviewDiligence` |
| *(saída)* Pedida em / por | `requestedAt`, `requestedById` | datetime / uuid | — | servidor | sistema |
| *(saída)* Prazo e lembrete | `dueAt`, `lastReminderAt` | datetime | — | RN-LGL-54 | sistema |
| *(saída)* Retomada e resposta | `answeredAt`, `answerSummary` | datetime / texto | — | `answeredAt` = volta a `JURIDICO` | sistema |
| *(saída)* Situação derivada | `status` | `OPEN` \| `OVERDUE` \| `ANSWERED` | — | RN-LGL-55 | derivado |
| *(saída, LGL-02)* Ação disponível | `canRequestDiligence`, `diligenceTargets[]` | booleano / lista | — | RN-LGL-46/57 | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `request` ausente, com menos de 20 ou mais de 10.000 caracteres | Front + API (Zod) | "Descreva o pedido com 20 a 10.000 caracteres." | `VALIDATION_ERROR` |
| V-02 | `returnStageKey` ausente | Front + API (Zod) | "Escolha a etapa para onde o processo será devolvido." | `VALIDATION_ERROR` |
| V-03 | Etapa não percorrida ou sem transição `RETURN` permitida | API | "Esta etapa não está disponível como destino da diligência." | `TRANSITION_NOT_AVAILABLE` (422) |
| V-04 | `dueAt` no passado, em dia não útil ou além de 60 dias úteis | Front + API | "Escolha um dia útil entre amanhã e 60 dias úteis." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-05 | `answerSummary` com menos de 10 ou mais de 10.000 caracteres | Front + API (Zod) | "O resumo deve ter de 10 a 10.000 caracteres." | `VALIDATION_ERROR` |
| V-06 | Texto com valor monetário em processo de orçamento sigiloso | API | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | `LEGAL_TEXT_CONFIDENTIAL` (422) |
| V-07 | `If-Match` ausente | API | "Atualize a página e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-08 | `If-Match` divergente | API | "Esta análise foi alterada por outra pessoa. Atualize a página." | `VERSION_CONFLICT` (412) |
| V-09 | Análise fora de `IN_REVIEW` (pedir) | API | "A diligência só pode ser pedida em uma análise em andamento." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-10 | Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | API | "O processo não está disponível para devolução no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-11 | Usuário em conflito de segregação (POL-19) | API | "Você participou da elaboração deste processo e não pode analisá-lo." | `LEGAL_REVIEW_SEGREGATION` (403) |
| V-12 | Usuário não é o designado nem titular/substituto | API | "Esta análise está designada a outra pessoa." | `NOT_LEGAL_REVIEW_ASSIGNEE` (403) |
| V-13 | Usuário sem a custódia do processo | API | "Você não está com este processo." | `NOT_PROCESS_CUSTODIAN` (403) |
| V-14 | Diligência já retomada (responder) | API | "Esta diligência já foi encerrada com a volta do processo ao Jurídico." | `LEGAL_DILIGENCE_ALREADY_ANSWERED` (409) |
| V-15 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** pedir diligência exige `LEGAL_REVIEW_MANAGE` **e** `PROCESS_RETURN` cobrindo o processo; responder exige `PROCESS_VIEW` com custódia (POL-01); ler a lista exige `PROCESS_VIEW` ou `LEGAL_REVIEW_VIEW`; o painel e o comparativo (LGL-02/LGL-11/LGL-12) seguem a US-152.
- **Políticas:** POL-19 (segregação e designação), POL-01 (custódia, status e, com ramos, por etapa), POL-11 (a devolução não reabre documento), DEC-024 (visibilidade), POL-09 (sigilo no texto livre).
- **MFA:** `LEGAL_REVIEW_MANAGE` e `PROCESS_RETURN` são risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** "Pedir diligência" fica oculto sem `LEGAL_REVIEW_MANAGE` ou `PROCESS_RETURN` e desabilitado com o motivo em caso de segregação, designação ou falta de custódia; a API responde 403 `PERMISSION_DENIED`, `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; análise de outro tenant ou processo invisível responde 404 `LEGAL_REVIEW_NOT_FOUND` (diligência inexistente: 404 `LEGAL_DILIGENCE_NOT_FOUND`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewDiligenceRequested` | `legal_review.diligence_requested` | Commit de LGL-13 | `legalReviewId`, `diligenceId`, `round`, `returnStageKey`, `movementId`, `dueAt?` (sem o texto); consumidores T (`LEGAL_DILIGENCE_REQUESTED`), N, R, S (`SlaEvaluator`, pausa) e NR |
| `ProcessStageChanged` / `ProcessStatusChanged` / `ProcessAssigned` | `process.stage_changed.return` etc. | Mesmo commit (devolução PRC-20) | Eventos do MVP 1; `ProcessStageChanged` com a referência `legalReviewDiligenceId` (RN-LGL-59) |
| `LegalReviewDiligenceReminderDue` | `legal_review.diligence_reminder_due` | Job `deadlines` (antecipado e no vencimento) | `legalReviewId`, `diligenceId`, `dueAt`, `businessDaysLeft`, `assigneeId?`, `departmentId`; consumidor N |
| `LegalReviewResumed` | `legal_review.resumed` | Entrada do processo em `JURIDICO` com análise em `DILIGENCE` | `legalReviewId`, `diligenceId`, `round`, `processStageId`, `documentVersionIds[]` (só ids); consumidores T (`LEGAL_REVIEW_STARTED`), N, R, S (`SlaEvaluator`, retomada do prazo) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `LEGAL_DILIGENCE_REQUESTED` | Responsável (ou unidade) da etapa de devolução; criador do processo | In-app (obrigatória) e e-mail (padrão ligado) | `LegalReviewDiligenceRequested` |
| `LEGAL_DILIGENCE_REMINDER` | Responsável da etapa de devolução; titular da unidade no vencimento | In-app e e-mail | `LegalReviewDiligenceReminderDue` |
| `LEGAL_DILIGENCE_ANSWERED` | Procurador designado | In-app e e-mail | `LegalReviewResumed` |

Regras gerais do MVP 1 valem: nunca notificar o próprio ator, agrupamento de 5 minutos, sem dado sigiloso e sem o texto do pedido. A pausa e a retomada do prazo não geram notificação (events.md §6).

## Critérios de aceite em Gherkin
```gherkin
Feature: Pedir diligência e retomar a análise jurídica

  Background:
    Given que o tenant "Prefeitura A" está ativo, com "legalReview.diligenceDueBusinessDays" 10 e "legalReview.diligenceReminderBusinessDays" 2
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "JURIDICO" sob a custódia de "Dr. André Nunes"
    And a análise "LR-0045" está "IN_REVIEW" na rodada 1, designada a "Dr. André Nunes", com DFD v2, ETP v3, pesquisa de preços v1, TR v4 e edital v1 registrados
    And "Dr. André Nunes" tem os perfis "JURIDICO" com "LEGAL_REVIEW_MANAGE" e "PROCESS_RETURN", e não participou da elaboração
    And "Marcos Ribeiro", do Setor de Compras, era o responsável da etapa "PESQUISA_PRECOS" e tem "PROCESS_VIEW"
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e é autora do TR

  Scenario: [Sucesso] Pedir diligência devolve o processo e coloca a análise em diligência
    When "Dr. André Nunes" pedir diligência com o texto de 120 caracteres sobre cotações, a etapa "PESQUISA_PRECOS" e a chave "K1"
    Then a API deve responder 201 com a diligência da rodada 1, "returnStageKey" "PESQUISA_PRECOS" e "dueAt" 10 dias úteis à frente
    And a análise deve ficar "DILIGENCE" com "currentRound" 1 e o "assigneeId" inalterado
    And o processo deve ficar "RETURNED" na etapa "PESQUISA_PRECOS" sob a responsabilidade de "Marcos Ribeiro"
    And o movimento "RETURN" deve ter o comentário gerado pelo sistema, sem o texto do pedido
    And devem ser gravados a auditoria "legal_review.diligence_request" e o evento "LegalReviewDiligenceRequested" sem o texto
    And "Marcos Ribeiro" e "Carla Mendes" devem receber a notificação "LEGAL_DILIGENCE_REQUESTED"
    And a timeline deve exibir "Dr. André Nunes pediu diligência e devolveu para Pesquisa de preços"

  Scenario: [Sucesso] Pedir diligência com prazo ajustado
    When "Dr. André Nunes" pedir diligência informando "dueAt" para o dia útil 5 dias úteis à frente
    Then a API deve responder 201 com "dueAt" no fim desse dia no fuso do tenant

  Scenario: [Sucesso] Quem atende registra o resumo do atendimento
    Given que a análise está "DILIGENCE" com a diligência "OPEN"
    When "Marcos Ribeiro" chamar "POST /legal-review-diligences/{id}/answer" com o resumo "Cotações renovadas; versão 2 salva" e a ETag atual
    Then a API deve responder 200 com "answerSummary" preenchido e "answeredAt" nulo
    And deve gerar a auditoria "legal_review.diligence_answer"
    And nenhum evento de domínio deve ser publicado

  Scenario: [Sucesso] Retomada automática na volta do processo a JURIDICO
    Given que "Marcos Ribeiro" salvou a pesquisa de preços v2 e registrou o resumo do atendimento
    When "Marcos Ribeiro" encaminhar o processo de volta até a etapa "JURIDICO"
    Then a análise "LR-0045" deve ficar "IN_REVIEW" com "currentRound" 2, a mesma análise e o mesmo "assigneeId"
    And devem existir os "LegalReviewDocument" da rodada 2 com DFD v2, ETP v3, pesquisa de preços v2, TR v4 e edital v1, e os da rodada 1 devem permanecer intactos
    And a diligência da rodada 1 deve ter "answeredAt" preenchido e situação "ANSWERED"
    And deve gerar a auditoria "legal_review.resume" e o evento "LegalReviewResumed" com a rodada 2 e os ids de versão
    And "Dr. André Nunes" deve receber a notificação "LEGAL_DILIGENCE_ANSWERED"
    And a timeline deve exibir "Análise jurídica retomada (rodada 2)"

  Scenario: [Sucesso] Comparação entre a rodada 1 e a rodada 2 depois da retomada
    Given que a análise foi retomada na rodada 2 com a pesquisa de preços v2
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}/documents/compare?fromRound=1&toRound=2"
    Then a API deve responder 200 com a pesquisa de preços "CHANGED" (v1 para v2) e os demais "UNCHANGED"

  Scenario: [Sucesso] Lembrete antes do prazo e no vencimento
    Given que a diligência tem "dueAt" daqui a 2 dias úteis e "lastReminderAt" nulo
    When o job "deadlines" executar
    Then deve ser publicado um "LegalReviewDiligenceReminderDue" com "businessDaysLeft" 2 e "Marcos Ribeiro" deve receber "LEGAL_DILIGENCE_REMINDER"
    When o job executar de novo no mesmo dia
    Then nenhum novo lembrete deve ser publicado
    When o prazo vencer sem retomada e o job executar
    Then deve ser publicado um lembrete de vencimento e o titular da unidade de "Marcos Ribeiro" também deve ser notificado

  Scenario: [Sucesso] Listar as diligências da análise
    Given que a análise teve a diligência 1 respondida e a diligência 2 aberta
    When "Marcos Ribeiro", com "PROCESS_VIEW", chamar "GET /legal-reviews/{id}/diligences"
    Then a API deve responder 200 com as duas diligências ordenadas da rodada mais recente para a mais antiga, com a situação derivada de cada uma

  Scenario: [Validação] Pedido, destino, prazo e sigilo inválidos
    When "Dr. André Nunes" pedir diligência com texto de 10 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nada deve ser gravado
    When "Dr. André Nunes" pedir diligência com a etapa "EDITAL_PUBLICACAO", nunca percorrida
    Then a API deve responder 422 com código "TRANSITION_NOT_AVAILABLE"
    When "Dr. André Nunes" pedir diligência com "dueAt" em um sábado
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" em "dueAt"
    Given que o orçamento do processo é sigiloso
    When "Dr. André Nunes" pedir diligência com o texto "A cotação de R$ 1.250.000,00 parece alta, justifique"
    Then a API deve responder 422 com código "LEGAL_TEXT_CONFIDENTIAL"
    And a análise deve continuar "IN_REVIEW" e o processo deve continuar na etapa "JURIDICO"

  Scenario: [Validação] Pedir diligência com a análise pendente
    Given que a análise "LR-0050" está "PENDING"
    When "Dr. André Nunes" pedir diligência em "LR-0050"
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"

  Scenario: [Permissão] Segregação, outra designação, sem permissão e sem custódia
    Given que "Carla Mendes" também tem "LEGAL_REVIEW_MANAGE" e "PROCESS_RETURN"
    When "Carla Mendes" pedir diligência
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION" e gerar a auditoria "access.denied"
    Given que "Dra. Lúcia Prado", procuradora sem relação com o processo, não é a designada nem titular
    When "Dra. Lúcia Prado" pedir diligência
    Then a API deve responder 403 com código "NOT_LEGAL_REVIEW_ASSIGNEE"
    Given que "Bruno Lopes" não tem "PROCESS_RETURN"
    When "Bruno Lopes" pedir diligência
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que o processo está sob a custódia de outra pessoa da unidade jurídica
    When "Dr. André Nunes" pedir diligência sem a custódia
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    When "Dra. Patrícia Gomes", de outra secretaria e sem acesso ao processo, chamar "GET /legal-reviews/{id}/diligences"
    Then a API deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND"
    When "Marcos Ribeiro" sem custódia do processo responder a diligência
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Análise e diligência de outro órgão
    Given que a análise "LR-0007" e a diligência "D-0007" pertencem ao tenant "Prefeitura B"
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id-LR-0007}/diligences", "GET /legal-reviews/{id-LR-0007}/diligences" e "POST /legal-review-diligences/{id-D-0007}/answer"
    Then a API deve responder 404 com os códigos "LEGAL_REVIEW_NOT_FOUND" nas duas primeiras e "LEGAL_DILIGENCE_NOT_FOUND" na terceira
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio do pedido e segunda diligência na mesma rodada
    Given que "Dr. André Nunes" pediu a diligência com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única diligência, um único movimento "RETURN" e um único evento "LegalReviewDiligenceRequested"
    When "Dr. André Nunes" tentar pedir outra diligência com a chave "K2"
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"

  Scenario: [Duplicidade] Responder depois da retomada
    Given que a análise foi retomada e a diligência está "ANSWERED"
    When "Marcos Ribeiro" tentar alterar o resumo do atendimento
    Then a API deve responder 409 com código "LEGAL_DILIGENCE_ALREADY_ANSWERED"

  Scenario: [Concorrência] Dois pedidos simultâneos e resposta durante o encaminhamento
    When "Dr. André Nunes" e "Dra. Helena Prado" pedirem diligência ao mesmo tempo com a mesma ETag
    Then exatamente uma chamada deve responder 201
    And a outra deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "LEGAL_REVIEW_INVALID_STATE"
    And devem existir uma única diligência e um único movimento "RETURN"
    Given que "Marcos Ribeiro" edita o resumo enquanto outra pessoa da unidade encaminha o processo a "JURIDICO"
    Then ou o resumo é gravado antes da retomada, ou a edição responde 409 com código "LEGAL_DILIGENCE_ALREADY_ANSWERED"
    And a análise deve ter uma única rodada nova

  Scenario: [Falha de banco] Falha ao gravar a diligência desfaz a devolução
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/diligences"
    When "Dr. André Nunes" confirmar o pedido
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "IN_REVIEW" e o processo deve continuar em "JURIDICO"
    And nenhuma diligência, movimento, auditoria ou evento deve ter sido gravado

  Scenario: [Falha de banco] Falha ao gravar o snapshot da retomada desfaz o encaminhamento
    Given que o banco falha ao gravar os "LegalReviewDocument" da rodada 2
    When "Marcos Ribeiro" encaminhar o processo a "JURIDICO"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve continuar na etapa de origem e a análise deve continuar "DILIGENCE"

  Scenario: [Falha de integração] SMTP indisponível não desfaz o pedido
    Given que o servidor de e-mail está indisponível
    When "Dr. André Nunes" pedir diligência
    Then a API deve responder 201 e a notificação in-app "LEGAL_DILIGENCE_REQUESTED" deve ser gravada
    And o envio de e-mail deve ficar para nova tentativa pelo worker, com log "warn" "notification.email_deferred"

  Scenario: [Falha de integração] Redis indisponível no armazenamento de idempotência
    Given que o Redis está indisponível
    When "Dr. André Nunes" pedir diligência
    Then a API deve responder 201 e concluir o pedido sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega o painel |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Esta análise foi alterada por outra pessoa. Atualize a página." | Recarrega e reexibe o diálogo com o texto preservado |
| Análise de outro tenant, inexistente ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Diligência inexistente ou de outro tenant | 404 | `LEGAL_DILIGENCE_NOT_FOUND` | "Diligência não encontrada." | Volta ao processo |
| Análise fora do estado esperado | 409 | `LEGAL_REVIEW_INVALID_STATE` | "A diligência só pode ser pedida em uma análise em andamento." | Recarrega o painel |
| Diligência já retomada | 409 | `LEGAL_DILIGENCE_ALREADY_ANSWERED` | "Esta diligência já foi encerrada com a volta do processo ao Jurídico." | Mostra o resumo em leitura |
| Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para devolução no momento." | Desabilita a ação com o motivo |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você participou da elaboração deste processo e não pode analisá-lo." | Oculta a ação e explica na dica |
| Não é o designado | 403 | `NOT_LEGAL_REVIEW_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Oculta a ação |
| Sem custódia do processo | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Desabilita a ação |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para pedir diligência." | Oculta a ação |
| Destino não permitido | 422 | `TRANSITION_NOT_AVAILABLE` | "Esta etapa não está disponível como destino da diligência." | Recarrega as opções |
| Texto com valor sigiloso | 422 | `LEGAL_TEXT_CONFIDENTIAL` | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | Destaca o campo |
| Pedido, resumo ou prazo inválido | 422 | `VALIDATION_ERROR` | Mensagem do campo | Marca o campo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-048 (devolução PRC-20 e suas regras de custódia, destino e responsável anterior); US-066 (versões imutáveis usadas no snapshot da nova rodada e no diff DOC-18); US-152 (análise `IN_REVIEW`, snapshot da rodada 1, LGL-11 e LGL-12). Indiretas: US-047 (o encaminhamento que dispara a retomada), US-149 (painel LGL-02 e abertura), US-150 (designação), US-154 (parecer e ressalvas congelados durante a diligência), US-155 (conclusão da rodada corrente), US-191 (pausa e retomada do SLA consumindo os eventos desta story), US-193 (regras de notificação sobre os eventos), US-130 (etapa `JURIDICO` com as transições `RETURN` da DEC-196).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-194, DEC-196, DEC-199, DEC-205; POL-01, POL-09, POL-11, POL-19; RN-LGL-09 a RN-LGL-14.
- **Configurações:** `legalReview.diligenceDueBusinessDays` (1..60, padrão 10) e `legalReview.diligenceReminderBusinessDays` (0..10, padrão 2), ambas já definidas em `entities.md` §8; nenhuma chave nova.
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos:** `LEGAL_DILIGENCE_NOT_FOUND` (404), `LEGAL_DILIGENCE_ALREADY_ANSWERED` (409) e `LEGAL_TEXT_CONFIDENTIAL` (422, compartilhado com US-154 e US-156) não constam em `permissions.md` nem em `events.md`; a consolidar no `api.md` do MVP 2 junto com os da US-152.
  2. **Ação de auditoria `legal_review.diligence_answer`** (DATA_CHANGE) não está no catálogo de `events.md` §7 (que traz `diligence_request` e `resume`); incluir.
  3. **Campos aditivos de LGL-02** (`canRequestDiligence`, `diligenceTargets[]`, `currentRound`) e o formato de LGL-13/LGL-14/LGL-15 não estão no catálogo de API do MVP 2.
  4. **Payload de `ProcessStageChanged`:** a referência `legalReviewDiligenceId`, usada para suprimir `PROCESS_RETURNED` quando a devolução nasce de diligência, não consta em `events.md`; é mudança aditiva a incluir.
  5. **Quem pode responder a diligência:** `permissions.md` não define permissão para o atendimento; a story adota `PROCESS_VIEW` com custódia (POL-01). **Dúvida de produto:** exigir uma permissão própria (ex.: a de edição do documento a ser corrigido)? E a resposta deve poder anexar arquivos (ATT-*)?
  6. **Prazo sem lembrete depois do vencimento** (RN-LGL-54): `events.md` §6 prevê lembrete "antes do prazo e no vencimento"; não há reenvio periódico. **Dúvida de produto.** O mesmo vale para suspensão do processo (FA-09): estender ou não o `dueAt` da diligência.
  7. **`dueAt` nulo** em `LegalReviewDiligence` (entities.md §4.3) não tem caso de uso aqui: a API sempre grava o prazo; o nulo fica para dados migrados.
  8. **Diligência pedida com o parecer `FINALIZED`:** a story não impede, mas o documento finalizado só volta a ser editável com `DOCUMENT_REOPEN` (US-154, lacuna 1).

## Impacto técnico
- **Transação do pedido:** reaproveita `ProcessFacade.returnToStage` (mesmas invariantes do PRC-20, sem chamada HTTP interna) dentro da transação da análise; a ordem de lock é fixa — `LegalReview`, depois `Process` — para evitar deadlock com a tramitação, que trava o processo e consulta a análise.
- **Gatilho da retomada:** o `StageLifecycleListener` (o mesmo que abre a análise na US-149) ganha o ramo "entrada em `JURIDICO` com análise em `DILIGENCE`", na transação do encaminhamento; reaproveita `LegalReviewSnapshotBuilder.build(processId, round)` da US-152.
- **Lembretes:** consulta no job `deadlines` com o índice parcial `(tenant_id, due_at) WHERE answered_at IS NULL`; idempotente por `lastReminderAt`; fuso e dias úteis pelo calendário do tenant (CAL-05/CAL-06).
- **Imutabilidade:** `legal_review_diligences` aceita `UPDATE` apenas de `answer_summary` (enquanto `answered_at` for nulo), `answered_at` (retomada) e `last_reminder_at`; `request`, `return_stage_key`, `movement_id` e `requested_*` são imutáveis por trigger.
- **Desempenho:** metas p95 de LGL-13 < 1 s, LGL-15 < 300 ms e da retomada < 400 ms adicionais ao encaminhamento, escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda além do campo aditivo em `ProcessStageChanged`; PRC-20 segue como a rota de devolução manual das demais etapas.
- **Sigilo:** pedido e resposta ficam só em `legal_review_diligences`; eventos, logs, auditoria e notificações carregam ids, contagens e nomes de etapa.

## Backend
- **Módulo(s):** `legal-review` (dono), `process` (fachada de devolução e consulta de custódia), `workflow` (destinos permitidos), `document` (versões vigentes), `timeline`, `notification`, `audit`, `access`.
- **Casos de uso:** `RequestLegalDiligenceCommand` (LGL-13), `AnswerLegalDiligenceCommand` (LGL-14), `ListLegalDiligencesQuery` (LGL-15), `ResumeLegalReviewOnStageEntryHandler` (retomada), `LegalDiligenceReminderJob` (fila `deadlines`).
- **Domínio:** `LegalReview.requestDiligence()` (`IN_REVIEW` para `DILIGENCE`) e `LegalReview.resume()` (`DILIGENCE` para `IN_REVIEW`, rodada + 1), `LegalDiligencePolicy` (quem pede, quem responde, sigilo do texto), `LegalReviewSegregationPolicy` (POL-19, compartilhada), `LegalDiligenceStatusResolver` (derivado), `ConfidentialTextGuard` (RN-LGL-56).
- **Integrações internas:** `ProcessFacade.returnToStage` e `getCustody`, `WorkflowFacade.getReturnTargets`, `DocumentFacade.getCurrentVersions`, `BusinessCalendar.addBusinessDays`, `OutboxWriter`, `AuditService`, `TimelineProjector`, `NotificationService`.
- **Transação:** pedido e retomada em transação única (análise, processo, diligência, snapshot, auditoria, outbox e timeline); o lembrete é transação própria por diligência.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`, painel com a seção "Diligências" e a comparação entre rodadas), SCR-006 (aviso e resposta para quem atende), SCR-104 (diálogo de devolução, variante "Pedir diligência"), SCR-013 (o processo devolvido aparece na caixa de tarefas com o selo "Diligência do jurídico").
- **Componentes:** `RequestDiligenceDialog` (texto com contador, seletor de etapa de retorno, prazo com dias úteis, aviso de efeitos), `DiligenceTimeline` (rodadas, pedido, prazo, situação, resposta), `AnswerDiligencePanel` (editor do resumo, ação "Encaminhar de volta ao Jurídico"), `RoundChangesPanel` ("O que mudou desde a rodada anterior", reaproveita `RoundComparePanel` da US-152), `DiligenceStatusBadge`.
- **Estados:** skeleton; vazio ("Nenhuma diligência nesta análise"); erro com "Tentar novamente"; sucesso com toast "Diligência pedida; o processo foi devolvido para {etapa}"; botão desabilitado com motivo; selo "Retomada (rodada {n})" no painel.
- **Acessibilidade e responsividade:** situação nunca só por cor (texto e ícone); contador do texto com `aria-live` educado; foco preso e retornado no diálogo; abaixo de 768 px o diálogo vira tela cheia e a linha do tempo vira lista; contraste AA.

## Banco de dados
- **Tabelas:** `legal_review_diligences` (inserção; `UPDATE` restrito), `legal_reviews` (`status`, `current_round`, `current_process_stage_id`, `version`), `legal_review_documents` (inserção da nova rodada), leitura de `process_stages`, `process_movements`, `workflow_stages`.
- **Migrações:** nenhuma nova (M2-15 já cria as tabelas); o trigger de imutabilidade parcial de `legal_review_diligences` entra em M2-15 (a confirmar com o card de migração).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, legal_review_id, round)`; índice `(tenant_id, due_at) WHERE answered_at IS NULL`; FK composta de `movement_id` com tenant; check `request` com 20..10.000 caracteres; check de transição de `status` na aplicação.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-13` | POST | `/api/v1/legal-reviews/{id}/diligences` | `{ request, returnStageKey, dueAt? }` + `If-Match` + `Idempotency-Key` | `201 { data: LegalReviewDiligence, meta: { review: LegalReview, movementId } }` + `ETag` | 201, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-14` | POST | `/api/v1/legal-review-diligences/{diligenceId}/answer` | `{ answerSummary }` + `If-Match` + `Idempotency-Key` | `200 { data: LegalReviewDiligence }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-15` | GET | `/api/v1/legal-reviews/{id}/diligences` | — | `200 { data: [ { id, round, request, returnStageKey, returnStageName, requestedAt, requestedById, dueAt, answeredAt?, answerSummary?, status } ] }` | 200, 401, 403, 404, 429, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel; ganha `canRequestDiligence`, `diligenceTargets[]` | 200, 401, 403, 404 |
| `LGL-11` | GET | `/api/v1/legal-reviews/{id}/documents` | `round?` (US-152) | versões por rodada, inclusive a rodada nova | 200, 401, 403, 404 |
| `LGL-12` | GET | `/api/v1/legal-reviews/{id}/documents/compare` | `fromRound`, `toRound` (US-152) | mudança por documento | 200, 401, 403, 404, 422 |
| `PRC-20` | POST | `/api/v1/processes/{id}/return` | MVP 1 (regras reutilizadas internamente por LGL-13) | `200 { data: Process }` | 200, 403, 404, 409, 412, 422, 428 |

## Logs
- `info` `legal_review.diligence_requested` — `legalReviewId`, `diligenceId`, `processId`, `round`, `returnStageKey`, `requestLength`, `durationMs`, `correlationId`.
- `info` `legal_review.diligence_answered` — `diligenceId`, `answerLength`; `info` `legal_review.resumed` — `legalReviewId`, `round`, `documentsCount`, `changedCount`, `durationMs`.
- `info` `legal_review.diligence_reminder` — `diligenceId`, `kind` (`ADVANCE` ou `DUE`), `businessDaysLeft`.
- `warn` `legal_review.diligence_denied` — `reasonCode`, `legalReviewId`; `warn` `idempotency.store_unavailable`; `warn` `notification.email_deferred`.
- `error` `legal_review.diligence_failed` e `legal_review.resume_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** texto do pedido ou do resumo, títulos e conteúdo de documentos, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.diligence_request` | `WORKFLOW` | Commit de LGL-13 | `changes.status`: `IN_REVIEW` para `DILIGENCE`; `metadata`: `diligenceId`, `round`, `returnStageKey`, `movementId`, `dueAt`, `requestLength`, `requestHash` (sem o texto) |
| `legal_review.diligence_answer` | `DATA_CHANGE` | Commit de LGL-14 | `metadata`: `diligenceId`, `answerLength`, `answerHash`, `revision` |
| `legal_review.resume` | `WORKFLOW` | Retomada na entrada em `JURIDICO` | `changes.status`: `DILIGENCE` para `IN_REVIEW`; `changes.currentRound`: n para n + 1; `metadata`: `diligenceId`, `documentVersionIds[]`, `changedCount`, `resumedByRole` (quem encaminhou o processo) |
| `access.denied` | `ACCESS` | 403 em LGL-13, LGL-14 ou LGL-15 | `reasonCode`, `legalReviewId` |

## Testes necessários
- **Unitários:** transições `IN_REVIEW` para `DILIGENCE` e `DILIGENCE` para `IN_REVIEW`; cálculo do prazo em dias úteis (feriado, limite de 60); situação derivada (`OPEN`, `OVERDUE`, `ANSWERED`); `ConfidentialTextGuard` (formatos de moeda); regra dos lembretes (antecipado, vencimento, `lastReminderAt`, valor 0); POL-19 e custódia.
- **Integração (Testcontainers):** pedido completo (devolução, diligência, auditoria, evento, timeline, notificação); retomada completa com snapshot da rodada 2 e rodada 1 intacta; rollback total na falha de cada passo; unique por rodada; trigger de imutabilidade parcial; lock `LegalReview` e `Process` sem deadlock com encaminhamento concorrente; devolução antes de ramificação cancelando ramos.
- **API/contrato:** LGL-13/14/15 (códigos, ETag, `Idempotent-Replayed`), campos aditivos de LGL-02, `ProcessStageChanged` com a referência da diligência e supressão de `PROCESS_RETURNED`; PRC-20 inalterado.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-13/14/15 e leitura entre tenants; matriz de autorização (gerada) com `LEGAL_REVIEW_MANAGE`, `PROCESS_RETURN` e `PROCESS_VIEW`; casos de POL-19, designação e custódia; texto do pedido ausente de qualquer log, evento e auditoria.
- **Concorrência:** dois pedidos simultâneos com a mesma ETag (um efetivo); resposta x retomada; retomada x mudança de `assigneeId`; job de lembrete duplicado em duas instâncias do worker (idempotente).
- **E2E (Playwright):** pedir diligência, ver o processo na caixa de tarefas de quem atende, responder, encaminhar de volta, ver o painel retomado com a comparação, receber lembrete.
- **Acessibilidade/performance:** axe em painel, diálogo e linha do tempo; 360 px; metas de p95 na suíte de performance.

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
- [ ] Devolução do processo e diligência gravadas na mesma transação, com rollback comprovado
- [ ] Retomada na mesma transação do encaminhamento, com snapshot da rodada nova e rodada anterior intacta
- [ ] Texto do pedido e da resposta comprovadamente ausente de eventos, logs, auditoria e notificações
- [ ] Gherkin das 8 categorias automatizado, incluindo lembretes com relógio simulado

## Estimativa
**L** — três comandos, um gatilho transacional no encaminhamento, um job de lembretes, integração com a devolução do MVP 1 e com o SLA (eventos), e o painel de rodadas; o esforço está na atomicidade devolução + diligência + retomada e na supressão de notificações duplicadas.

## Prioridade
**P0** — sem diligência e retomada a análise jurídica só termina em parecer ou em dispensa, o que obrigaria a trocar e-mail fora do sistema para qualquer falta de informação; é pré-requisito da pausa de prazo (US-191) e do ciclo completo de FT-074.
