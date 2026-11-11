---
id: US-156
title: "Dispensar a análise jurídica por hipótese configurada"
epic: EP-025
feature: FT-074
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-149, US-151]
modules: [legal-review, process, workflow, rules, catalog, timeline, notification, audit, access]
screens: [SCR-019, SCR-006]
endpoints: [LGL-21, LGL-02]
permissions: [LEGAL_REVIEW_WAIVE, LEGAL_REVIEW_VIEW, PROCESS_VIEW]
events: [LegalReviewWaived]
---

# US-156 — Dispensar a análise jurídica por hipótese configurada

## Título
Dispensar a análise jurídica por hipótese configurada pelo órgão (art. 53, § 5º)

## Descrição
**Como** procurador (ou titular/substituto da unidade jurídica) com permissão de dispensar, **quero** registrar que um processo na fila do Jurídico dispensa o parecer por uma hipótese que o órgão configurou, informando a justificativa, **para** que a regra de saída da etapa `JURIDICO` seja satisfeita sem parecer, com a hipótese, o ato que a ampara e a justificativa registrados de forma auditável, sem que a dispensa vire atalho.

A story entrega o ato de **dispensar** (`PENDING` para `WAIVED`): a avaliação da hipótese contra o processo (condição e teto de valor), as travas da etapa legalmente obrigatória e da segregação, o registro imutável, a satisfação da regra de saída e as consultas no painel (opções de dispensa e o registro da dispensa). Criar, editar e ativar hipóteses é da US-151 (catálogo `LEGAL_WAIVER_HYPOTHESIS`, SCR-120); a abertura da análise e a fila são da US-149; iniciar a análise é da US-152; concluir com parecer é da US-155.

## Contexto
- O art. 53, § 5º, da Lei 14.133/2021 permite dispensar a análise jurídica nas hipóteses definidas em ato da autoridade jurídica máxima do órgão. A DEC-199 trata isso como **hipóteses configuradas por tenant** (catálogo `LEGAL_WAIVER_HYPOTHESIS`, com base legal, referência do ato, condição opcional e teto de valor opcional); a dispensa é registrada como `LegalReview` `WAIVED`, com hipótese e justificativa, e satisfaz a regra de saída de `JURIDICO`.
- POL-26: a dispensa exige `LEGAL_REVIEW_WAIVE`, POL-19, hipótese ativa cuja condição (`RuleRef`) seja verdadeira para o processo, a análise em `PENDING` e justificativa de pelo menos 20 caracteres; em etapa marcada `isLegallyRequired` a dispensa só vale se a hipótese a prevê (`LEGAL_WAIVER_NOT_APPLICABLE`, 422). No workflow padrão v2 a etapa `JURIDICO` é semeada `isLegallyRequired = true` (DEC-196), de modo que a hipótese precisa **prever** expressamente esse caso.
- `PENDING` é o único estado em que a dispensa cabe: quem já iniciou a análise (e gravou o snapshot das versões — US-152) segue para o parecer. Por isso a dispensa nunca tem snapshot, parecer nem ressalvas.
- A dispensa é ato de **alto risco** (permissão `LEGAL_REVIEW_WAIVE`, risco `H`: MFA conforme a política do órgão, POL-14). Os riscos do épico são "dispensa usada como atalho" (mitigados por hipótese configurada, condição verificada no servidor, justificativa e auditoria) e "versão que muda durante a análise" (não se aplica aqui).
- O orçamento sigiloso (DEC-030/POL-09) nunca aparece em eventos, notificações, logs, mensagens de aplicabilidade ou justificativa: o teto de valor é comparado no servidor e só o resultado (aplicável ou não) é devolvido.
- A regra de saída padrão `legalReview.concluded = true` é verdadeira também em `WAIVED` (`entities.md` §6.4); o provedor `legalReview.*` é da US-155 e passa a devolver `waived = true`. Dispensar **nunca move o processo**: o responsável encaminha depois (US-041/US-047).
- Eventos e notificações já previstos: `LegalReviewWaived` (`legal_review.waived`, timeline `LEGAL_REVIEW_WAIVED` com "Análise jurídica dispensada ({hypothesisLabel})") e o tipo `LEGAL_REVIEW_CONCLUDED` (compartilhado com a conclusão, `events.md` §6).

## Objetivo
Garantir que 100% das dispensas sejam registradas por pessoa autorizada e segregada, por hipótese ativa cuja condição foi verificada no servidor no instante do ato, com justificativa e evidência da hipótese congeladas, e que a etapa `JURIDICO` fique liberada pela regra de saída em até 1 s após o commit, sem nenhuma dispensa possível fora de `PENDING`.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) com `LEGAL_REVIEW_WAIVE`, designado (`assigneeId`) ou titular/substituto da unidade jurídica da etapa.
- **Secundárias:** chefe da assessoria jurídica (acompanha a fila e as dispensas); Administrador do órgão com `LEGAL_REVIEW_CONFIGURE` (mantém as hipóteses, US-151); responsável da etapa seguinte, criador do processo e titular da secretaria solicitante (notificados); Auditor (`AUDITOR`) e Controle Interno (leem a dispensa e a evidência).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, sessão com MFA conforme `security.mfaPolicy` (`LEGAL_REVIEW_WAIVE` é risco `H`).
- `LegalReview` do tenant em `PENDING`, de processo `IN_PROGRESS` com a etapa `JURIDICO` ativa (`currentProcessStageId` não nulo) e visível ao usuário (DEC-024).
- Usuário com `LEGAL_REVIEW_WAIVE` cobrindo o processo, sem conflito de POL-19, e `assigneeId` da análise ou titular/substituto da unidade jurídica da etapa.
- Ao menos uma hipótese `LEGAL_WAIVER_HYPOTHESIS` ativa no tenant (caso contrário a ação aparece desabilitada com o motivo).

## Fluxo principal
1. O procurador abre a fila (SCR-019, `/juridico`) e entra no painel da análise `PENDING` (`/juridico/[reviewId]`, LGL-02), que mostra processo, objeto, prazo da etapa, fatores de prioridade e, para quem pode dispensar, a ação **"Dispensar análise"**.
2. O painel (LGL-02) devolve `canWaive` e `waiverOptions[]`: as hipóteses ativas com nome, base legal, referência do ato, e para cada uma `applicable` (avaliada no servidor contra o processo) e, quando `false`, um `reasonCode` sem números (por exemplo, "O processo não atende à condição da hipótese").
3. O diálogo `WaiveReviewDialog` lista as hipóteses; as inaplicáveis aparecem desabilitadas com o motivo. O procurador escolhe uma hipótese aplicável e escreve a **justificativa** (20 a 5.000 caracteres), vendo o aviso "A dispensa é definitiva e libera a etapa do Jurídico sem parecer."
4. O procurador confirma; o front envia LGL-21 com `{ hypothesisId, justification }`, `If-Match` (ETag da `LegalReview`) e `Idempotency-Key`. Se a política de MFA exigir, a API responde 403 `MFA_REQUIRED` e o front abre o desafio, repetindo a chamada ao validar.
5. A API valida na ordem: existência e tenant, permissão e MFA, POL-19 e designação, status `PENDING`, processo e etapa, existência e atividade da hipótese, dados da justificativa.
6. Na **mesma transação**, a API trava a `LegalReview` e o processo (`SELECT … FOR UPDATE`), reavalia a hipótese contra o processo (condição `RuleRef` e, se houver, `maxEstimatedValue` contra o valor estimado), confere a etapa `isLegallyRequired` e, aprovada, grava `status` `WAIVED`, `waiverHypothesisId`, `waiverJustification`, `waivedById`, `waivedAt`, incrementa o `version`, registra a auditoria `legal_review.waive` (com a evidência congelada da hipótese), a timeline `LEGAL_REVIEW_WAIVED` e o evento no outbox.
7. A API responde 200 com a `LegalReview` dispensada. O provedor `legalReview.*` passa a devolver `concluded = true` e `waived = true`; a regra de saída da etapa `JURIDICO` fica satisfeita e o responsável pode encaminhar o processo (US-041/US-047). A dispensa **não** move o processo.
8. Após o commit, o outbox gera a notificação `LEGAL_REVIEW_CONCLUDED` (criador do processo, responsável da etapa seguinte e titular da secretaria solicitante) com o resultado "dispensada".
9. O painel passa ao modo somente leitura com o selo "Dispensada", a hipótese (nome, base legal e ato), a justificativa, quem dispensou e quando; SCR-006 mostra a situação da análise e o link para o registro.

## Fluxos alternativos
- **FA-01 — Hipótese cuja condição é falsa:** a hipótese aparece desabilitada no diálogo; se o front for contornado, LGL-21 responde 422 `LEGAL_WAIVER_NOT_APPLICABLE` com `reasonCode` `CONDITION_NOT_MET` (RN-LGL-103).
- **FA-02 — Valor acima do teto da hipótese:** o processo tem valor estimado acima de `maxEstimatedValue`: 422 `LEGAL_WAIVER_NOT_APPLICABLE` com `reasonCode` `VALUE_ABOVE_LIMIT`; a mensagem não revela o valor nem o limite (RN-LGL-103, DEC-030).
- **FA-03 — Etapa legalmente obrigatória e hipótese que não a prevê:** 422 `LEGAL_WAIVER_NOT_APPLICABLE` com `reasonCode` `LEGALLY_REQUIRED_STAGE` (RN-LGL-104).
- **FA-04 — Hipótese sem nenhum critério objetivo:** hipótese sem condição e sem teto de valor não é aplicável a nenhum processo: `reasonCode` `NO_CRITERIA` (RN-LGL-102). **Dúvida de produto.**
- **FA-05 — Hipótese inexistente, inativa ou de outro tenant:** 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND` ou `REFERENCE_INACTIVE` em `hypothesisId`); a hipótese desativada depois da dispensa não altera o registro (RN-LGL-107).
- **FA-06 — Análise já iniciada, em diligência ou encerrada:** 409 `LEGAL_REVIEW_INVALID_STATE`; o botão "Dispensar análise" some depois do início (RN-LGL-101).
- **FA-07 — Análise sem designação, dispensada pelo titular:** o titular ou substituto da unidade jurídica dispensa uma análise `PENDING` sem `assigneeId`; a dispensa **não** designa ninguém (RN-LGL-100).
- **FA-08 — Nenhuma hipótese ativa:** o botão fica desabilitado com "Nenhuma hipótese de dispensa está ativa. Peça ao administrador para configurá-las." (SCR-120, US-151).
- **FA-09 — Processo suspenso, cancelado ou fora de `JURIDICO`:** 409 `INVALID_PROCESS_STATUS`; o painel mostra o botão desabilitado com o motivo (RN-LGL-101).
- **FA-10 — Justificativa com valor de orçamento sigiloso:** com orçamento sigiloso no processo, justificativa com padrão de valor monetário é recusada com 422 `LEGAL_TEXT_CONFIDENTIAL` (RN-LGL-105).
- **FA-11 — Serviço de regras indisponível na avaliação:** a avaliação da condição falha de forma fechada: 503 `DEPENDENCY_UNAVAILABLE` sem gravar nada; o diálogo mostra "Tentar novamente" (RN-LGL-103).
- **FA-12 — Dispensa feita por engano:** a dispensa é definitiva e não há "desfazer"; se o Jurídico precisar analisar, o processo é devolvido e, ao voltar a `JURIDICO`, uma nova análise nasce (DEC-196, US-149) (RN-LGL-107). **Dúvida de produto.**

## Regras de negócio
- **RN-LGL-10** — Segregação: quem elaborou o processo ou seus documentos não analisa nem dispensa; a dispensa exige `LEGAL_REVIEW_WAIVE` cobrindo o processo (POL-19, POL-26). *(regra da feature, adotada)*
- **RN-LGL-11** — Há seis situações do produto, mais `WAIVED` e `CANCELED`; `WAIVED` é final e a análise dispensada é imutável; a única transição desta story é `PENDING` para `WAIVED` (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-20** — A dispensa exige `LEGAL_REVIEW_WAIVE`, análise em `PENDING`, hipótese ativa cuja condição seja verdadeira para o processo e justificativa de pelo menos 20 caracteres; em etapa `isLegallyRequired` só vale se a hipótese a prevê (`LEGAL_WAIVER_NOT_APPLICABLE`) (POL-26, DEC-199). *(regra da feature, adotada)*
- **RN-LGL-100** *(nova)* — Quem dispensa: `LEGAL_REVIEW_WAIVE` cobrindo o processo, sem conflito de POL-19 (`LEGAL_REVIEW_SEGREGATION`) e sendo o `assigneeId` da análise **ou** o titular/substituto da unidade jurídica da etapa (`NOT_LEGAL_REVIEW_ASSIGNEE`); sem a permissão, `PERMISSION_DENIED`; MFA conforme `security.mfaPolicy` (risco `H`, `MFA_REQUIRED`). A dispensa não altera `assigneeId`, `assignedAt` nem `assignedById`.
- **RN-LGL-101** *(nova)* — Estado e momento: só a análise `PENDING` pode ser dispensada, de processo `IN_PROGRESS` com a etapa `JURIDICO` ativa; `IN_REVIEW`, `DILIGENCE`, conclusivas, `WAIVED` e `CANCELED` respondem 409 `LEGAL_REVIEW_INVALID_STATE`; processo fora de `IN_PROGRESS` ou sem a etapa, 409 `INVALID_PROCESS_STATUS`. Não há expiração do direito de dispensar enquanto a análise estiver `PENDING`.
- **RN-LGL-102** *(nova)* — Elegibilidade da hipótese: `CatalogItem` do tenant, do tipo `LEGAL_WAIVER_HYPOTHESIS`, `isActive = true`; hipótese que não tenha `condition` **nem** `maxEstimatedValue` no `metadata` não é aplicável a nenhum processo (`reasonCode` `NO_CRITERIA`), para impedir dispensa universal. A hipótese inativa ou inexistente é erro de referência (`VALIDATION_ERROR`).
- **RN-LGL-103** *(nova)* — Avaliação no servidor, dentro da transação e com o processo travado: (a) a `condition` (`RuleRef`) é avaliada pelo executor JSON Logic do `rules`/`workflow` (ADR-008) com o `RuleContext` na versão fixada pela própria regra; precisa resultar `true`; (b) se houver `maxEstimatedValue`, o valor estimado do processo (DEC-032) deve ser menor ou igual a ele. A **falha ou o tempo esgotado** (2 s) do executor ou de um provedor de namespace é falha fechada: 503 `DEPENDENCY_UNAVAILABLE`, sem gravação. A resposta de inaplicabilidade traz só `reasonCode` (`CONDITION_NOT_MET`, `VALUE_ABOVE_LIMIT`, `LEGALLY_REQUIRED_STAGE`, `NO_CRITERIA`), nunca valores. O resultado exibido no painel (`applicable`) é informativo; vale o recálculo do ato.
- **RN-LGL-104** *(nova)* — Etapa legalmente obrigatória: quando `WorkflowStage.isLegallyRequired` da passagem de `JURIDICO` do processo é `true`, a hipótese só é aplicável se o seu `metadata` previr isso (`appliesToLegallyRequiredStage = true`, lacuna 1); do contrário `LEGAL_WAIVER_NOT_APPLICABLE` com `LEGALLY_REQUIRED_STAGE`. Etapa não marcada não impõe essa trava.
- **RN-LGL-105** *(nova)* — Justificativa: `justification` de 20 a 5.000 caracteres, texto puro (sem HTML), gravada aparada nas pontas; com orçamento sigiloso no processo não pode conter valor monetário (`LEGAL_TEXT_CONFIDENTIAL`, regra da US-153, RN-LGL-56). A justificativa nunca entra em evento, notificação, log ou auditoria (só tamanho e hash).
- **RN-LGL-106** *(nova)* — Efeitos atômicos: `status` `WAIVED`, `waiverHypothesisId`, `waiverJustification`, `waivedById`, `waivedAt`, `version`, auditoria, timeline e outbox saem no mesmo commit; falha em qualquer passo desfaz tudo. A dispensa não grava `LegalReviewDocument`, não cria parecer nem ressalva, não move o processo e não altera `currentProcessStageId`; satisfaz a regra de saída `legalReview.concluded` (o provedor devolve `waived = true`). Check de banco: `status <> 'WAIVED' OR (waiver_hypothesis_id IS NOT NULL AND waiver_justification IS NOT NULL)`.
- **RN-LGL-107** *(nova)* — Imutabilidade: `WAIVED` é final; um *trigger* rejeita `UPDATE` em `legal_reviews` com `status = 'WAIVED'` (exceto campos técnicos em migração controlada). Não existe reverter a dispensa; uma nova análise só nasce se o processo voltar a `JURIDICO` depois dela (DEC-196, US-149). Desativar ou editar a hipótese depois não altera a dispensa registrada.
- **RN-LGL-108** *(nova)* — Evidência e leitura: a auditoria congela, no instante do ato, `hypothesisId`, `hypothesisCode`, nome, `legalBasis`, `actReference`, o resultado da condição e a verificação do teto (booleanos, sem valores) e se a etapa era `isLegallyRequired`; o evento leva só `waiverHypothesisCode` e a timeline o rótulo da hipótese. Quem tem `PROCESS_VIEW` ou `LEGAL_REVIEW_VIEW` cobrindo o processo lê a dispensa (hipótese, justificativa, responsável e data) no painel e em SCR-006 (DEC-024); `canWaive` e `waiverOptions[]` só são devolvidos a quem pode dispensar.
- **RN-LGL-109** *(nova)* — Concorrência e idempotência: `If-Match` (ETag da análise) e `Idempotency-Key` obrigatórios; dispensar e iniciar ao mesmo tempo resultam em exatamente uma vitória (a outra, 412 `VERSION_CONFLICT` ou 409 `LEGAL_REVIEW_INVALID_STATE`); duas dispensas simultâneas resultam em uma 200; reenvio com a mesma chave devolve a resposta original com `Idempotent-Replayed: true`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Análise | `id` (path) | uuid | Sim | `LegalReview` do tenant | rota |
| Hipótese de dispensa | `hypothesisId` | uuid (`CatalogItem`) | Sim | `LEGAL_WAIVER_HYPOTHESIS` ativa e aplicável; RN-LGL-102/103/104 | `waiverOptions[]` |
| Justificativa | `justification` | texto longo (20..5.000) | Sim | texto puro; RN-LGL-105 | em branco |
| Versão da análise | `If-Match` (ETag) | texto | Sim | ETag da `LegalReview` | `GET` LGL-02 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| *(saída)* Situação | `status` | `LegalReviewStatus` | — | `WAIVED` | derivado |
| *(saída)* Registro da dispensa | `waiverHypothesisId`, `waiverJustification`, `waivedById`, `waivedAt` | uuid / texto / uuid / datetime | — | RN-LGL-106 | `LegalReview` |
| *(saída, LGL-02)* Ação | `canWaive` | booleano | — | RN-LGL-100/101 | derivado |
| *(saída, LGL-02)* Opções | `waiverOptions[]` (`id`, `code`, `name`, `legalBasis`, `actReference`, `applicable`, `reasonCode?`) | lista | — | RN-LGL-103; sem valores | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `hypothesisId` ausente ou malformado | Front + API (Zod) | "Escolha a hipótese de dispensa." | `VALIDATION_ERROR` |
| V-02 | `justification` com menos de 20 ou mais de 5.000 caracteres | Front + API (Zod) | "A justificativa deve ter de 20 a 5.000 caracteres." | `VALIDATION_ERROR` |
| V-03 | Hipótese inexistente, de outro tenant ou inativa | API | "Esta hipótese não está disponível." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Hipótese não aplicável ao processo (condição, teto, etapa obrigatória, sem critério) | API | "Esta hipótese não se aplica a este processo." | `LEGAL_WAIVER_NOT_APPLICABLE` (422, `reasonCode`) |
| V-05 | Justificativa com valor monetário em processo de orçamento sigiloso | API | "A justificativa não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | `LEGAL_TEXT_CONFIDENTIAL` (422) |
| V-06 | `If-Match` ausente | API | "Atualize a página e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-07 | `If-Match` divergente da ETag da análise | API | "Esta análise foi alterada por outra pessoa. Atualize a página." | `VERSION_CONFLICT` (412) |
| V-08 | Análise não está `PENDING` | API | "Esta análise já foi iniciada ou encerrada e não pode ser dispensada." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-09 | Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | API | "O processo não está disponível para dispensa no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-10 | Usuário em conflito de segregação (POL-19) | API | "Você participou da elaboração deste processo e não pode dispensar a análise." | `LEGAL_REVIEW_SEGREGATION` (403) |
| V-11 | Usuário não é o designado nem titular/substituto | API | "Esta análise está designada a outra pessoa." | `NOT_LEGAL_REVIEW_ASSIGNEE` (403) |
| V-12 | MFA exigido e ausente na sessão | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` (403) |
| V-13 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_WAIVE` (risco `H`) com escopo que cubra o processo, para dispensar; `LEGAL_REVIEW_VIEW` para o painel e `waiverOptions[]`; `PROCESS_VIEW` para ler o registro da dispensa em SCR-006.
- **Políticas:** POL-26 (dispensa por hipótese), POL-19 (segregação e designação), POL-14 (MFA para ações `H`), DEC-024 (visibilidade), POL-09/DEC-030 (sigilo), POL-27 (etapa `isLegallyRequired` não aceita regra de dispensa por roteamento, o que reforça a trava de RN-LGL-104).
- **MFA:** exigido conforme `security.mfaPolicy` por ser permissão `H`; sem MFA válido, 403 `MFA_REQUIRED`.
- **Sem permissão:** a ação "Dispensar análise" fica oculta sem `LEGAL_REVIEW_WAIVE` e desabilitada com o motivo quando falha a segregação, a designação ou não há hipótese ativa; a API responde 403 `PERMISSION_DENIED`, `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE` ou `MFA_REQUIRED` e grava `access.denied`; análise de outro tenant ou de processo invisível responde 404 `LEGAL_REVIEW_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewWaived` | `legal_review.waived` | Commit de LGL-21 | `legalReviewId`, `waiverHypothesisCode`; sem justificativa nem valores; consumidores: T (`LEGAL_REVIEW_WAIVED`), N (`LEGAL_REVIEW_CONCLUDED`), R, NR e avaliação da regra de saída |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `LEGAL_REVIEW_CONCLUDED` | Criador do processo; responsável da etapa seguinte; titular da secretaria solicitante | In-app e e-mail (padrão ligado) | `LegalReviewWaived` (resultado "dispensada"; título e corpo com o código do processo e o rótulo da hipótese, nunca a justificativa nem valores) |

Regras gerais do MVP 1 valem: nunca notificar o próprio ator, agrupamento de 5 minutos, máx. 50 destinatários por unidade ou perfil.

## Critérios de aceite em Gherkin
```gherkin
Feature: Dispensar a análise jurídica por hipótese configurada

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0052/2026" está "IN_PROGRESS" na etapa "JURIDICO", marcada como "isLegallyRequired"
    And a análise "LR-0052" do processo está "PENDING" na rodada 1, designada a "Dr. André Nunes"
    And "Dr. André Nunes" tem vínculo ativo, o perfil "JURIDICO" com "LEGAL_REVIEW_WAIVE" cobrindo o processo e não participou da elaboração
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e é autora do TR
    And existe a hipótese ativa "Compras com minutas padronizadas", com condição verdadeira para o processo e prevista para etapa legalmente obrigatória, base legal "Art. 53, § 5º" e ato "Portaria PGM 12/2026"
    And existe a hipótese ativa "Baixo valor", com teto de valor abaixo do valor estimado do processo e sem previsão para etapa legalmente obrigatória
    And existe a hipótese inativa "Contratação emergencial"

  Scenario: [Sucesso] Dispensar a análise por hipótese aplicável
    When "Dr. André Nunes" dispensar a análise com a hipótese "Compras com minutas padronizadas", a justificativa de 80 caracteres e a chave "K1"
    Then a API deve responder 200 com a análise "WAIVED", "waivedById" "Dr. André Nunes" e "waivedAt" preenchido
    And o "assigneeId" deve continuar "Dr. André Nunes" e não deve existir "LegalReviewDocument" nem parecer
    And deve gerar a auditoria "legal_review.waive" com o código, o nome, a base legal e o ato da hipótese, sem a justificativa
    And deve gerar o evento "LegalReviewWaived" com o código da hipótese e sem a justificativa
    And a timeline do processo deve exibir "Análise jurídica dispensada (Compras com minutas padronizadas)"
    And a regra de saída da etapa "JURIDICO" deve estar satisfeita e o processo deve continuar na etapa "JURIDICO"
    And "Carla Mendes" e o titular da secretaria solicitante devem receber a notificação "LEGAL_REVIEW_CONCLUDED"

  Scenario: [Sucesso] Titular da unidade dispensa análise sem designação
    Given que a análise "LR-0052" não tem "assigneeId"
    And "Dra. Helena Prado" é titular da unidade jurídica da etapa e tem "LEGAL_REVIEW_WAIVE"
    When "Dra. Helena Prado" dispensar a análise com a hipótese aplicável
    Then a API deve responder 200 com a análise "WAIVED"
    And o "assigneeId" deve continuar nulo

  Scenario: [Sucesso] O painel mostra a aplicabilidade de cada hipótese
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}"
    Then a API deve responder 200 com "canWaive" verdadeiro
    And "waiverOptions" deve listar "Compras com minutas padronizadas" com "applicable" verdadeiro
    And deve listar "Baixo valor" com "applicable" falso e "reasonCode" "VALUE_ABOVE_LIMIT", sem nenhum valor numérico
    And não deve listar "Contratação emergencial"

  Scenario: [Sucesso] A dispensa registrada não muda quando a hipótese é desativada
    Given que a análise "LR-0052" foi dispensada pela hipótese "Compras com minutas padronizadas"
    When o administrador desativar essa hipótese
    Then a análise deve continuar "WAIVED" e o painel deve continuar mostrando a hipótese e a justificativa
    And a auditoria "legal_review.waive" deve manter o nome, a base legal e o ato do instante da dispensa

  Scenario: [Validação] Justificativa, hipótese e aplicabilidade inválidas
    When "Dr. André Nunes" dispensar a análise com justificativa de 10 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nada deve ser gravado
    When "Dr. André Nunes" dispensar a análise com a hipótese inativa "Contratação emergencial"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE" em "hypothesisId"
    When "Dr. André Nunes" dispensar a análise com a hipótese "Baixo valor"
    Then a API deve responder 422 com código "LEGAL_WAIVER_NOT_APPLICABLE" e "reasonCode" "VALUE_ABOVE_LIMIT"
    Given que a condição da hipótese "Compras com minutas padronizadas" passa a ser falsa para o processo
    When "Dr. André Nunes" dispensar a análise com essa hipótese
    Then a API deve responder 422 com código "LEGAL_WAIVER_NOT_APPLICABLE" e "reasonCode" "CONDITION_NOT_MET"
    Given que a hipótese "Compras com minutas padronizadas" deixa de prever a etapa legalmente obrigatória
    When "Dr. André Nunes" dispensar a análise com essa hipótese
    Then a API deve responder 422 com código "LEGAL_WAIVER_NOT_APPLICABLE" e "reasonCode" "LEGALLY_REQUIRED_STAGE"
    Given que existe uma hipótese ativa sem condição e sem teto de valor
    When "Dr. André Nunes" dispensar a análise com essa hipótese
    Then a API deve responder 422 com código "LEGAL_WAIVER_NOT_APPLICABLE" e "reasonCode" "NO_CRITERIA"
    And a análise deve continuar "PENDING"

  Scenario: [Validação] Sigilo e estado da análise
    Given que o orçamento do processo é sigiloso
    When "Dr. André Nunes" dispensar a análise com a justificativa "Valor estimado de R$ 80.000,00, padronizado"
    Then a API deve responder 422 com código "LEGAL_TEXT_CONFIDENTIAL"
    Given que a análise "LR-0050" está "IN_REVIEW"
    When "Dr. André Nunes" tentar dispensar "LR-0050"
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"
    Given que o processo "0053/2026" está "SUSPENDED"
    When "Dr. André Nunes" tentar dispensar a análise desse processo
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"

  Scenario: [Permissão] Segregação, outra designação, sem permissão e sem MFA
    Given que "Carla Mendes" também tem o perfil "JURIDICO" com "LEGAL_REVIEW_WAIVE"
    When "Carla Mendes" chamar "POST /legal-reviews/{id}/waive"
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION"
    And deve gerar registro de auditoria "access.denied"
    Given que "Dra. Lúcia Prado", procuradora sem relação com o processo, não é a designada nem titular
    When "Dra. Lúcia Prado" chamar "POST /legal-reviews/{id}/waive"
    Then a API deve responder 403 com código "NOT_LEGAL_REVIEW_ASSIGNEE"
    Given que "Bruno Lopes" tem "LEGAL_REVIEW_MANAGE" mas não tem "LEGAL_REVIEW_WAIVE"
    When "Bruno Lopes" chamar "POST /legal-reviews/{id}/waive"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "canWaive" deve ser falso para ele em "GET /legal-reviews/{id}"
    Given que a política de MFA do órgão exige segundo fator e a sessão de "Dr. André Nunes" não o validou
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id}/waive"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And a análise deve continuar "PENDING"

  Scenario: [Tenant incorreto] Análise e hipótese de outro órgão
    Given que a análise "LR-0007" pertence ao tenant "Prefeitura B"
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id-LR-0007}/waive"
    Then a API deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND"
    Given que a hipótese "Baixo valor B" pertence ao tenant "Prefeitura B"
    When "Dr. André Nunes" dispensar a análise "LR-0052" com o id da hipótese "Baixo valor B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "hypothesisId"
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio da dispensa e dispensa de análise já dispensada
    Given que "Dr. André Nunes" dispensou a análise com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único evento "LegalReviewWaived" e uma única auditoria "legal_review.waive"
    When "Dr. André Nunes" dispensar de novo com a chave "K2" e a ETag nova
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"

  Scenario: [Concorrência] Dispensa e início simultâneos, e duas dispensas simultâneas
    When "Dr. André Nunes" iniciar a análise e "Dra. Helena Prado" dispensá-la ao mesmo tempo com a mesma ETag
    Then exatamente uma chamada deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "LEGAL_REVIEW_INVALID_STATE"
    And a análise não deve ter, ao mesmo tempo, snapshot de versões e a situação "WAIVED"
    When "Dr. André Nunes" e "Dra. Helena Prado" dispensarem a análise ao mesmo tempo
    Then exatamente uma chamada deve responder 200 e deve existir um único evento "LegalReviewWaived"

  Scenario: [Falha de banco] Falha ao gravar a dispensa
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/waive"
    When "Dr. André Nunes" confirmar a dispensa
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "PENDING" sem hipótese, justificativa, auditoria, evento ou notificação gravados

  Scenario: [Falha de integração] Avaliação da regra indisponível e Redis indisponível
    Given que o executor de regras não responde em 2 segundos ao avaliar a condição da hipótese
    When "Dr. André Nunes" confirmar a dispensa
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e a análise deve continuar "PENDING"
    And deve ser registrado log "error" "legal_review.waive_evaluation_failed"
    Given que o Redis está indisponível
    When "Dr. André Nunes" dispensar a análise
    Then a API deve responder 200 e concluir a dispensa sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega o painel |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Esta análise foi alterada por outra pessoa. Atualize a página." | Recarrega e reexibe o diálogo |
| Análise inexistente, de outro tenant ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Análise fora de `PENDING` | 409 | `LEGAL_REVIEW_INVALID_STATE` | "Esta análise já foi iniciada ou encerrada e não pode ser dispensada." | Recarrega o painel; oculta a ação |
| Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para dispensa no momento." | Desabilita a ação com o motivo |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você participou da elaboração deste processo e não pode dispensar a análise." | Oculta a ação e explica na dica |
| Não é o designado | 403 | `NOT_LEGAL_REVIEW_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Oculta a ação |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para dispensar análises jurídicas." | Oculta a ação |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Abre o desafio de MFA e repete a chamada |
| Hipótese não aplicável | 422 | `LEGAL_WAIVER_NOT_APPLICABLE` | "Esta hipótese não se aplica a este processo." | Desabilita a hipótese com o motivo do `reasonCode` |
| Hipótese inexistente, de outro tenant ou inativa | 422 | `VALIDATION_ERROR` | "Esta hipótese não está disponível." | Recarrega as opções |
| Justificativa inválida | 422 | `VALIDATION_ERROR` | "A justificativa deve ter de 20 a 5.000 caracteres." | Marca o campo |
| Justificativa com valor sigiloso | 422 | `LEGAL_TEXT_CONFIDENTIAL` | "A justificativa não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | Destaca o campo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou avaliação de regras indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível dispensar a análise agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-149 (cria a `LegalReview` `PENDING`, expõe a fila e o painel LGL-02); US-151 (catálogo `LEGAL_WAIVER_HYPOTHESIS`, SCR-120, ativação e desativação das hipóteses). Indiretas: US-150 (designação), US-152 (iniciar — a dispensa e o início disputam o mesmo estado `PENDING`), US-155 (provedor `legalReview.*` com `waived` e regra de saída), US-129 (`RuleContext` v2 e executor usados na condição), US-130 (etapa `JURIDICO` com `isLegallyRequired`), US-041 e US-047 (encaminhamento depois da dispensa), US-193 (regras de notificação sobre `LegalReviewWaived`).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-032, DEC-196, DEC-199, DEC-204; ADR-008, ADR-015; POL-09, POL-14, POL-19, POL-26, POL-27; RN-LGL-10, RN-LGL-11, RN-LGL-20.
- **Configurações:** nenhuma chave nova; as hipóteses são `CatalogItem` do tenant (`LEGAL_WAIVER_HYPOTHESIS`, `entities.md` §7.10), mantidas na US-151.
- **Lacunas nas fontes canônicas:**
  1. **Como a hipótese "prevê" a etapa legalmente obrigatória:** POL-26 e RN-LGL-20 dizem que a dispensa em etapa `isLegallyRequired` "só vale se a hipótese a prevê", mas o schema de `metadata` de `LEGAL_WAIVER_HYPOTHESIS` (`entities.md` §7.10) não tem esse campo. A story adota `appliesToLegallyRequiredStage` (booleano, padrão `false`); incluir no schema e no formulário da US-151. **Dúvida de produto:** como `JURIDICO` é semeado `isLegallyRequired = true` e as hipóteses semeadas (`BAIXO_VALOR`, `MINUTA_PADRONIZADA`) nascem inativas, nenhuma dispensa funciona em licitação até a hipótese prever a etapa; confirmar com o jurídico do piloto o padrão semeado.
  2. **Hipótese sem critério objetivo:** o schema permite `condition` e `maxEstimatedValue` opcionais; sem os dois, a hipótese valeria para qualquer processo. A story a trata como inaplicável (`NO_CRITERIA`); a US-151 deve impedir ativá-la assim. **Dúvida de produto.**
  3. **Códigos de erro e motivos:** `LEGAL_WAIVER_NOT_APPLICABLE` consta em POL-26, mas não os `reasonCode` (`CONDITION_NOT_MET`, `VALUE_ABOVE_LIMIT`, `LEGALLY_REQUIRED_STAGE`, `NO_CRITERIA`); `LEGAL_REVIEW_NOT_FOUND`, `LEGAL_REVIEW_INVALID_STATE` e `LEGAL_TEXT_CONFIDENTIAL` seguem as lacunas das US-152 e US-153. A consolidar no `api.md` do MVP 2.
  4. **Campos aditivos de LGL-02** (`canWaive`, `waiverOptions[]`, registro da dispensa) e os corpos de LGL-21 não estão no catálogo de API do MVP 2.
  5. **Evidência da hipótese:** `LegalReview` guarda só `waiverHypothesisId`; nome, base legal e ato do instante da dispensa ficam na auditoria (RN-LGL-108). Se o catálogo permitir editar a hipótese depois, o painel mostraria o dado atual; avaliar uma coluna `waiverSnapshot` (jsonb) em M2-15. **Dúvida de produto.**
  6. **Limite da justificativa (5.000 caracteres):** `entities.md` só fixa o mínimo (20); o máximo segue o padrão das demais justificativas do módulo.
  7. **Desfazer a dispensa:** não há previsão nas fontes; a story não oferece reversão (RN-LGL-107). **Dúvida de produto.**
  8. **Notificação da dispensa** reutiliza `LEGAL_REVIEW_CONCLUDED` (como `events.md` §6); o texto do tipo deve prever o resultado "dispensada".
  9. **Tempo máximo (2 s) da avaliação da condição** segue o orçamento por namespace da US-129; confirmar para o executor de regras.

## Impacto técnico
- **Avaliação transacional:** a condição é avaliada dentro da transação, com o processo travado, para que a decisão valha para o estado visto pelo commit; o executor JSON Logic é o mesmo da saída de etapa (ADR-008) e roda com timeout de 2 s; o resultado do painel (`waiverOptions[]`) usa o mesmo avaliador em modo de leitura.
- **Ordem de lock:** `LegalReview` e depois `Process`, como nas US-152 e US-153, para evitar deadlock com a tramitação e com a US-152.
- **Imutabilidade:** trigger bloqueia `UPDATE` de `legal_reviews` em `WAIVED` e check de banco garante hipótese e justificativa; sem linhas em `legal_review_documents` para a análise.
- **Desempenho:** metas p95 de LGL-21 < 800 ms e do acréscimo de `waiverOptions[]` em LGL-02 < 150 ms (até 10 hipóteses ativas), escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda; o provedor `legalReview.*` da US-155 ganha `waived`.
- **Sigilo:** o teto de valor é comparado no servidor e nenhum valor sai em resposta, evento, log ou notificação (DEC-030).

## Backend
- **Módulo(s):** `legal-review` (dono), `process` (status e etapa), `workflow` (`isLegallyRequired`), `rules` (executor JSON Logic), `catalog` (hipóteses), `timeline`, `notification`, `audit`, `access`.
- **Casos de uso:** `WaiveLegalReviewCommand` (LGL-21); painel via `GetLegalReviewQuery` (LGL-02), que acrescenta `canWaive` e `waiverOptions[]` por meio de `ListApplicableWaiverHypothesesQuery`.
- **Domínio:** `LegalReview.waive()` (invariante `PENDING` para `WAIVED`), `WaiverHypothesisEvaluator` (condição, teto, etapa obrigatória, critério mínimo), `LegalReviewSegregationPolicy` (POL-19, compartilhada), `ConfidentialTextGuard` (US-153).
- **Integrações internas:** `CatalogFacade.getItem`, `RuleEngineFacade.evaluate`, `ProcessFacade.getStageAndStatus` e `getEstimatedValue`, `WorkflowFacade.isStageLegallyRequired`, `OrgUnitFacade.getTitularAndDeputy`, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** bloqueio da análise e do processo, avaliação da hipótese, gravação da dispensa, auditoria, outbox e timeline; falha em qualquer passo desfaz tudo.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`, ação "Dispensar análise" e leitura do registro da dispensa), SCR-006 (aba Resumo mostra a situação da análise e o registro da dispensa), SCR-120 (somente consulta do que a US-151 configura).
- **Componentes:** `WaiveReviewDialog` (lista de hipóteses com base legal e ato, aplicabilidade com motivo, justificativa com contador, aviso de definitividade), `WaiverHypothesisOption`, `WaiverRecordCard` (hipótese, justificativa, responsável, data), `ReviewStatusBadge`.
- **Estados:** skeleton no painel; vazio ("Nenhuma hipótese de dispensa está ativa"); erro com "Tentar novamente"; sucesso com toast e painel em leitura; botão desabilitado com motivo; hipótese inaplicável desabilitada com texto.
- **Acessibilidade e responsividade:** aplicabilidade nunca só por cor (texto e ícone); lista de hipóteses como grupo de opções com rótulos e descrições associadas; foco preso e retorno do foco no diálogo; abaixo de 768 px o diálogo vira tela cheia; contraste AA.

## Banco de dados
- **Tabelas:** `legal_reviews` (escrita de `status`, `waiver_hypothesis_id`, `waiver_justification`, `waived_by_id`, `waived_at`, `version`); leitura de `catalog_items`, `processes`, `process_stages`, `workflow_stages`.
- **Migrações:** nenhuma nova (M2-15 já cria a tabela e o check de `WAIVED`); o trigger de imutabilidade em `WAIVED` entra em M2-15 (a confirmar com o card de migração); eventual `waiver_snapshot` depende da lacuna 5.
- **Índices/constraints relevantes:** check `status <> 'WAIVED' OR (waiver_hypothesis_id IS NOT NULL AND waiver_justification IS NOT NULL)` (e `waived_at`/`waived_by_id` na aplicação e no trigger); FK composta de `waiver_hypothesis_id` com o tenant; a unicidade de análise aberta (`PENDING`/`IN_REVIEW`/`DILIGENCE`) deixa de valer ao dispensar.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-21` | POST | `/api/v1/legal-reviews/{id}/waive` | `{ hypothesisId, justification }` + `If-Match` + `Idempotency-Key` | `200 { data: LegalReview }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel; ganha `canWaive`, `waiverOptions[]` (`id`, `code`, `name`, `legalBasis`, `actReference`, `applicable`, `reasonCode?`) e, em `WAIVED`, `waiver` (hipótese, justificativa, `waivedById`, `waivedAt`) | 200, 401, 403, 404 |

## Logs
- `info` `legal_review.waived` — `legalReviewId`, `processId`, `hypothesisCode`, `justificationLength`, `durationMs`, `correlationId`.
- `info` `legal_review.waiver_evaluated` — `legalReviewId`, `hypothesisCode`, `applicable`, `reasonCode?`, `durationMs`.
- `warn` `legal_review.waive_denied` — `reasonCode`, `legalReviewId`; `warn` `idempotency.store_unavailable`.
- `error` `legal_review.waive_failed` e `legal_review.waive_evaluation_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** justificativa, valores do processo, conteúdo de documentos, valores de teto das hipóteses.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.waive` | `WORKFLOW` | Commit de LGL-21 | `changes.status`: `PENDING` para `WAIVED`; `metadata`: `hypothesisId`, `hypothesisCode`, `hypothesisName`, `legalBasis`, `actReference`, `conditionResult` (booleano), `valueLimitChecked` (booleano), `stageLegallyRequired` (booleano), `justificationLength`, `justificationHash`, `waivedByRole` (`ASSIGNEE` ou `UNIT_HEAD`) |
| `access.denied` | `ACCESS` | 403 em LGL-21 | `reasonCode`, `legalReviewId` |

## Testes necessários
- **Unitários:** `WaiverHypothesisEvaluator` (condição verdadeira e falsa, teto no limite e acima, hipótese sem critério, etapa obrigatória prevista e não prevista, falha fechada por timeout); transição `PENDING` para `WAIVED`; POL-19 (autor, criador, lotado no setor solicitante) e designação; `ConfidentialTextGuard`; normalização da justificativa.
- **Integração (Testcontainers):** dispensa completa (campos, auditoria com evidência, evento, timeline, notificação); rollback total na falha; reavaliação sob lock com o processo mudando entre o painel e a confirmação; dispensa x início simultâneos; trigger de imutabilidade em `WAIVED`; ausência de `legal_review_documents`.
- **API/contrato:** LGL-21 (códigos, `reasonCode`, ETag, `Idempotent-Replayed`); campos aditivos de LGL-02 sem valores numéricos; `MFA_REQUIRED`.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-21, `waiverOptions[]` e hipótese de outro tenant; matriz de autorização (gerada) com `LEGAL_REVIEW_WAIVE`; casos de POL-19, designação, titular sem designação e MFA; justificativa ausente de qualquer log, evento e notificação.
- **Concorrência:** dispensa x início, duas dispensas, dispensa x redistribuição (US-150).
- **E2E (Playwright):** fila, painel, diálogo com hipóteses aplicáveis e inaplicáveis, dispensa, painel em leitura, encaminhamento do processo à etapa seguinte com a regra de saída satisfeita.
- **Acessibilidade/performance:** axe em painel e diálogo; 360 px; metas de p95 na suíte de performance.

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
- [ ] Condição da hipótese avaliada no servidor dentro da transação, com falha fechada comprovada
- [ ] Evidência da hipótese congelada na auditoria e dispensa imutável (trigger testada)
- [ ] Gherkin das 8 categorias automatizado, incluindo POL-19, MFA e etapa legalmente obrigatória

## Estimativa
**M** — um comando transacional, a avaliação da hipótese contra o processo (condição, teto e trava da etapa obrigatória) e a extensão do painel; o esforço está na avaliação fechada e sigilosa da regra e na evidência imutável da dispensa.

## Prioridade
**P0** — a dispensa do art. 53, § 5º, é uma das duas saídas legítimas da etapa `JURIDICO` sem parecer (a outra é a conclusão da US-155) e o risco de "dispensa como atalho" só é controlado pelas travas e pela auditoria desta story.
