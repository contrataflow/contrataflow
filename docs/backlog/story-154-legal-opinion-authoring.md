---
id: US-154
title: "Elaborar o parecer jurídico e registrar ressalvas"
epic: EP-025
feature: FT-074
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-065, US-110, US-152]
modules: [legal-review, document, process, approval, timeline, audit, access]
screens: [SCR-019, SCR-006, SCR-015, SCR-106]
endpoints: [LGL-20, LGL-16, LGL-17, LGL-18, LGL-02, DOC-05, DOC-08, DOC-10, DOC-12]
permissions: [LEGAL_REVIEW_MANAGE, LEGAL_REVIEW_VIEW, PROCESS_VIEW]
events: [DocumentCreated, DocumentFinalized, LegalReservationResolved]
---

# US-154 — Elaborar o parecer jurídico e registrar ressalvas

## Título
Elaborar o parecer jurídico (`PARECER_JURIDICO`) e registrar ressalvas rastreáveis

## Descrição
**Como** procurador que conduz a análise jurídica de um processo, **quero** abrir o parecer a partir do modelo do órgão, redigi-lo seção por seção no editor, registrar as ressalvas como itens separados e finalizá-lo, com o rascunho visível só a quem conduz a análise, **para** que o parecer fique preso à análise, as ressalvas possam ser acompanhadas por quem vem depois (inclusive pela autoridade) e nada do que ainda está em elaboração vaze para o requisitante.

A story entrega: a abertura do documento `PARECER_JURIDICO` vinculado à análise (LGL-20); a edição das seções e a finalização pelo ciclo de vida do documento (DOC-05, DOC-08, DOC-10 do MVP 1, estendidos por um validador do tipo); a restrição do rascunho (POL-24); e as ressalvas (`LegalReviewReservation`): listar (LGL-16), registrar (LGL-17) e atender ou aceitar o risco (LGL-18). Concluir a análise, escolher a situação conclusiva e a ementa são da US-155; a geração do rascunho por IA é da US-157; pedir diligência é da US-153.

## Contexto
- O art. 53 da Lei 14.133/2021 exige o parecer jurídico na fase preparatória. A DEC-199 o modela como `Document` do tipo `PARECER_JURIDICO` (`SystemDocumentModule.LEGAL_OPINION`, `kind` estruturado, numeração `PJ {seq:4}/{year}`, múltiplos por processo, `requiresApproval = false`) com o ciclo de vida da DEC-018, e torna as ressalvas **itens rastreáveis** que as etapas seguintes veem.
- O modelo do parecer é um template do órgão com relatório, fundamentação, análise dos artefatos (art. 18 e art. 72), ressalvas e conclusão (`overview.md` §7). Quando houver IA (US-157), a seção de conclusão sai sempre como "[a confirmar]" e a situação conclusiva continua sendo escolha do procurador (DEC-202); aplicar texto de IA numa seção nunca altera `LegalReview.status` (POL-18).
- O texto da seção "Ressalvas" do parecer é narrativo; o item rastreável é o `LegalReviewReservation`. As duas coisas precisam andar juntas, e o validador do tipo avisa quando divergem (RN-LGL-89).
- POL-24: enquanto o parecer não está `FINALIZED`, conteúdo e PDF só são lidos por quem tem `LEGAL_REVIEW_MANAGE` cobrindo o processo e por `AUDITOR` com `AUDIT_VIEW`; os demais veem título e status (`DOCUMENT_DRAFT_RESTRICTED`). A US-152 já deixa o parecer fora do snapshot das versões analisadas.
- POL-02 vale para edição: permissão do tipo (aqui `LEGAL_REVIEW_MANAGE`), custódia, documento em `DRAFT`/`RETURNED`, tipo permitido na etapa (`WorkflowStage.documentTypeCodes` de `JURIDICO`) e processo em status editável; POL-19 se soma (segregação e designação).
- POL-23: com ressalvas `OPEN`, a decisão `APPROVE` em `AUTORIZACAO_LICITACAO` exige motivação (≥ 50 caracteres) e reconhecimento do aviso; as ressalvas abertas passam a `RISK_ACCEPTED` na mesma transação da decisão (EP-027). Esta story fornece o mecanismo de domínio e o endpoint que registram o aceite.
- Ressalvas pertencem à análise (não à rodada): sobrevivem à diligência (US-153) e ao eventual retorno do processo ao Jurídico dentro da mesma análise. Eventos já previstos: `DocumentCreated`/`DocumentFinalized` (genéricos do MVP 1, `LegalOpinionIssued` = `document.finalized.parecer_juridico`) e `LegalReservationResolved`.

## Objetivo
Garantir que 100% dos pareceres nasçam do modelo publicado do órgão e vinculados a uma única análise, que nenhum rascunho seja lido por quem não conduz a análise, que toda ressalva registrada seja rastreável até o atendimento ou o aceite do risco, e que o procurador chegue ao parecer finalizado e às ressalvas em até 3 cliques a partir do painel.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) designado como `assigneeId` da análise — redige o parecer e registra as ressalvas.
- **Secundárias:** titular ou substituto da unidade jurídica (podem conduzir análise sem designação, POL-19); responsável da etapa seguinte ou de quem atende a ressalva (Planejamento, Compras, Licitações), que registra o atendimento; Autoridade competente (`AUTORIDADE_COMPETENTE`), que lê o parecer finalizado e aceita o risco de ressalvas abertas; Auditor (`AUDITOR`) e Controle Interno (leem o rascunho — só o auditor — e o finalizado).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`LEGAL_REVIEW_MANAGE` é risco `M`: MFA só com política `ALL`).
- Para **abrir o parecer e registrar ressalvas**: `LegalReview` em `IN_REVIEW` na etapa `JURIDICO` ativa; usuário com `LEGAL_REVIEW_MANAGE` cobrindo o processo, sem conflito de POL-19, `assigneeId` ou titular/substituto da unidade jurídica; para o documento, o tipo `PARECER_JURIDICO` ativo no tenant com modelo `PUBLISHED` e permitido na etapa.
- Para **atender uma ressalva**: ressalva `OPEN` de análise que não esteja `CANCELED`; usuário com a custódia do processo (POL-01) e `PROCESS_VIEW`, ou o procurador responsável com `LEGAL_REVIEW_MANAGE`.
- Para **aceitar o risco**: ressalva `OPEN`; usuário é aprovador com linha `PENDING` (POL-03) de aprovação do processo na etapa `AUTORIZACAO_LICITACAO` que cobre `PARECER_JURIDICO`.

## Fluxo principal
1. O procurador, com a análise `IN_REVIEW` no painel (`/juridico/[reviewId]`, SCR-019), aciona **"Elaborar parecer"**. O front envia LGL-20 com `If-Match` (ETag da análise) e `Idempotency-Key`.
2. A API valida existência e tenant, permissão e POL-19, designação, status `IN_REVIEW`, processo e etapa, tipo permitido na etapa e modelo publicado. Na mesma transação, cria o `Document` `PARECER_JURIDICO` em `DRAFT` (código `PJ 0007/2026`, título padrão "Parecer jurídico — 0045/2026", seções do modelo inicializadas, responsável o próprio procurador), grava `LegalReview.opinionDocumentId`, incrementa o `version` da análise e responde 201 com o documento. Se a análise já tem um parecer não cancelado, a API responde 200 com o existente (abrir é idempotente).
3. O editor do parecer abre (`/processos/[id]/documentos/[docId]`) com as seções do modelo (relatório, fundamentação, análise dos artefatos, ressalvas e conclusão) e um painel lateral "Versões analisadas (rodada {n})" com atalho "Abrir versão" (DOC-17) para cada documento do snapshot.
4. O procurador redige; o autosave grava cada seção (DOC-05, `If-Match` de seção) sem criar versão, e o rascunho só aparece em leitura para ele, para o titular/substituto e demais pessoas com `LEGAL_REVIEW_MANAGE` sem conflito de segregação, e para `AUDITOR` com `AUDIT_VIEW` (RN-LGL-87).
5. Para cada ressalva, o procurador usa **"Adicionar ressalva"** no painel: informa a descrição (10 a 5.000 caracteres) e, se quiser, o documento afetado (lista dos tipos da rodada atual). O front envia LGL-17; a API trava a análise, atribui o próximo `sequence`, grava `LegalReviewReservation` `OPEN`, audita `legal_review.reservation_create` e responde 201. A lista (LGL-16) mostra as ressalvas numeradas, com situação e documento afetado.
6. O procurador pode usar **"Inserir ressalvas registradas"** para copiar a lista para a seção "Ressalvas" do parecer (texto que ele continua editando).
7. Ao terminar, abre a validação (DOC-08): pendências bloqueantes (seções obrigatórias, seções de IA sem revisão, "[a confirmar]") e avisos (versão analisada desatualizada, ressalvas e seção "Ressalvas" divergentes).
8. O procurador aciona **"Finalizar parecer"** (DOC-10) reconhecendo os avisos pendentes. A API aplica o `LegalOpinionValidator`, cria a `DocumentVersion` (`reason = FINALIZATION`), muda o documento para `FINALIZED`, publica `DocumentFinalized` (`LegalOpinionIssued`) com o `typedSummary` e libera a leitura do parecer a quem tem `PROCESS_VIEW`. A análise continua `IN_REVIEW`: **finalizar não conclui** (US-155).
9. Depois da conclusão (US-155), quem atende vê as ressalvas `OPEN` em SCR-006 (aba Resumo, bloco "Ressalvas do parecer") e registra **"Marcar como atendida"** com a resposta (LGL-18), o que publica `LegalReservationResolved`.
10. Na etapa `AUTORIZACAO_LICITACAO` (SCR-015), a autoridade vê o parecer e as ressalvas `OPEN` como aviso; ao decidir, pode **aceitar o risco** de cada ressalva com motivação (LGL-18) ou deixar a decisão `APPROVE` aceitar em bloco (POL-23); em ambos os casos a ressalva fica `RISK_ACCEPTED`.

## Fluxos alternativos
- **FA-01 — Parecer já aberto:** LGL-20 em análise que já tem parecer `DRAFT`, `RETURNED` ou `FINALIZED` responde 200 com o documento existente e não cria outro (RN-LGL-85).
- **FA-02 — Parecer cancelado:** se o documento foi cancelado (DOC-13), LGL-20 cria um novo e passa o vínculo `opinionDocumentId` a ele; o cancelado permanece no processo como histórico (RN-LGL-85).
- **FA-03 — Tipo sem modelo publicado:** LGL-20 responde 422 `VALIDATION_ERROR` (`REFERENCE_INACTIVE` em `documentType`) com a orientação de falar com o administrador (RN-DOC-22 do MVP 1).
- **FA-04 — Análise fora de `IN_REVIEW`:** em `PENDING`, `DILIGENCE`, `WAIVED`, final ou `CANCELED`, abrir o parecer, editar o rascunho e registrar ressalva respondem 409 `LEGAL_REVIEW_INVALID_STATE`; o painel mostra o parecer em leitura quando já existe (RN-LGL-86, RN-LGL-91).
- **FA-05 — Parecer finalizado antes de uma diligência:** a diligência não é impedida (US-153), mas, na nova rodada, o documento `FINALIZED` só volta a ser editável com reabertura (DOC-12, `DOCUMENT_REOPEN`, POL-11, com justificativa); a reabertura só vale com a análise `IN_REVIEW` (RN-LGL-90).
- **FA-06 — Finalizar com aviso não reconhecido:** DOC-10 responde 422 `WARNINGS_NOT_ACKNOWLEDGED`; o checklist de avisos reaparece (US-065).
- **FA-07 — Ressalvas registradas e seção "Ressalvas" vazia (ou o inverso):** o validador gera o aviso `RESERVATIONS_NOT_MENTIONED` ou `RESERVATIONS_SECTION_WITHOUT_ITEMS`; não bloqueia (RN-LGL-89).
- **FA-08 — Versão analisada desatualizada:** se algum documento do snapshot ganhou versão nova depois do início, o aviso `ANALYZED_VERSION_OUTDATED` lista os tipos e orienta pedir diligência para registrar a nova rodada (US-153); não bloqueia (RN-LGL-89).
- **FA-09 — Ressalva duplicada:** descrição e documento afetado iguais a uma ressalva já registrada na análise respondem 409 `LEGAL_RESERVATION_DUPLICATE` (RN-LGL-91).
- **FA-10 — Editar ressalva `OPEN` antes da conclusão:** o procurador corrige descrição ou documento afetado enquanto a análise está `IN_REVIEW`; depois, a ressalva é imutável (RN-LGL-95).
- **FA-11 — Atender ressalva já resolvida:** a segunda tentativa de atender ou aceitar responde 409 `LEGAL_RESERVATION_NOT_OPEN` (RN-LGL-93, RN-LGL-94).
- **FA-12 — Leitura do rascunho por quem não conduz:** o requisitante abre o parecer e vê só título, código e situação "Em elaboração"; os endpoints de conteúdo, versões, PDF e comentários do documento respondem 403 `DOCUMENT_DRAFT_RESTRICTED` (RN-LGL-87).
- **FA-13 — Aceite de risco por quem não é o aprovador:** 403 `NOT_DESIGNATED_APPROVER`; o botão "Aceitar risco" só aparece para a linha `PENDING` do usuário em SCR-015 (RN-LGL-94).

## Regras de negócio
- **RN-LGL-09** — A análise considera as versões exatas dos documentos; o parecer **não entra** no snapshot das versões analisadas, só é vinculado na conclusão (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-10** — Segregação: quem elaborou o processo ou seus documentos não analisa, não redige o parecer nem registra ressalvas (POL-19). *(regra da feature, adotada)*
- **RN-LGL-11** — Situações do produto; esta story não muda o `status` da análise. *(regra da feature, adotada)*
- **RN-LGL-15** — O parecer em rascunho só é lido por quem tem `LEGAL_REVIEW_MANAGE` cobrindo o processo e por `AUDITOR` com `AUDIT_VIEW`; os demais veem título e status (POL-24, `DOCUMENT_DRAFT_RESTRICTED`). *(regra da feature, adotada)*
- **RN-LGL-17** — A finalização exige que todas as seções geradas por IA estejam revisadas (US-122), conferido por DOC-10 (DEC-202). *(regra da feature, adotada)*
- **RN-LGL-18** — `FAVORABLE_WITH_RESERVATIONS` exige ao menos uma ressalva; `ADDRESSED` exige a resposta e `RISK_ACCEPTED` exige motivação da autoridade (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-85** *(nova)* — Abrir o parecer (LGL-20): análise `IN_REVIEW`, `LEGAL_REVIEW_MANAGE` cobrindo o processo, POL-19 e designação (`assigneeId` ou titular/substituto), `PARECER_JURIDICO` permitido na etapa (`DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) e modelo publicado. Cria `Document` `DRAFT` com `code` `PJ {seq:4}/{year}` (numeração por `(tenant, tipo, ano)`), título padrão "Parecer jurídico — {código do processo}" editável (5 a 250 caracteres) e `responsibleId` o próprio usuário. Uma análise tem **um** parecer ativo: com `opinionDocumentId` apontando para documento não `CANCELED`, a chamada devolve esse documento (200); se estiver `CANCELED`, cria outro e troca o vínculo. A criação e o vínculo são atômicos sob `SELECT … FOR UPDATE` na análise.
- **RN-LGL-86** *(nova)* — Edição do rascunho: POL-02 (permissão do tipo = `LEGAL_REVIEW_MANAGE`, custódia, `DRAFT`/`RETURNED`) mais POL-19 e designação, **e** análise `IN_REVIEW`; em `DILIGENCE`, `PENDING`, final ou `CANCELED` o parecer fica somente leitura (`LEGAL_REVIEW_INVALID_STATE`). O autosave (DOC-05) segue o mecanismo do MVP 1 (sem versão, `If-Match` de seção, auditoria coalescida). Outras pessoas com `LEGAL_REVIEW_MANAGE` leem o rascunho, mas só o designado ou o titular/substituto o editam (`NOT_LEGAL_REVIEW_ASSIGNEE`).
- **RN-LGL-87** *(nova)* — Rascunho restrito (POL-24), enquanto o documento não estiver `FINALIZED`: quem não é leitor autorizado (`LEGAL_REVIEW_MANAGE` cobrindo o processo sem conflito de POL-19, ou `AUDITOR` com `AUDIT_VIEW`) vê somente título, código, tipo, responsável e situação; o conteúdo das seções, as versões, a comparação, a prévia/PDF e os comentários ancorados no documento respondem 403 `DOCUMENT_DRAFT_RESTRICTED`. A restrição é decidida pelo `DocumentAccessPolicy` com base em `DocumentType.systemModule = LEGAL_OPINION` e `status`, vale para os endpoints de leitura do MVP 1 (DOC-03, DOC-15, DOC-17, DOC-18, DOC-20 a DOC-23) e é compartilhada com a manifestação do Controle Interno. Depois de `FINALIZED`, o parecer é lido como os demais documentos (`PROCESS_VIEW`, DEC-024 e POL-09). Reaberto (`DRAFT`), volta a ser restrito.
- **RN-LGL-88** *(nova)* — Vínculo e leitura do conjunto: `LegalReview.opinionDocumentId` aponta para o parecer da análise; o painel (LGL-02) mostra o documento, a situação e, quando existir, a versão finalizada; o parecer concluído de um processo visível é lido com `PROCESS_VIEW`, inclusive por quem não tem `LEGAL_REVIEW_VIEW` (SCR-006, SCR-015).
- **RN-LGL-89** *(nova)* — Validador do tipo (`LegalOpinionDocumentValidator`, registrado para `LEGAL_OPINION`, componente de DOC-08/DOC-10): bloqueantes — seções `REQUIRED` incompletas (genérico), seções de IA sem revisão e "[a confirmar]" pendente (US-122), análise fora de `IN_REVIEW` (`LEGAL_REVIEW_INVALID_STATE`); avisos — `ANALYZED_VERSION_OUTDATED` (documento do snapshot da rodada corrente com versão mais nova), `RESERVATIONS_NOT_MENTIONED` (há ressalva registrada e a seção "Ressalvas" está vazia ou marcada "não se aplica") e `RESERVATIONS_SECTION_WITHOUT_ITEMS` (a seção "Ressalvas" tem conteúdo e não há ressalva registrada). Avisos exigem `acknowledgedWarnings` na finalização. O `typedSummary` do `DocumentFinalized` leva `legalReviewId`, `round`, `reservationsCount`, `openReservationsCount` e nunca texto.
- **RN-LGL-90** *(nova)* — Finalizar e reabrir: finalizar (DOC-10) cria a versão e libera a leitura, mas não altera a análise nem a situação conclusiva; reabrir um parecer `FINALIZED` (DOC-12, `DOCUMENT_REOPEN` + POL-11, justificativa de 20 caracteres) só é possível com a análise `IN_REVIEW`; depois da conclusão, a versão vinculada é imutável e DOC-12 responde 409 `LEGAL_REVIEW_INVALID_STATE`. Corrigir um parecer concluído exige nova análise (DEC-196).
- **RN-LGL-91** *(nova)* — Registrar ressalva (LGL-17): análise `IN_REVIEW`, mesmas exigências de RN-LGL-85; `description` de 10 a 5.000 caracteres, texto puro, aparada; `documentTypeCode` opcional, restrito aos tipos presentes no snapshot da rodada corrente (RN-LGL-41), senão 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`); `sequence` é o próximo inteiro da análise, atribuído sob lock; nasce `OPEN`; duas ressalvas com a mesma descrição normalizada (aparada, espaços colapsados, sem distinção de caixa) e o mesmo `documentTypeCode` são recusadas com 409 `LEGAL_RESERVATION_DUPLICATE`. Com orçamento sigiloso, a descrição não pode conter valor monetário (`LEGAL_TEXT_CONFIDENTIAL`, regra da US-153, RN-LGL-56).
- **RN-LGL-92** *(nova)* — Leitura (LGL-16): quem tem `LEGAL_REVIEW_VIEW` ou `PROCESS_VIEW` cobrindo o processo (DEC-024) lê todas as ressalvas da análise, ordenadas por `sequence`, com `status`, resposta e `openCount`; é assim que as etapas seguintes as veem (DEC-199). O contador `openReservations` do provedor `legalReview.*` (US-155) lê a mesma tabela. Ressalvas de análise `CANCELED` são lidas, mas não mudam.
- **RN-LGL-93** *(nova)* — Atender (`ADDRESSED`): transição `OPEN` para `ADDRESSED` com `response` de 10 a 5.000 caracteres (sem valor sigiloso); quem atende tem a custódia do processo (POL-01, `NOT_PROCESS_CUSTODIAN`) e `PROCESS_VIEW`, ou é o procurador responsável com `LEGAL_REVIEW_MANAGE`; permitido em qualquer situação da análise exceto `CANCELED`; grava `respondedById`/`respondedAt`, publica `LegalReservationResolved` e é terminal (não há reabertura).
- **RN-LGL-94** *(nova)* — Aceitar o risco (`RISK_ACCEPTED`): transição `OPEN` para `RISK_ACCEPTED` com `response` (motivação) de **50 a 5.000** caracteres; só por quem tem linha `PENDING` (POL-03) em aprovação do processo na etapa `AUTORIZACAO_LICITACAO` que cobre `PARECER_JURIDICO` (`NOT_DESIGNATED_APPROVER`) e que não seja autor do parecer (POL-23, `LEGAL_REVIEW_SEGREGATION`); exige o parecer `FINALIZED`. A decisão `APPROVE` da etapa (POL-23, EP-027) usa o mesmo serviço de domínio (`LegalReservationService.acceptRisk`) na própria transação, com a motivação da decisão, sem chamar LGL-18. Terminal.
- **RN-LGL-95** *(nova)* — Editar ressalva (LGL-18 com `description` e/ou `documentTypeCode`): só ressalva `OPEN`, análise `IN_REVIEW` e quem pode registrar (RN-LGL-91); as mesmas validações e a checagem de duplicidade valem; depois da conclusão a ressalva é imutável quanto a texto e documento afetado — só muda a situação (RN-LGL-93/94). O corpo do `PATCH` é de edição **ou** de resolução, nunca os dois (`VALIDATION_ERROR`, `MUTUALLY_EXCLUSIVE`). Não existe exclusão de ressalva (lacuna 5).
- **RN-LGL-96** *(nova)* — Rodadas e diligência: as ressalvas pertencem à análise e persistem entre rodadas; durante `DILIGENCE` não se registram nem se editam, mas podem ser atendidas (RN-LGL-93); o parecer em rascunho também persiste (RN-LGL-50 da US-153).
- **RN-LGL-97** *(nova)* — Concorrência: LGL-17 trava a análise (`SELECT … FOR UPDATE`) para atribuir `sequence` sem lacuna nem duplicidade (`UNIQUE (tenant_id, legal_review_id, sequence)`); LGL-18 usa `If-Match` com a `version` da ressalva (412 `VERSION_CONFLICT`) e, quando a ressalva já não está `OPEN`, 409 `LEGAL_RESERVATION_NOT_OPEN`; LGL-20 é atômica e idempotente por `Idempotency-Key` e pelo vínculo `opinionDocumentId`.
- **RN-LGL-98** *(nova)* — Eventos e notificações: registrar ou editar ressalva gera apenas auditoria (`events.md` não prevê evento nem notificação); atender ou aceitar o risco publica `LegalReservationResolved` (`legalReviewId`, `reservationId`, `status`), projeta `LEGAL_RESERVATION_RESOLVED` na timeline ("Ressalva {sequence} do parecer {statusLabel}") e não notifica; texto de ressalva, resposta e parecer nunca entra em evento, log, notificação ou auditoria (só ids, tamanhos e hashes).
- **RN-LGL-99** *(nova)* — Integração com IA (US-157): o parecer gerado por IA entra como rascunho do mesmo documento pelos endpoints de IA do MVP 1 (AI-01, DOC-26, DOC-27), com POL-18 e POL-19; esta story não cria endpoint de IA e não permite que a IA registre ressalva, aceite risco ou escolha a situação conclusiva.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Análise | `id` (path) | uuid | Sim | `LegalReview` do tenant | rota |
| Título do parecer | `title` (LGL-20) | texto (5..250) | Não | RN-LGL-85 | "Parecer jurídico — {código do processo}" |
| Versão da análise | `If-Match` (ETag) | texto | Sim (LGL-17, LGL-20) | ETag da `LegalReview` | `GET` LGL-02 |
| Versão da ressalva | `If-Match` (ETag) | texto | Sim (LGL-18) | ETag da `LegalReviewReservation` | `GET` LGL-16 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (POST) | 24 h | gerada pelo front |
| Descrição da ressalva | `description` | texto longo (10..5.000) | Sim (LGL-17) | RN-LGL-91 | em branco |
| Documento afetado | `documentTypeCode` | seleção (≤ 40) | Não | tipos do snapshot da rodada corrente | nenhum |
| Situação (resolver) | `status` | `ADDRESSED` \| `RISK_ACCEPTED` | Condicional (LGL-18) | RN-LGL-93/94 | — |
| Resposta ou motivação | `response` | texto longo (10..5.000; 50.. em `RISK_ACCEPTED`) | Condicional | RN-LGL-93/94 | em branco |
| *(saída)* Parecer | `opinionDocumentId`, `document` (`id`, `code`, `title`, `status`) | uuid / objeto | — | RN-LGL-85/88 | `LegalReview` |
| *(saída)* Ressalva | `id`, `sequence`, `status`, `respondedById`, `respondedAt`, `version` | uuid / int / enum | — | RN-LGL-92 | `LegalReviewReservation` |
| *(saída)* Contagens | `reservationsCount`, `openCount` | int | — | derivado | LGL-16 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `description` com menos de 10 ou mais de 5.000 caracteres | Front + API (Zod) | "Descreva a ressalva com 10 a 5.000 caracteres." | `VALIDATION_ERROR` |
| V-02 | `documentTypeCode` fora dos tipos da rodada atual | API | "Escolha um documento analisado nesta rodada." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | `PATCH` com edição e resolução no mesmo corpo, ou sem nenhum campo | API (Zod) | "Informe a alteração da ressalva ou a sua resolução." | `VALIDATION_ERROR` (`MUTUALLY_EXCLUSIVE`/`REQUIRED`) |
| V-04 | `response` com menos de 10 caracteres (atender) ou menos de 50 (aceitar o risco) | Front + API | "Informe como a ressalva foi atendida (mín. 10)." / "Informe a motivação da autoridade (mín. 50)." | `VALIDATION_ERROR` |
| V-05 | Texto com valor monetário em processo de orçamento sigiloso | API | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | `LEGAL_TEXT_CONFIDENTIAL` (422) |
| V-06 | `title` fora de 5..250 caracteres | Front + API | "Informe um título entre 5 e 250 caracteres." | `VALIDATION_ERROR` |
| V-07 | Tipo `PARECER_JURIDICO` sem modelo publicado | API | "O parecer não tem um modelo publicado. Fale com o administrador." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-08 | Tipo não permitido na etapa atual | API | "Este tipo de documento não é permitido na etapa atual." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| V-09 | Análise fora de `IN_REVIEW` (abrir, registrar, editar) | API | "A análise não está em andamento." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-10 | Ressalva duplicada | API | "Já existe uma ressalva com a mesma descrição para este documento." | `LEGAL_RESERVATION_DUPLICATE` (409) |
| V-11 | Ressalva já resolvida ou análise com ressalva imutável | API | "Esta ressalva já foi resolvida." | `LEGAL_RESERVATION_NOT_OPEN` (409) |
| V-12 | `If-Match` ausente ou divergente | API | "Atualize a página e tente de novo." / "Esta ressalva foi alterada por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-13 | Usuário em conflito de segregação (POL-19) ou autor do parecer aceitando risco | API | "Você participou da elaboração deste processo e não pode realizar esta ação." | `LEGAL_REVIEW_SEGREGATION` (403) |
| V-14 | Usuário não é o designado nem titular/substituto | API | "Esta análise está designada a outra pessoa." | `NOT_LEGAL_REVIEW_ASSIGNEE` (403) |
| V-15 | Atender sem custódia nem `LEGAL_REVIEW_MANAGE` | API | "Você não está com este processo." | `NOT_PROCESS_CUSTODIAN` (403) |
| V-16 | Aceitar o risco sem linha de aprovação `PENDING` | API | "Apenas o aprovador designado pode aceitar o risco." | `NOT_DESIGNATED_APPROVER` (403) |
| V-17 | Leitura de conteúdo do rascunho sem direito | API | "O parecer está em elaboração e só pode ser lido por quem conduz a análise." | `DOCUMENT_DRAFT_RESTRICTED` (403) |
| V-18 | Finalização com avisos sem reconhecimento | API | "Reconheça os avisos para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` (422) |
| V-19 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_MANAGE` cobrindo o processo para abrir o parecer, editar o rascunho, finalizar e registrar ou editar ressalvas; `LEGAL_REVIEW_VIEW` ou `PROCESS_VIEW` para listar as ressalvas e ler o parecer finalizado; atender exige custódia (POL-01) com `PROCESS_VIEW`, ou `LEGAL_REVIEW_MANAGE`; aceitar o risco exige ser aprovador designado na etapa `AUTORIZACAO_LICITACAO` (`APPROVAL_DECIDE`, POL-03, POL-23).
- **Políticas:** POL-02 (edição de documento, com `PARECER_JURIDICO` ← `LEGAL_REVIEW_MANAGE`), POL-19 (segregação e designação), POL-24 (rascunho restrito), POL-23 (aceite de risco e segregação do aprovador), POL-18 (IA no parecer, US-157), POL-11 (reabertura), DEC-024 (visibilidade), POL-09 (sigilo no texto).
- **MFA:** `LEGAL_REVIEW_MANAGE` é risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** "Elaborar parecer", "Adicionar ressalva" e o editor ficam ocultos sem `LEGAL_REVIEW_MANAGE` e em leitura para quem só lê; a API responde 403 `PERMISSION_DENIED`, `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE`, `NOT_PROCESS_CUSTODIAN`, `NOT_DESIGNATED_APPROVER` ou `DOCUMENT_DRAFT_RESTRICTED` e grava `access.denied`; análise ou ressalva de outro tenant ou de processo invisível responde 404 (`LEGAL_REVIEW_NOT_FOUND`, `LEGAL_RESERVATION_NOT_FOUND`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.parecer_juridico` | Commit de LGL-20 (parecer novo) | Evento genérico do MVP 1 (`documentId`, `documentTypeCode`, `code`, `title`, `templateVersionId`); projeta `DOCUMENT_CREATED` na timeline |
| `DocumentFinalized` (nome do produto `LegalOpinionIssued`) | `document.finalized.parecer_juridico` | Commit de DOC-10 sobre o parecer | `typedSummary`: `legalReviewId`, `round`, `reservationsCount`, `openReservationsCount`; sem texto; projeta `DOCUMENT_FINALIZED` |
| `LegalReservationResolved` | `legal_review.reservation_resolved` | Commit de LGL-18 com `ADDRESSED`/`RISK_ACCEPTED` (ou aceite em bloco na decisão, POL-23) | `legalReviewId`, `reservationId`, `status`; timeline `LEGAL_RESERVATION_RESOLVED`; consumidor T (e R, quando o read model precisar de `openReservations`) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story: `events.md` §6 não prevê tipo para ressalva registrada, atendida ou aceita, nem para a finalização do parecer (a notificação do parecer é a `LEGAL_REVIEW_CONCLUDED` da US-155) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Elaborar o parecer jurídico e registrar ressalvas

  Background:
    Given que o tenant "Prefeitura A" está ativo e o modelo "PARECER_JURIDICO" está publicado
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "JURIDICO", que permite o tipo "PARECER_JURIDICO"
    And a análise "LR-0045" está "IN_REVIEW" na rodada 1, designada a "Dr. André Nunes", com DFD v2, ETP v3, TR v4 e edital v1 registrados
    And "Dr. André Nunes" tem o perfil "JURIDICO" com "LEGAL_REVIEW_MANAGE" cobrindo o processo e não participou da elaboração
    And "Dra. Helena Prado" é titular da unidade jurídica
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e é autora do TR
    And "Marcos Ribeiro", de Compras, tem "PROCESS_VIEW" e "Dr. Ricardo Alves" é a autoridade competente designada na etapa "AUTORIZACAO_LICITACAO"

  Scenario: [Sucesso] Abrir o parecer a partir do modelo do órgão
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id}/opinion" com a chave "K1"
    Then a API deve responder 201 com um documento "PARECER_JURIDICO" em "DRAFT", código "PJ 0001/2026" e as seções do modelo
    And "opinionDocumentId" da análise deve apontar para o documento e a análise deve continuar "IN_REVIEW"
    And deve ser publicado o evento "DocumentCreated" do tipo "parecer_juridico"

  Scenario: [Sucesso] Abrir o parecer de novo devolve o mesmo documento
    Given que o parecer "PJ 0001/2026" já foi aberto
    When "Dra. Helena Prado" chamar "POST /legal-reviews/{id}/opinion" com outra chave e a ETag atual
    Then a API deve responder 200 com o mesmo documento e nenhum documento novo deve ser criado

  Scenario: [Sucesso] Rascunho lido só por quem conduz a análise
    Given que "Dr. André Nunes" salvou a seção "Relatório" do parecer em rascunho
    When "Dra. Helena Prado" chamar "GET /documents/{id}"
    Then a API deve responder 200 com o conteúdo das seções
    When "Marcos Ribeiro" chamar "GET /documents/{id}"
    Then a API deve responder 200 apenas com título, código, tipo e situação "DRAFT"
    When "Marcos Ribeiro" chamar "POST /documents/{id}/preview"
    Then a API deve responder 403 com código "DOCUMENT_DRAFT_RESTRICTED"
    When "Carla Mendes", que também tem o perfil "JURIDICO", chamar "GET /documents/{id}"
    Then a API deve responder 403 com código "DOCUMENT_DRAFT_RESTRICTED"
    When um usuário "AUDITOR" com "AUDIT_VIEW" chamar "GET /documents/{id}"
    Then a API deve responder 200 com o conteúdo

  Scenario: [Sucesso] Registrar ressalvas numeradas
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id}/reservations" com a descrição "Cláusula de reajuste do edital sem índice definido" e "documentTypeCode" "EDITAL"
    Then a API deve responder 201 com "sequence" 1 e "status" "OPEN"
    And deve gerar a auditoria "legal_review.reservation_create" sem o texto da descrição
    And nenhum evento de domínio deve ser publicado
    When "Dr. André Nunes" registrar uma segunda ressalva sem documento afetado
    Then a API deve responder 201 com "sequence" 2
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}/reservations"
    Then a API deve responder 200 com as duas ressalvas ordenadas por "sequence" e "openCount" 2

  Scenario: [Sucesso] Editar uma ressalva aberta antes da conclusão
    Given que existe a ressalva 1 "OPEN" com a ETag "R1"
    When "Dr. André Nunes" chamar "PATCH /legal-review-reservations/{id}" com nova descrição e "If-Match" "R1"
    Then a API deve responder 200 com a descrição nova e a ETag incrementada
    And deve gerar a auditoria "legal_review.reservation_update"

  Scenario: [Sucesso] Finalizar o parecer reconhecendo os avisos
    Given que as seções obrigatórias do parecer estão preenchidas e a seção "Ressalvas" está vazia, com 2 ressalvas registradas
    When "Dr. André Nunes" chamar "GET /documents/{id}/validation"
    Then a API deve responder 200 com o aviso "RESERVATIONS_NOT_MENTIONED" e nenhuma pendência bloqueante
    When "Dr. André Nunes" chamar "POST /documents/{id}/finalize" reconhecendo "RESERVATIONS_NOT_MENTIONED"
    Then a API deve responder 200 com o parecer "FINALIZED" e uma "DocumentVersion" v1
    And deve ser publicado "DocumentFinalized" com "reservationsCount" 2 e sem texto
    And a análise deve continuar "IN_REVIEW"
    And "Marcos Ribeiro" deve conseguir ler o conteúdo do parecer finalizado

  Scenario: [Sucesso] Atender uma ressalva depois da conclusão
    Given que a análise foi concluída como "FAVORABLE_WITH_RESERVATIONS" e o processo está com "Marcos Ribeiro"
    When "Marcos Ribeiro" chamar "PATCH /legal-review-reservations/{id}" com "status" "ADDRESSED" e a resposta "Índice IPCA definido na versão 2 do edital"
    Then a API deve responder 200 com a ressalva "ADDRESSED", "respondedById" e "respondedAt" preenchidos
    And deve ser publicado "LegalReservationResolved" com "status" "ADDRESSED"
    And a timeline deve exibir "Ressalva 1 do parecer atendida"
    And deve gerar a auditoria "legal_review.reservation_resolve"

  Scenario: [Sucesso] A autoridade aceita o risco de uma ressalva aberta
    Given que a ressalva 2 está "OPEN", o parecer está "FINALIZED" e "Dr. Ricardo Alves" tem linha "PENDING" na aprovação da etapa "AUTORIZACAO_LICITACAO"
    When "Dr. Ricardo Alves" chamar "PATCH /legal-review-reservations/{id}" com "status" "RISK_ACCEPTED" e motivação de 70 caracteres
    Then a API deve responder 200 com a ressalva "RISK_ACCEPTED"
    And deve ser publicado "LegalReservationResolved" com "status" "RISK_ACCEPTED"

  Scenario: [Validação] Dados inválidos de ressalva, parecer e resolução
    When "Dr. André Nunes" registrar uma ressalva com descrição de 5 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Dr. André Nunes" registrar uma ressalva com "documentTypeCode" "RISK_MAP" que não consta no snapshot da rodada
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "documentTypeCode"
    When "Dr. Ricardo Alves" tentar aceitar o risco com motivação de 30 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Marcos Ribeiro" enviar "ADDRESSED" e nova descrição no mesmo corpo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "MUTUALLY_EXCLUSIVE"
    Given que o orçamento do processo é sigiloso
    When "Dr. André Nunes" registrar uma ressalva citando "R$ 2.300.000,00"
    Then a API deve responder 422 com código "LEGAL_TEXT_CONFIDENTIAL"
    Given que a seção obrigatória "Fundamentação" está vazia
    When "Dr. André Nunes" tentar finalizar o parecer
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE"
    And o parecer deve continuar "DRAFT"

  Scenario: [Validação] Análise fora de IN_REVIEW
    Given que a análise está em "DILIGENCE"
    When "Dr. André Nunes" registrar uma ressalva ou editar uma seção do parecer
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE" nas duas chamadas

  Scenario: [Permissão] Segregação, outra designação, sem permissão e aceite indevido
    Given que "Carla Mendes" também tem o perfil "JURIDICO" com "LEGAL_REVIEW_MANAGE"
    When "Carla Mendes" chamar "POST /legal-reviews/{id}/opinion"
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION" e gerar a auditoria "access.denied"
    Given que "Dra. Lúcia Prado", procuradora sem relação com a análise, não é a designada nem titular
    When "Dra. Lúcia Prado" registrar uma ressalva
    Then a API deve responder 403 com código "NOT_LEGAL_REVIEW_ASSIGNEE"
    Given que "Bruno Lopes" não tem "LEGAL_REVIEW_MANAGE"
    When "Bruno Lopes" chamar "POST /legal-reviews/{id}/reservations"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que "Bruno Lopes" não tem a custódia do processo
    When "Bruno Lopes" tentar atender a ressalva 1
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    When "Marcos Ribeiro", que não é aprovador, tentar aceitar o risco da ressalva 2
    Then a API deve responder 403 com código "NOT_DESIGNATED_APPROVER"
    And as ressalvas devem continuar "OPEN"

  Scenario: [Tenant incorreto] Análise e ressalva de outro órgão
    Given que a análise "LR-0007" e a ressalva "RES-0007" pertencem ao tenant "Prefeitura B"
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id-LR-0007}/opinion", "GET /legal-reviews/{id-LR-0007}/reservations" e "PATCH /legal-review-reservations/{id-RES-0007}"
    Then a API deve responder 404 com os códigos "LEGAL_REVIEW_NOT_FOUND" nas duas primeiras e "LEGAL_RESERVATION_NOT_FOUND" na terceira
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio, descrição repetida e resolução repetida
    Given que "Dr. André Nunes" registrou a ressalva com a chave "K2" e recebeu 201
    When a mesma requisição for reenviada com a chave "K2"
    Then a API deve responder 201 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única ressalva com aquele "sequence"
    When "Dr. André Nunes" registrar outra ressalva com a mesma descrição e o mesmo documento afetado e a chave "K3"
    Then a API deve responder 409 com código "LEGAL_RESERVATION_DUPLICATE"
    Given que a ressalva 1 foi atendida
    When "Marcos Ribeiro" tentar atender a ressalva 1 de novo
    Then a API deve responder 409 com código "LEGAL_RESERVATION_NOT_OPEN"

  Scenario: [Concorrência] Ressalvas simultâneas, resolução simultânea e conflito de seção
    When "Dr. André Nunes" e "Dra. Helena Prado" registrarem ressalvas diferentes ao mesmo tempo
    Then as duas devem responder 201 ou uma delas 412 com código "VERSION_CONFLICT" e ser repetida com sucesso
    And os "sequence" devem ser consecutivos, sem lacuna nem repetição
    When "Marcos Ribeiro" e "Dr. Ricardo Alves" resolverem a mesma ressalva ao mesmo tempo
    Then exatamente uma chamada deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "LEGAL_RESERVATION_NOT_OPEN"
    And deve existir um único evento "LegalReservationResolved" para a ressalva
    When "Dr. André Nunes" e "Dra. Helena Prado" salvarem a mesma seção com a mesma revisão
    Then uma chamada deve responder 200 e a outra 409 com código "SECTION_REVISION_CONFLICT"
    Given que "Dr. André Nunes" pede diligência enquanto "Dra. Helena Prado" finaliza o parecer
    Then exatamente uma das operações deve prevalecer e a outra deve responder com o estado atualizado, sem parecer finalizado numa análise em diligência

  Scenario: [Falha de banco] Falha ao abrir o parecer ou registrar a ressalva
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/opinion"
    When "Dr. André Nunes" tentar abrir o parecer
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And não deve existir documento órfão nem "opinionDocumentId" preenchido
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/reservations"
    When "Dr. André Nunes" registrar uma ressalva
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma ressalva, auditoria ou número de sequência deve ter sido consumido

  Scenario: [Falha de integração] Redis e geração de prévia indisponíveis
    Given que o Redis está indisponível
    When "Dr. André Nunes" registrar uma ressalva
    Then a API deve responder 201 e concluir sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
    Given que o serviço de geração de PDF está indisponível
    When "Dr. André Nunes" pedir a prévia do parecer em rascunho
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e o editor deve continuar disponível
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega o painel |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Esta ressalva foi alterada por outra pessoa. Atualize a página." | Recarrega e reexibe o diálogo |
| Análise de outro tenant, inexistente ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Ressalva inexistente ou de outro tenant | 404 | `LEGAL_RESERVATION_NOT_FOUND` | "Ressalva não encontrada." | Recarrega a lista |
| Análise fora de `IN_REVIEW` | 409 | `LEGAL_REVIEW_INVALID_STATE` | "A análise não está em andamento." | Parecer em leitura; ações ocultas |
| Ressalva duplicada | 409 | `LEGAL_RESERVATION_DUPLICATE` | "Já existe uma ressalva com a mesma descrição para este documento." | Destaca a ressalva existente |
| Ressalva já resolvida | 409 | `LEGAL_RESERVATION_NOT_OPEN` | "Esta ressalva já foi resolvida." | Recarrega a lista |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você participou da elaboração deste processo e não pode realizar esta ação." | Oculta a ação e explica na dica |
| Não é o designado | 403 | `NOT_LEGAL_REVIEW_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Editor em leitura |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta "Marcar como atendida" |
| Não é o aprovador designado | 403 | `NOT_DESIGNATED_APPROVER` | "Apenas o aprovador designado pode aceitar o risco." | Oculta "Aceitar risco" |
| Rascunho restrito | 403 | `DOCUMENT_DRAFT_RESTRICTED` | "O parecer está em elaboração e só pode ser lido por quem conduz a análise." | Mostra título e situação |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para elaborar o parecer." | Oculta a ação |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Este tipo de documento não é permitido na etapa atual." | Mantém o painel |
| Texto com valor sigiloso | 422 | `LEGAL_TEXT_CONFIDENTIAL` | "O texto não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | Destaca o campo |
| Parecer incompleto ou com avisos | 422 | `DOCUMENT_INCOMPLETE` / `WARNINGS_NOT_ACKNOWLEDGED` | "Complete as seções obrigatórias." / "Reconheça os avisos para continuar." | Lista as pendências |
| Dados inválidos | 422 | `VALIDATION_ERROR` | Mensagem do campo | Marca o campo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou geração de PDF indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-065 (ciclo de vida do documento: DOC-08, DOC-10, DOC-12, validador tipado e `typedSummary`); US-110 (biblioteca de templates padrão, onde o MVP 2 semeia o modelo `PARECER_JURIDICO`); US-152 (análise `IN_REVIEW`, snapshot de onde vêm os tipos de documento afetado e o aviso de versão desatualizada). Indiretas: US-063 (DOC-05 e autosave de seção), US-122 (revisão de seções de IA), US-066 (versões), US-153 (diligência), US-155 (conclusão: consome `opinionDocumentId`, `FINALIZED` e as ressalvas), US-157 (rascunho por IA), US-052 (decisão de aprovação e linha `PENDING`), EP-027 (autorização que aceita o risco em bloco), US-130 (`documentTypeCodes` de `JURIDICO`).
- **Decisões/ADRs:** DEC-018, DEC-024, DEC-030, DEC-196, DEC-199, DEC-202; POL-02, POL-03, POL-09, POL-11, POL-18, POL-19, POL-23, POL-24; RN-LGL-09, RN-LGL-10, RN-LGL-11, RN-LGL-15, RN-LGL-17, RN-LGL-18, RN-LGL-19.
- **Configurações:** nenhuma chave nova; o modelo do parecer é um template do tenant (`PARECER_JURIDICO`, TPL-*).
- **Lacunas nas fontes canônicas:**
  1. **`DOCUMENT_REOPEN` para o perfil `JURIDICO`:** a permissão é do MVP 1 (risco `H`) e `permissions.md` do MVP 2 não a concede ao perfil; sem ela, o procurador não reabre o parecer finalizado (FA-05). **Dúvida de produto:** conceder ao `JURIDICO` ou criar permissão própria.
  2. **Códigos de erro novos:** `LEGAL_RESERVATION_NOT_FOUND` (404), `LEGAL_RESERVATION_DUPLICATE` (409) e `LEGAL_RESERVATION_NOT_OPEN` (409), além de `LEGAL_TEXT_CONFIDENTIAL` (definido na US-153), não constam em `permissions.md` nem em `events.md`; a consolidar no `api.md`.
  3. **Ações de auditoria:** `legal_review.reservation_update` (edição de ressalva) e uma ação para o vínculo `opinionDocumentId` não constam em `events.md` §7 (só `reservation_create` e `reservation_resolve`); a abertura usa `document.create` com `metadata.legalReviewId`. A consolidar.
  4. **Editor do parecer sem ID de tela:** o inventário de telas do MVP 2 não traz `SCR-` para o editor de `PARECER_JURIDICO` (tipo estruturado, rota genérica `/processos/[id]/documentos/[docId]`); a consolidar em `screens.md`.
  5. **Sem exclusão nem cancelamento de ressalva registrada por engano:** `LegalReservationStatus` só tem `OPEN`, `ADDRESSED` e `RISK_ACCEPTED`, e uma ressalva `OPEN` bloqueia a conclusão como `FAVORABLE` (US-155). **Dúvida de produto:** aceitar `DELETE` antes da conclusão (ou estado `WITHDRAWN`)? Hoje o procurador só edita o texto.
  6. **Quem atende a ressalva:** a story adota custódia do processo com `PROCESS_VIEW`, ou `LEGAL_REVIEW_MANAGE`; as fontes dizem só que Planejamento e Compras "atendem ressalvas". **Dúvida de produto:** permissão específica? A ressalva atendida precisa de conferência do procurador?
  7. **Leitura do rascunho por quem tem conflito de POL-19:** POL-24 diz "`LEGAL_REVIEW_MANAGE` cobrindo o processo"; a story estende a exclusão aos segregados (ex.: autor do TR com perfil `JURIDICO`) para não frustrar a restrição. **Dúvida de produto.**
  8. **Formato aditivo de DOC-03 para rascunho restrito** (resposta só com cabeçalho e `contentRestricted`), de `typedSummary` do parecer, de LGL-02 (`opinion`, `reservationsCount`, `openCount`) e dos corpos de LGL-16/17/18/20 não está no catálogo de API do MVP 2.
  9. **Chaves de seção do modelo:** apenas `CONCLUSION` é citada (DEC-202/§7.11); as demais (relatório, fundamentação, análise dos artefatos, ressalvas) devem ser fixadas no seed do template. A US-155 menciona "LGL-22" como origem de `opinionDocumentId`; neste conjunto o vínculo é feito por LGL-20 (a corrigir na US-155).
  10. **Feature FT-074 cita US-110 como "comentários":** a US-110 é a biblioteca de templates padrão; a dependência foi lida assim. Comentários no documento seguem os endpoints CMT do MVP 1 com a restrição de POL-24.

## Impacto técnico
- **Validador do tipo:** `LegalOpinionDocumentValidator` entra no mecanismo de `DocumentValidator` por `systemModule` (RN-DOC-51/52 do MVP 1); a chamada ao módulo `legal-review` é por fachada, sem consulta direta a tabelas.
- **Política de leitura:** `DocumentAccessPolicy` ganha o ramo `LEGAL_OPINION` (e `INTERNAL_CONTROL_REPORT`, compartilhado com a US-160) para status não final; os endpoints de leitura de conteúdo, versão, comparação, prévia, renderização e comentários consultam a política antes de abrir a rendição (nenhum PDF de rascunho em cache compartilhado).
- **Atomicidade:** LGL-20 e LGL-17 travam a análise (`SELECT … FOR UPDATE`) antes de numerar o documento e a ressalva; a numeração do documento usa a sequência do MVP 1 e pode deixar lacuna se a transação for desfeita (aceito, como no MVP 1).
- **Imutabilidade:** trigger rejeita `UPDATE` de `description` e `document_type_code` de ressalva fora de `OPEN`, e `DELETE` em qualquer caso; `response` e `status` só mudam de `OPEN` para um terminal; o check `status = 'OPEN' OR (response IS NOT NULL AND responded_at IS NOT NULL)` já existe.
- **Desempenho:** metas p95 de LGL-20 < 800 ms, LGL-17/LGL-18 < 400 ms e LGL-16 < 300 ms, escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda além dos campos aditivos citados; DOC-05, DOC-08, DOC-10 e DOC-12 são reutilizados.
- **Sigilo:** descrição, resposta e parecer ficam só em `legal_review_reservations` e no documento; eventos e logs carregam ids, contagens e tamanhos (DEC-030).

## Backend
- **Módulo(s):** `legal-review` (dono das ressalvas e do vínculo), `document` (tipo `PARECER_JURIDICO`, ciclo de vida e política de leitura), `process` (custódia e etapa), `approval` (consulta da linha `PENDING` para o aceite do risco), `timeline`, `audit`, `access`.
- **Casos de uso:** `OpenLegalOpinionCommand` (LGL-20), `ListLegalReservationsQuery` (LGL-16), `CreateLegalReservationCommand` (LGL-17), `UpdateLegalReservationCommand` (LGL-18, edição), `ResolveLegalReservationCommand` (LGL-18, `ADDRESSED`/`RISK_ACCEPTED`); painel via `GetLegalReviewQuery` (LGL-02).
- **Domínio:** `LegalReview.linkOpinion()`, `LegalReviewReservation` (`create`, `edit`, `address`, `acceptRisk`), `LegalReservationService.acceptRisk` (compartilhado com a decisão de autorização), `LegalReviewSegregationPolicy` (POL-19), `LegalOpinionDocumentValidator`, `ConfidentialTextGuard` (US-153).
- **Integrações internas:** `DocumentFacade.createFromTemplate`/`getValidation`, `ApprovalFacade.getPendingLineFor`, `ProcessFacade.getStageAndCustody`, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** LGL-20 (documento, vínculo, versão da análise, evento), LGL-17/LGL-18 (ressalva, auditoria, outbox e timeline) em transação única; falha em qualquer passo desfaz tudo.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`, painel com "Elaborar parecer", lista de ressalvas e painel lateral do editor), editor do parecer (`/processos/[id]/documentos/[docId]`, tipo estruturado do MVP 1), SCR-006 (bloco "Ressalvas do parecer" na aba Resumo, para quem atende), SCR-015 (parecer e ressalvas na decisão da autorização), SCR-106 (versões do parecer finalizado).
- **Componentes:** `OpenOpinionButton`, `LegalOpinionEditorSidebar` (versões analisadas e ressalvas), `ReservationList`, `ReservationFormDialog`, `ResolveReservationDialog` (atender ou aceitar o risco, com contador mínimo), `ReservationStatusBadge`, `OpinionRestrictedNotice` (rascunho restrito), `OpinionValidationPanel` (bloqueios e avisos, reaproveita o de DOC-08).
- **Estados:** skeleton; vazio ("Nenhuma ressalva registrada"); erro com "Tentar novamente"; rascunho restrito (título e situação, sem conteúdo); somente leitura quando a análise não está `IN_REVIEW`; sucesso com toast e foco na ressalva criada.
- **Acessibilidade e responsividade:** situação da ressalva nunca só por cor (texto e ícone); lista com cabeçalhos associados e ordem de leitura por `sequence`; diálogos com foco preso e retorno do foco; abaixo de 768 px o painel lateral do editor vira aba; contraste AA; contadores de caracteres anunciados de forma educada.

## Banco de dados
- **Tabelas:** `legal_review_reservations` (inserção e `UPDATE` restrito), `legal_reviews` (`opinion_document_id`, `version`), `documents`/`document_versions` (pelo ciclo de vida do MVP 1); leitura de `legal_review_documents`, `approvals`, `approval_approvers`, `process_stages`.
- **Migrações:** nenhuma nova (M2-15 já cria as tabelas); o trigger de imutabilidade de `legal_review_reservations` e a FK composta `opinion_document_id` com tenant entram em M2-15 (a confirmar com o card de migração).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, legal_review_id, sequence)`; check `status = 'OPEN' OR (response IS NOT NULL AND responded_at IS NOT NULL)`; índice `(tenant_id, legal_review_id, status)` para o contador `openCount`; checks de comprimento de `description` (10..5.000); unicidade de documento ativo por `opinion_document_id` garantida pela aplicação sob lock.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-20` | POST | `/api/v1/legal-reviews/{id}/opinion` | `{ title? }` + `If-Match` + `Idempotency-Key` | `201`/`200 { data: Document, meta: { review: LegalReview } }` + `ETag` | 200, 201, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-16` | GET | `/api/v1/legal-reviews/{id}/reservations` | `status?` | `200 { data: [ { id, sequence, description, documentTypeCode?, status, response?, respondedById?, respondedAt?, version } ], meta: { reservationsCount, openCount } }` | 200, 401, 403, 404, 429, 503 |
| `LGL-17` | POST | `/api/v1/legal-reviews/{id}/reservations` | `{ description, documentTypeCode? }` + `If-Match` + `Idempotency-Key` | `201 { data: LegalReviewReservation }` + `ETag` | 201, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-18` | PATCH | `/api/v1/legal-review-reservations/{reservationId}` | `{ description?, documentTypeCode? }` **ou** `{ status, response }` + `If-Match` | `200 { data: LegalReviewReservation }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel; ganha `opinion`, `reservationsCount`, `openCount` | 200, 401, 403, 404 |
| `DOC-05` | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | MVP 1 | seção salva (POL-02 + POL-19 + POL-24 para o parecer) | 200, 403, 404, 409, 412 |
| `DOC-08` | GET | `/api/v1/documents/{id}/validation` | MVP 1 | `violations[]` com as regras do `LegalOpinionDocumentValidator` | 200, 403, 404 |
| `DOC-10` | POST | `/api/v1/documents/{id}/finalize` | MVP 1 + `acknowledgedWarnings` | `200`; `DocumentFinalized` com `typedSummary` | 200, 403, 404, 409, 412, 422 |
| `DOC-12` | POST | `/api/v1/documents/{id}/reopen` | MVP 1 (`reopenReason`) | parecer volta a `DRAFT` (só com a análise `IN_REVIEW`) | 200, 403, 404, 409, 412, 422 |

## Logs
- `info` `legal_review.opinion_opened` — `legalReviewId`, `documentId`, `created` (booleano), `durationMs`, `correlationId`.
- `info` `legal_review.reservation_created` — `legalReviewId`, `reservationId`, `sequence`, `descriptionLength`; `info` `legal_review.reservation_resolved` — `reservationId`, `status`, `responseLength`, `byRole` (`CUSTODIAN`, `PROCURADOR` ou `AUTHORITY`).
- `warn` `legal_review.opinion_denied` e `legal_review.reservation_denied` — `reasonCode`, `legalReviewId`; `warn` `document.draft_restricted` — `documentId`, `reasonCode`; `warn` `idempotency.store_unavailable`.
- `error` `legal_review.opinion_failed` e `legal_review.reservation_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** texto do parecer, descrição ou resposta de ressalva, títulos de documentos, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit de LGL-20 (parecer novo) | `metadata`: `documentId`, `documentTypeCode` `PARECER_JURIDICO`, `legalReviewId`, `templateVersionId` |
| `document.finalize` | `WORKFLOW` | Commit de DOC-10 sobre o parecer | `changes.status`: `DRAFT` para `FINALIZED`; `metadata`: `versionNumber`, `contentHash`, `acknowledgedWarnings[]` |
| `legal_review.reservation_create` | `DATA_CHANGE` | Commit de LGL-17 | `metadata`: `reservationId`, `sequence`, `documentTypeCode?`, `descriptionLength`, `descriptionHash` (sem o texto) |
| `legal_review.reservation_update` | `DATA_CHANGE` | Commit de LGL-18 (edição) | `metadata`: `reservationId`, campos alterados, tamanhos e hashes |
| `legal_review.reservation_resolve` | `DATA_CHANGE` | Commit de LGL-18 (`ADDRESSED`/`RISK_ACCEPTED`) | `changes.status`: `OPEN` para o novo valor; `metadata`: `reservationId`, `responseLength`, `responseHash`, `byRole` |
| `access.denied` | `ACCESS` | 403 em LGL-16, 17, 18 ou 20, ou `DOCUMENT_DRAFT_RESTRICTED` | `reasonCode`, `legalReviewId` ou `documentId` |

## Testes necessários
- **Unitários:** `LegalOpinionDocumentValidator` (bloqueios e os três avisos); normalização e duplicidade de descrição; transições da ressalva (`OPEN` para `ADDRESSED`/`RISK_ACCEPTED`, terminalidade); POL-19, designação, custódia e aprovador `PENDING`; `ConfidentialTextGuard`; política de leitura do rascunho (autorizados, segregados, auditor, requisitante).
- **Integração (Testcontainers):** abertura do parecer atômica (documento, vínculo, evento) e idempotente; numeração `PJ`; sequência de ressalvas sem lacuna sob concorrência; finalização com `typedSummary`; rollback total em falha; trigger de imutabilidade das ressalvas; leitura de conteúdo restrito nos endpoints DOC-03, DOC-15, DOC-17, DOC-18, DOC-20 a DOC-23 e nos comentários.
- **API/contrato:** LGL-16/17/18/20 (códigos, ETag, `Idempotent-Replayed`); campos aditivos de LGL-02; DOC-05/08/10/12 inalterados no contrato.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-16/17/18/20 e a leitura de rascunho entre tenants; matriz de autorização (gerada) com `LEGAL_REVIEW_MANAGE`/`VIEW`/`PROCESS_VIEW`; bateria de POL-24 (leitor, auditor, requisitante, segregado) e de POL-23 (aceite de risco por aprovador e por não aprovador).
- **Concorrência:** ressalvas simultâneas (sequência), resolução simultânea, salvar a mesma seção, finalizar x pedir diligência.
- **E2E (Playwright):** abrir o parecer, redigir, registrar ressalvas, validar, finalizar, atender uma ressalva e aceitar o risco na decisão da autorização.
- **Acessibilidade/performance:** axe em painel, editor lateral e diálogos; 360 px; metas de p95 na suíte de performance.

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
- [ ] Rascunho do parecer comprovadamente ilegível para quem não conduz a análise, em todos os endpoints de leitura de conteúdo
- [ ] Sequência das ressalvas sem lacuna nem duplicidade sob concorrência
- [ ] Texto do parecer e das ressalvas comprovadamente ausente de eventos, logs, auditoria e notificações
- [ ] Gherkin das 8 categorias automatizado, incluindo POL-19, POL-24 e o aceite de risco

## Estimativa
**M** — uma abertura de documento tipado, três operações sobre ressalvas, um validador de tipo e a política de leitura do rascunho; reaproveita o ciclo de vida e o editor do MVP 1, e o esforço está na restrição de POL-24 em todos os pontos de leitura e na coerência entre texto do parecer e ressalvas rastreáveis.

## Prioridade
**P0** — sem o parecer e as ressalvas não há o que concluir (US-155) nem o que a autoridade reconheça na autorização; a segurança do rascunho (POL-24) é requisito do épico.
