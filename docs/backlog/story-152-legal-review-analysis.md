---
id: US-152
title: "Conduzir a análise jurídica sobre versões exatas"
epic: EP-025
feature: FT-074
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-066, US-149]
modules: [legal-review, document, process, timeline, audit]
screens: [SCR-019, SCR-006, SCR-106]
endpoints: [LGL-10, LGL-11, LGL-12, LGL-02, DOC-17, DOC-18]
permissions: [LEGAL_REVIEW_MANAGE, LEGAL_REVIEW_VIEW, PROCESS_VIEW]
events: [LegalReviewStarted]
---

# US-152 — Conduzir a análise jurídica sobre versões exatas

## Título
Conduzir a análise jurídica sobre versões exatas

## Descrição
**Como** procurador da assessoria jurídica (ou titular/substituto da unidade jurídica), **quero** iniciar a análise de um processo que está na minha fila e ter registradas, no ato, as versões exatas dos documentos que vou analisar, podendo consultá-las e compará-las entre rodadas, **para** que o parecer fique preso ao que foi de fato lido e ninguém tenha dúvida sobre "o que o jurídico viu" (art. 53 da Lei 14.133/2021).

A story entrega o ato de **iniciar** a análise (`PENDING` para `IN_REVIEW`), o **snapshot** das versões vigentes em `LegalReviewDocument` (rodada 1, imutável), a consulta das versões analisadas por rodada, a comparação entre rodadas e o painel de análise (SCR-019, `/juridico/[reviewId]`). Pedir diligência e retomar em nova rodada é da US-153; elaborar o parecer e as ressalvas é da US-154; concluir é da US-155; dispensar é da US-156.

## Contexto
- A DEC-199 cria a `LegalReview` por processo, com rodadas (`currentRound`) e `LegalReviewDocument` com as **versões exatas** analisadas, no mesmo padrão de `ApprovalDocument`. Sem isso, o parecer não prova sobre qual versão do TR, do edital ou da pesquisa de preços foi emitido (risco "parecer analisar versão desatualizada", roadmap §8).
- A `LegalReview` nasce `PENDING` quando o processo entra em `JURIDICO` (US-149) e é distribuída pelo chefe da assessoria (US-150). Esta story é o passo seguinte: o procurador **inicia**.
- POL-19 (segregação jurídico x requisitante) vale para iniciar: quem criou o processo, é autor de DFD, ETP, TR, `EDITAL` ou `MINUTA_CONTRATO` ou é lotado na secretaria/setor solicitante não inicia a análise.
- O snapshot usa `Document.currentVersionId` (US-066: versões imutáveis, `versionNumber` sequencial); a comparação de conteúdo entre duas versões de um mesmo documento reaproveita DOC-18 (US-066) e aqui só se organiza por rodada.
- A diligência (US-153) devolve o processo e a análise volta em **nova rodada**, com novo snapshot; por isso esta story já define o snapshot e a comparação por `round`, mesmo que a rodada 2 só exista depois da US-153.
- O orçamento sigiloso (DEC-030/POL-09) nunca entra em eventos, notificações ou logs; o snapshot guarda só referências (ids), não conteúdo.

## Objetivo
Garantir que 100% das análises iniciadas tenham, na mesma transação, o conjunto de versões vigentes gravado e imutável por rodada, que a transição `PENDING` para `IN_REVIEW` só seja feita por quem pode e que o procurador consiga ver e comparar as versões analisadas entre rodadas em até 2 cliques a partir do painel.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) designado como `assigneeId` da análise.
- **Secundárias:** titular ou substituto da unidade jurídica da etapa (iniciam análise sem designação ou designada a outro); chefe da assessoria jurídica (acompanha); Auditor e Controle Interno (`AUDITOR`, `CONTROLE_INTERNO`: leem versões e comparação); Planejamento e Compras (leem a situação no processo, SCR-006).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, sessão com MFA conforme `security.mfaPolicy` (`LEGAL_REVIEW_MANAGE` é risco `M`: MFA só com política `ALL`).
- `LegalReview` do tenant em `PENDING`, de processo `IN_PROGRESS` com a etapa `JURIDICO` ativa (`currentProcessStageId` não nulo) e visível ao usuário (DEC-024).
- Usuário com `LEGAL_REVIEW_MANAGE` cobrindo o processo, sem conflito de POL-19, e que seja o `assigneeId` ou o titular/substituto da unidade jurídica da etapa.
- Existe ao menos um documento elegível do processo com versão salva (RN-LGL-41/RN-LGL-42).

## Fluxo principal
1. O procurador abre a fila (SCR-019, `/juridico`, US-149), seleciona a análise `PENDING` e entra no painel (`/juridico/[reviewId]`, LGL-02), que mostra processo, objeto, prazo da etapa, fatores de prioridade e, em "Documentos do processo", a pré-visualização das versões vigentes que serão registradas.
2. O painel exibe o botão **"Iniciar análise"** somente se o usuário atende a RN-LGL-40; o clique abre o diálogo de confirmação "Ao iniciar, as versões vigentes abaixo serão registradas como a base desta análise." com a lista (tipo, título, versão `vN`, autor e data) e os tipos sem documento ("Pesquisa de preços: não elaborada").
3. O procurador confirma; o front envia LGL-10 com `If-Match` (ETag da `LegalReview`) e `Idempotency-Key`.
4. A API valida na ordem: existência e tenant, permissão e POL-19, `assigneeId`/titularidade, status `PENDING`, processo `IN_PROGRESS` com etapa `JURIDICO` ativa, ao menos um documento elegível.
5. Na **mesma transação**, a API trava a `LegalReview` e os documentos elegíveis (leitura de `currentVersionId` sob lock), grava um `LegalReviewDocument` por documento (`round = currentRound`, `documentVersionId`, `documentTypeCode` congelado), muda `status` para `IN_REVIEW`, grava `startedAt` (primeira passagem), incrementa o `version` (ETag) e registra auditoria `legal_review.start`.
6. Pelo outbox, publica `LegalReviewStarted` (projeta `LEGAL_REVIEW_STARTED` na timeline: "{actor} iniciou a análise jurídica") e responde 200 com a `LegalReview`, a `round` e a lista de versões registradas.
7. O painel passa a mostrar a análise `IN_REVIEW`, a seção "Versões analisadas (rodada 1)" (LGL-11) e os atalhos "Abrir versão" (DOC-17, SCR-106) e "Comparar com a versão vigente" (DOC-18).
8. Mais tarde, com mais de uma rodada (US-153), o procurador escolhe "Comparar rodadas" e vê, por documento, se foi adicionado, removido, alterado ou inalterado (LGL-12), com o atalho para a comparação de conteúdo da versão (DOC-18).

## Fluxos alternativos
- **FA-01 — Análise sem designação:** o titular ou substituto da unidade jurídica pode iniciar uma análise `PENDING` sem `assigneeId`; o início **não** designa ninguém (a designação é do chefe da assessoria, US-150); a conclusão seguirá exigindo `assigneeId` ou titular/substituto (POL-19).
- **FA-02 — Análise designada a outra pessoa:** o procurador que não é o `assigneeId` nem titular/substituto vê o painel (com `LEGAL_REVIEW_VIEW`) sem o botão; a chamada direta responde 403 `NOT_LEGAL_REVIEW_ASSIGNEE`.
- **FA-03 — Documento sem versão salva:** um documento em `DRAFT` que nunca teve versão (`currentVersionId` nulo) não entra no snapshot e aparece no painel como "sem versão salva" (RN-LGL-41).
- **FA-04 — Tipo de documento ausente:** tipo previsto no processo sem documento (por exemplo, sem mapa de riscos) aparece como "não elaborado" e não impede o início; a ausência é um dado para o parecer, não um bloqueio.
- **FA-05 — Nenhum documento elegível:** o início é recusado com 422 `LEGAL_REVIEW_NOTHING_TO_ANALYZE` e a orientação de pedir ao requisitante o envio dos documentos (RN-LGL-42).
- **FA-06 — Documento mudou entre a abertura do diálogo e a confirmação:** a lista do diálogo é só uma prévia; o servidor grava o que é vigente dentro da transação e devolve na resposta as versões efetivamente registradas; se diferirem da prévia, o painel avisa "Alguns documentos mudaram enquanto você confirmava; confira a lista registrada." (RN-LGL-42).
- **FA-07 — Versão vigente mudou depois do início:** o snapshot não muda (imutável); o painel marca o documento como "versão mais recente disponível (vN)" e oferece "Comparar com a versão vigente"; a nova versão só entra em nova rodada (US-153) (RN-LGL-43).
- **FA-08 — Comparação entre rodadas inexistentes:** `fromRound` ou `toRound` sem snapshot responde 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`); com apenas a rodada 1 a ação "Comparar rodadas" fica desabilitada com a dica "Há uma só rodada".
- **FA-09 — Análise em `IN_REVIEW`, `DILIGENCE` ou final:** LGL-10 responde 409 `LEGAL_REVIEW_INVALID_STATE`; as consultas (LGL-11, LGL-12) seguem disponíveis em qualquer status, inclusive `FAVORABLE*`, `UNFAVORABLE`, `WAIVED` e `CANCELED`, para quem tem acesso.
- **FA-10 — Processo suspenso, cancelado ou fora de `JURIDICO`:** LGL-10 responde 409 `INVALID_PROCESS_STATUS`; o painel mostra o botão desabilitado com o motivo.

## Regras de negócio
- **RN-LGL-09** — A análise considera as **versões exatas** dos documentos; `LegalReviewDocument` é gravado ao abrir cada rodada, completado na conclusão e imutável (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-10** — Segregação: quem elaborou o processo ou seus documentos não analisa; a análise exige `LEGAL_REVIEW_MANAGE` cobrindo o processo (POL-19). *(regra da feature, adotada)*
- **RN-LGL-11** — Há seis situações do produto (`PENDING`, `IN_REVIEW`, `DILIGENCE`, `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`), mais `WAIVED` e `CANCELED`; as conclusivas e `WAIVED` são finais e a análise concluída é imutável (DEC-199). Aqui: a única transição desta story é `PENDING` para `IN_REVIEW`. *(regra da feature, adotada)*
- **RN-LGL-40** — Quem inicia: `LEGAL_REVIEW_MANAGE` cobrindo o processo, sem conflito de POL-19 (`LEGAL_REVIEW_SEGREGATION`), e que seja o `assigneeId` da análise **ou** o titular/substituto da unidade jurídica da etapa `JURIDICO` (`NOT_LEGAL_REVIEW_ASSIGNEE` caso contrário). O início não altera `assigneeId`, `assignedAt` nem `assignedById` (DEC-199, POL-19).
- **RN-LGL-41** — Composição do snapshot: para cada `Document` do processo, não excluído logicamente e fora de `CANCELED`, cujo `documentTypeCode` seja `DFD`, `ETP`, `RISK_MAP`, `PRICE_RESEARCH`, `TR`, `EDITAL` ou `MINUTA_CONTRATO`, grava-se um `LegalReviewDocument` com `documentVersionId = Document.currentVersionId` lido sob lock na transação. Tipos que admitem vários documentos entram com todos; documento sem versão salva não entra e é exibido como "sem versão salva". `PARECER_JURIDICO` e `MANIFESTACAO_CONTROLE_INTERNO` nunca entram (DEC-199).
- **RN-LGL-42** — O início é atômico: snapshot, mudança de status, `startedAt`, auditoria e evento no mesmo commit; sem documento elegível a ação responde 422 `LEGAL_REVIEW_NOTHING_TO_ANALYZE` e nada é gravado. A prévia exibida no diálogo não vale como reserva; vale o que o servidor gravou (DEC-199).
- **RN-LGL-43** — Consulta (LGL-11): lista as versões registradas por rodada com tipo, título, `versionNumber`, autor da versão, data, `status` do documento na versão (`statusAtCreation`) e o indicador **derivado** (não persistido) `isCurrent`/`newerVersionNumber` (a versão vigente do documento é outra que a analisada). O conteúdo da versão é lido por DOC-17 com POL-09 e DEC-024; a lista em si não contém valores monetários (DEC-030).
- **RN-LGL-44** — Comparação (LGL-12): `fromRound` < `toRound`, ambas existentes; o resultado traz, por documento, `change` = `ADDED` (só na rodada final), `REMOVED` (só na inicial), `CHANGED` (`documentVersionId` diferente, com `fromVersionNumber`/`toVersionNumber` e o par de parâmetros para DOC-18) ou `UNCHANGED`; o diff de conteúdo não é recalculado aqui. Campos de documentos com valor sigiloso seguem o mascaramento de DOC-18 (`MASKED`) para quem não atende POL-09 (RN-DOC-61).
- **RN-LGL-45** — Leitura: `LEGAL_REVIEW_VIEW` cobrindo o processo (DEC-024) lê o painel, o snapshot e a comparação; `AUDITOR` com `AUDIT_VIEW` e o Controle Interno leem também; `LegalReviewStarted` é publicado **uma vez por análise** (início, rodada 1) — as rodadas seguintes publicam `LegalReviewResumed` (US-153). `startedAt` só é gravado na primeira passagem a `IN_REVIEW`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Análise | `id` (path) | uuid | Sim | `LegalReview` do tenant | rota |
| Versão da análise | `If-Match` (ETag) | texto | Sim | ETag da `LegalReview` | `GET` LGL-02 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| Rodada (consulta) | `round` | smallint | Não | filtra LGL-11; padrão `currentRound` | — |
| Rodada de origem / destino | `fromRound`, `toRound` | smallint | Sim (LGL-12) | `fromRound` < `toRound`, existentes | — |
| *(saída)* Situação | `status` | `LegalReviewStatus` | — | `IN_REVIEW` após o início | derivado |
| *(saída)* Início da análise | `startedAt` | datetime | — | primeira passagem | servidor |
| *(saída)* Versões registradas | `documents[]` | lista | — | RN-LGL-41/RN-LGL-43 | `LegalReviewDocument` |
| *(saída)* Documento | `documentId`, `documentTypeCode`, `documentVersionId`, `versionNumber` | uuid / texto / uuid / int | — | congelados | snapshot |
| *(saída)* Versão mais recente | `isCurrent`, `newerVersionNumber?` | booleano / int | — | derivado, não persistido | `Document.currentVersionId` |
| *(saída)* Mudança entre rodadas | `change` | `ADDED` \| `REMOVED` \| `CHANGED` \| `UNCHANGED` | — | RN-LGL-44 | derivado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `If-Match` ausente | API | "Atualize a página e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-02 | `If-Match` divergente da ETag da análise | API | "Esta análise foi alterada por outra pessoa. Atualize a página." | `VERSION_CONFLICT` (412) |
| V-03 | `fromRound`/`toRound` ausentes, não inteiros ou `fromRound` >= `toRound` | Front + API (Zod) | "Escolha duas rodadas, da mais antiga para a mais recente." | `VALIDATION_ERROR` |
| V-04 | Rodada informada sem snapshot | API | "Esta rodada não existe nesta análise." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Análise não está `PENDING` | API | "Esta análise já foi iniciada ou encerrada." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-06 | Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | API | "O processo não está disponível para análise no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-07 | Usuário em conflito de segregação (POL-19) | API | "Você participou da elaboração deste processo e não pode analisá-lo." | `LEGAL_REVIEW_SEGREGATION` (403) |
| V-08 | Usuário não é o designado nem titular/substituto | API | "Esta análise está designada a outra pessoa." | `NOT_LEGAL_REVIEW_ASSIGNEE` (403) |
| V-09 | Nenhum documento elegível com versão salva | API | "Não há documentos do processo para analisar. Peça ao requisitante que envie os documentos." | `LEGAL_REVIEW_NOTHING_TO_ANALYZE` (422) |
| V-10 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_MANAGE` (iniciar) com escopo que cubra o processo; `LEGAL_REVIEW_VIEW` para o painel, o snapshot e a comparação; `PROCESS_VIEW` para abrir o conteúdo das versões (DOC-17/DOC-18).
- **Políticas:** POL-19 (segregação jurídico x requisitante; designado ou titular/substituto), DEC-024 (visibilidade do processo), POL-09 (valor sigiloso no conteúdo das versões), POL-24 (o parecer em rascunho não entra no snapshot e segue restrito).
- **MFA:** `LEGAL_REVIEW_MANAGE` tem risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Iniciar análise" fica oculto; a API responde 403 `PERMISSION_DENIED` (sem permissão) ou `LEGAL_REVIEW_SEGREGATION` / `NOT_LEGAL_REVIEW_ASSIGNEE`, com auditoria `access.denied`; análise de outro tenant ou de processo invisível responde 404 `LEGAL_REVIEW_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewStarted` | `legal_review.started` | Commit de LGL-10 | Payload `legalReviewId`, `round`, `documentVersionIds[]` (só ids); consumidores T (timeline `LEGAL_REVIEW_STARTED`) e R (read model); sem notificação |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story (events.md §6 não prevê tipo para o início da análise; o início aparece na timeline do processo) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Conduzir a análise jurídica sobre versões exatas

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "JURIDICO"
    And a análise jurídica "LR-0045" do processo está "PENDING" na rodada 1, designada a "Dr. André Nunes"
    And "Dr. André Nunes" tem vínculo ativo, o perfil "JURIDICO" com "LEGAL_REVIEW_MANAGE" cobrindo o processo e não participou da elaboração
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e é autora do TR
    And o processo tem DFD v2, ETP v3, TR v4 e edital v1 como versões vigentes, e a pesquisa de preços v2 ainda não foi elaborada

  Scenario: [Sucesso] Iniciar a análise registra as versões vigentes
    When "Dr. André Nunes" confirmar "Iniciar análise" com a chave "K1"
    Then a API deve responder 200 com a análise "IN_REVIEW", "currentRound" 1 e "startedAt" preenchido
    And devem existir 4 registros "LegalReviewDocument" na rodada 1 com DFD v2, ETP v3, TR v4 e edital v1
    And o "assigneeId" deve continuar "Dr. André Nunes"
    And deve gerar registro de auditoria "legal_review.start" com a lista de "documentVersionIds"
    And deve gerar o evento "LegalReviewStarted" com "round" 1 e os 4 ids de versão
    And a timeline do processo deve exibir "Dr. André Nunes iniciou a análise jurídica"

  Scenario: [Sucesso] Titular da unidade inicia análise sem designação
    Given que a análise "LR-0045" não tem "assigneeId"
    And "Dra. Helena Prado" é titular da unidade jurídica da etapa
    When "Dra. Helena Prado" iniciar a análise
    Then a API deve responder 200 com a análise "IN_REVIEW"
    And o "assigneeId" deve continuar nulo

  Scenario: [Sucesso] Consultar o snapshot e perceber versão mais recente
    Given que a análise está "IN_REVIEW" com o TR v4 registrado
    And "Carla Mendes" salvou a versão v5 do TR depois do início
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}/documents"
    Then a API deve responder 200 com o TR "versionNumber" 4, "isCurrent" false e "newerVersionNumber" 5
    And o snapshot da rodada 1 não deve ter mudado

  Scenario: [Sucesso] Comparar duas rodadas
    Given que a análise tem a rodada 2 com o TR v5 e a pesquisa de preços v1 novas, mantendo DFD, ETP e edital
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}/documents/compare?fromRound=1&toRound=2"
    Then a API deve responder 200 com TR "CHANGED" (v4 para v5), pesquisa de preços "ADDED" e DFD, ETP e edital "UNCHANGED"
    And não deve gerar auditoria nem evento

  Scenario: [Validação] Rodadas inválidas e nada para analisar
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id}/documents/compare?fromRound=2&toRound=1"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Dr. André Nunes" chamar a comparação com "toRound" 9
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "toRound"
    Given que o processo "0050/2026" só tem documentos sem versão salva
    When "Dr. André Nunes" tentar iniciar a análise "LR-0050"
    Then a API deve responder 422 com código "LEGAL_REVIEW_NOTHING_TO_ANALYZE"
    And a análise deve continuar "PENDING" e nenhum "LegalReviewDocument" deve ser gravado

  Scenario: [Permissão] Segregação, outra designação e perfil sem permissão
    Given que "Carla Mendes" também tem o perfil "JURIDICO" com "LEGAL_REVIEW_MANAGE"
    When "Carla Mendes" chamar "POST /legal-reviews/{id}/start"
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION"
    And deve gerar registro de auditoria "access.denied"
    Given que "Dra. Lúcia Prado", procuradora sem relação com o processo, não é a designada nem titular
    When "Dra. Lúcia Prado" chamar "POST /legal-reviews/{id}/start"
    Then a API deve responder 403 com código "NOT_LEGAL_REVIEW_ASSIGNEE"
    Given que "Bruno Lopes" não tem "LEGAL_REVIEW_MANAGE"
    When "Bruno Lopes" chamar "POST /legal-reviews/{id}/start"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And a análise deve continuar "PENDING"

  Scenario: [Tenant incorreto] Análise de outro órgão
    Given que a análise "LR-0007" pertence ao tenant "Prefeitura B"
    When "Dr. André Nunes" chamar "POST /legal-reviews/{id-LR-0007}/start" e "GET /legal-reviews/{id-LR-0007}/documents"
    Then a API deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND" nas duas chamadas
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio do início com a mesma chave e início de análise já iniciada
    Given que "Dr. André Nunes" iniciou a análise com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And devem existir 4 "LegalReviewDocument" e um único evento "LegalReviewStarted"
    When "Dr. André Nunes" iniciar de novo com a chave "K2" e a ETag nova
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"

  Scenario: [Concorrência] Início simultâneo por duas pessoas e documento alterado durante o início
    When "Dr. André Nunes" e "Dra. Helena Prado" iniciarem a mesma análise ao mesmo tempo com a mesma ETag
    Then exatamente uma chamada deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "LEGAL_REVIEW_INVALID_STATE"
    And devem existir exatamente 4 "LegalReviewDocument" e um evento "LegalReviewStarted"
    Given que "Carla Mendes" salva uma nova versão do TR durante a transação do início
    Then o snapshot deve registrar uma única versão do TR, a lida sob lock, e a resposta deve trazer essa versão

  Scenario: [Falha de banco] Falha ao gravar o snapshot
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/start"
    When "Dr. André Nunes" confirmar "Iniciar análise"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "PENDING" e nenhum "LegalReviewDocument", auditoria ou evento deve ter sido gravado

  Scenario: [Falha de integração] Redis indisponível no armazenamento de idempotência
    Given que o Redis está indisponível
    When "Dr. André Nunes" iniciar a análise
    Then a API deve responder 200 e concluir o início sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega o painel |
| ETag divergente | 412 | `VERSION_CONFLICT` | "Esta análise foi alterada por outra pessoa. Atualize a página." | Recarrega e reexibe o diálogo |
| Análise inexistente, de outro tenant ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Análise não está `PENDING` | 409 | `LEGAL_REVIEW_INVALID_STATE` | "Esta análise já foi iniciada ou encerrada." | Recarrega o painel |
| Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para análise no momento." | Desabilita o botão com o motivo |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você participou da elaboração deste processo e não pode analisá-lo." | Oculta o botão e explica na dica |
| Não é o designado | 403 | `NOT_LEGAL_REVIEW_ASSIGNEE` | "Esta análise está designada a outra pessoa." | Oculta o botão |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para iniciar análises jurídicas." | Oculta o botão |
| Nada para analisar | 422 | `LEGAL_REVIEW_NOTHING_TO_ANALYZE` | "Não há documentos do processo para analisar. Peça ao requisitante que envie os documentos." | Mantém o diálogo com a orientação |
| Rodada inválida na comparação | 422 | `VALIDATION_ERROR` | "Esta rodada não existe nesta análise." | Marca o seletor |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível iniciar a análise agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-066 (versões imutáveis, `currentVersionId`, DOC-17/DOC-18 usados na consulta e na comparação); US-149 (cria a `LegalReview` `PENDING`, expõe o painel LGL-02 e a fila). Indiretas: US-150 (designação — define o `assigneeId`), US-153 (nova rodada e novo snapshot), US-154 (parecer), US-155 (conclusão e completar o snapshot com a versão do parecer), US-129 (`RuleContext` v2 lê `legalReview.*`).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-196, DEC-199; POL-19, POL-09, POL-24; RN-LGL-09, RN-LGL-10, RN-LGL-11.
- **Configurações:** nenhuma chave nova.
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro do módulo:** `LEGAL_REVIEW_NOT_FOUND` (404), `LEGAL_REVIEW_INVALID_STATE` (409) e `LEGAL_REVIEW_NOTHING_TO_ANALYZE` (422) não constam em `permissions.md` nem em `events.md` (só `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE`, `DOCUMENT_DRAFT_RESTRICTED` e `LEGAL_WAIVER_NOT_APPLICABLE`); a consolidar no `api.md` do MVP 2.
  2. **Tipos de documento do snapshot:** a lista (DFD, ETP, `RISK_MAP`, `PRICE_RESEARCH`, TR, `EDITAL`, `MINUTA_CONTRATO`) vem de `entities.md §4.3` e do `draft.legal_opinion`; os códigos exatos de `DocumentType` do MVP 1 devem ser conferidos no seed (`RISK_MAP` e `PRICE_RESEARCH` vêm do MVP 1; `EDITAL` e `MINUTA_CONTRATO` do §9 do MVP 2).
  3. **Campos aditivos de LGL-02/LGL-11/LGL-12** (`isCurrent`, `newerVersionNumber`, `change`) e o formato do par de parâmetros para DOC-18 não estão no catálogo de API do MVP 2 (a consolidar no card 9).
  4. **Evento por rodada:** a feature diz "`LegalReviewStarted` — início de cada rodada", mas `events.md §4.5` e a timeline (§5) usam `LegalReviewStarted` no início e `LegalReviewResumed` na retomada; a story segue `events.md` (RN-LGL-45).
  5. **Sem tipo de notificação para o início da análise** (nem para o requisitante): não há na tabela de `events.md §6`; fica só na timeline. **Dúvida de produto.**

## Impacto técnico
- **Atomicidade e lock:** a leitura de `currentVersionId` ocorre sob `SELECT ... FOR UPDATE` nos `Document` elegíveis (ordem determinística por `id`, para evitar deadlock com `DOC-16`); a janela de bloqueio é curta (no máximo algumas dezenas de linhas).
- **Imutabilidade:** `legal_review_documents` ganha trigger que bloqueia `UPDATE`/`DELETE` (exceto a inclusão da linha do parecer na conclusão, US-155, e o `CASCADE` de remoção de tenant); `UNIQUE (tenant_id, legal_review_id, round, document_id)` garante uma linha por documento e rodada.
- **Derivados, não persistidos:** `isCurrent` e `newerVersionNumber` são calculados na leitura (junção com `documents.current_version_id`), sem coluna nova; a comparação entre rodadas é uma junção de duas rodadas do mesmo `legal_review_id`.
- **Desempenho:** metas p95 de LGL-10 < 800 ms e de LGL-11/LGL-12 < 400 ms (até 30 documentos) escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda; DOC-17/DOC-18 são reutilizados sem alteração.
- **Sigilo:** o snapshot não contém conteúdo nem valores; eventos e logs só carregam ids (DEC-030).

## Backend
- **Módulo(s):** `legal-review` (dono), `document` (fachada de leitura `DocumentFacade.getCurrentVersions`), `process` (consulta de status e etapa), `timeline`, `audit`.
- **Casos de uso:** `StartLegalReviewCommand` (LGL-10), `ListLegalReviewDocumentsQuery` (LGL-11), `CompareLegalReviewRoundsQuery` (LGL-12); painel via `GetLegalReviewQuery` (LGL-02, US-149).
- **Domínio:** `LegalReview.start()` (invariante `PENDING` para `IN_REVIEW`), `LegalReviewSnapshotBuilder.build(processId, round)` (RN-LGL-41), `LegalReviewSegregationPolicy` (POL-19, compartilhada com US-153/154/155), `LegalReviewRoundComparator`.
- **Integrações internas:** `DocumentFacade`, `ProcessFacade.getStageAndStatus`, `OrgUnitFacade.getTitularAndDeputy`, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** bloqueio da análise e dos documentos, validações, snapshot, status, `startedAt`, auditoria, outbox e timeline; falha em qualquer passo desfaz tudo.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`, painel de análise), SCR-006 (aba Resumo do processo mostra a situação da análise), SCR-106 (versões, para abrir a versão e comparar).
- **Componentes:** `LegalReviewPanel`, `StartReviewDialog` (prévia das versões e tipos ausentes), `AnalyzedVersionsTable` (por rodada, selo "versão mais recente disponível"), `RoundComparePanel` (seletor de rodadas, selo por mudança), `ReviewStatusBadge`.
- **Estados:** skeleton no painel; vazio ("Nenhuma versão registrada: inicie a análise"); erro com "Tentar novamente"; sucesso com aviso de divergência entre a prévia e o registrado (FA-06); botão com motivo quando indisponível.
- **Acessibilidade e responsividade:** selos de mudança e de versão nunca só por cor (texto e ícone); tabela com cabeçalhos associados; foco preso e retorno do foco no diálogo; abaixo de 768 px a tabela vira lista de cartões; contraste AA.

## Banco de dados
- **Tabelas:** `legal_reviews` (escrita de `status`, `started_at`, `version`), `legal_review_documents` (inserção), leitura de `documents`, `document_versions`, `processes`, `process_stages`.
- **Migrações:** nenhuma nova (M2-15 já cria as tabelas); a trigger de imutabilidade de `legal_review_documents` entra em M2-15 (a confirmar com o card de migração).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, legal_review_id, round, document_id)`; índice `(tenant_id, document_id)`; check de transição de status (`PENDING` para `IN_REVIEW`) na aplicação e, onde couber, em trigger.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-10` | POST | `/api/v1/legal-reviews/{id}/start` | corpo vazio + `If-Match` + `Idempotency-Key` | `200 { data: LegalReview, meta: { round, documents[] } }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `LGL-11` | GET | `/api/v1/legal-reviews/{id}/documents` | `round?` | `200 { data: [ { round, documentId, documentTypeCode, title, documentVersionId, versionNumber, authorId, versionCreatedAt, isCurrent, newerVersionNumber? } ] }` | 200, 401, 403, 404, 429, 503 |
| `LGL-12` | GET | `/api/v1/legal-reviews/{id}/documents/compare` | `fromRound`, `toRound` | `200 { data: [ { documentId, documentTypeCode, change, fromVersionId?, toVersionId?, fromVersionNumber?, toVersionNumber? } ] }` | 200, 401, 403, 404, 422, 429, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel + fatores; ganha `canStart` e `currentRound` | 200, 401, 403, 404 |
| `DOC-17` | GET | `/api/v1/document-versions/{versionId}` | MVP 1 | conteúdo da versão (POL-09) | 200, 403, 404 |
| `DOC-18` | GET | `/api/v1/documents/{id}/versions/compare` | `from`, `to` (MVP 1) | diff por seção e coleção | 200, 403, 404, 422 |

## Logs
- `info` `legal_review.started` — `legalReviewId`, `processId`, `round`, `documentsCount`, `durationMs`, `correlationId`.
- `info` `legal_review.compare` — `legalReviewId`, `fromRound`, `toRound`, `changedCount`.
- `warn` `legal_review.start_denied` — `reasonCode`, `legalReviewId`; `warn` `idempotency.store_unavailable`.
- `error` `legal_review.start_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo ou título de documentos, valores do processo, texto de comentários.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.start` | `WORKFLOW` | Commit de LGL-10 | `changes.status`: `PENDING` para `IN_REVIEW`; `metadata`: `round`, `documentVersionIds[]`, `startedByRole` (`ASSIGNEE` ou `UNIT_HEAD`) |
| `access.denied` | `ACCESS` | 403 em LGL-10, LGL-11 ou LGL-12 | `reasonCode`, `legalReviewId` |

## Testes necessários
- **Unitários:** composição do snapshot (tipos, vários documentos do mesmo tipo, documento sem versão, `CANCELED`), transição de status, POL-19 (autor, criador, lotado no setor solicitante), comparador de rodadas (`ADDED`, `REMOVED`, `CHANGED`, `UNCHANGED`), indicador `isCurrent`.
- **Integração (Testcontainers):** início completo (snapshot, status, auditoria, evento, timeline); rollback total na falha; início com documento alterado em paralelo (lock); imutabilidade por trigger (`UPDATE`/`DELETE` em `legal_review_documents` falha).
- **API/contrato:** LGL-10/11/12 (códigos, ETag, `Idempotent-Replayed`); DOC-17/DOC-18 inalterados.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-10/11/12 e leitura de snapshot entre tenants; matriz de autorização (gerada) com `LEGAL_REVIEW_MANAGE`/`VIEW`; casos de POL-19 e de designação.
- **Concorrência:** dois inícios simultâneos com a mesma ETag (um efetivo); início x nova versão de documento.
- **E2E (Playwright):** fila, painel, "Iniciar análise" com prévia, versões analisadas, abrir versão e comparação.
- **Acessibilidade/performance:** axe em painel, diálogo e tabela; 360 px; metas de p95 na suíte de performance.

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
- [ ] Snapshot comprovadamente imutável (trigger testada) e gravado na mesma transação do início
- [ ] Gherkin das 8 categorias automatizado, incluindo POL-19 e início sem designação

## Estimativa
**M** — um comando transacional (início com snapshot), duas consultas e o painel; o esforço está na imutabilidade, na regra de quem pode iniciar (POL-19 com titular/substituto) e na comparação por rodada.

## Prioridade
**P0** — sem o início e o snapshot não há análise rastreável nem parecer vinculado às versões; bloqueia US-153, US-154 e US-155.
