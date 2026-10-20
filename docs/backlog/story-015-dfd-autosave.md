---
id: US-015
title: "Editar DFD com autosave, retomada e tratamento de conflito"
epic: EP-002
feature: FT-008
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-014]
modules: [document, dfd, audit, platform]
screens: [SCR-007]
endpoints: [DFD-03, DFD-04, DOC-03, DOC-05, DOC-07]
permissions: [DFD_UPDATE]
events: []
---

# US-015 — Editar DFD com autosave, retomada e tratamento de conflito

## Título
Editar DFD com autosave, retomada e tratamento de conflito

## Descrição
**Como** redatora de um documento do processo (inicialmente o DFD), **quero** que minhas alterações sejam salvas automaticamente, que eu retome de onde parei e que nunca haja sobrescrita silenciosa do trabalho de colegas, **para** não perder trabalho por queda de conexão, recarga da página ou edição simultânea.

Esta story constrói o **mecanismo genérico de autosave** do produto e o aplica ao DFD: no servidor, a gravação de seção com controle de revisão (DOC-05, `If-Match: "s<revision>"`) e a gravação parcial do cabeçalho tipado com `ETag`/`If-Match` (DFD-04); no cliente, o hook `useAutosave`, o componente `AutosaveIndicator` (ambos em `packages/ui`), o diálogo de conflito (DEC-182), a contingência local cifrada em IndexedDB e a retomada do passo do wizard (`wizardStep`). O mesmo mecanismo é reutilizado pelo ETP (US-020, US-022, US-023), pelo TR (US-036) e pelos documentos livres (US-063), cada um com o seu endpoint de cabeçalho.

## Contexto
- A requisitante usa desktop compartilhado e conexão instável; perder um texto de justificativa é a principal fonte de retrabalho relatada. A persona pede "Salvo às 14:32" visível e sem jargão (P03).
- DEC-182 define o comportamento (debounce de 1,5 s e na perda de foco; "Salvando…/Salvo às HH:mm/Erro ao salvar"; diálogo "Ver diferenças", "Manter a minha versão", "Descartar a minha e recarregar"; rascunho local como contingência). DEC-055 define a concorrência por seção (conflito só quando duas pessoas editam a **mesma** seção) e DEC-104 o `ETag`/`If-Match`. DEC-017: autosave **não** cria versão. DEC-056: rich text validado no servidor e limitado a 1 MB por seção.
- Edição colaborativa em tempo real está fora do MVP 1 (PEND-12); o indicador "Fulano está editando" é a US-070 (P2), complementar a esta.
- A trilha de auditoria registra a edição de rascunhos de forma coalescida (`document.draft_update`, events.md §7) para não inundar a auditoria a cada pausa de digitação.

## Objetivo
Zero perda de texto em quedas de rede e recargas da aba; conflitos apenas quando a mesma seção (ou o mesmo campo do cabeçalho) é editada ao mesmo tempo; p95 da gravação de seção < 300 ms; 100% das sobrescritas após conflito registradas na auditoria.

## Persona
- **Principal:** Área requisitante — Cláudia Ferreira (`REQUISITANTE`), redatora do DFD.
- **Secundárias:** Consultoria externa — Bruno Carvalho (`CONSULTOR_EXTERNO`, participante `CONSULTANT`), que edita em paralelo; Planejamento — Marcos Vinícius Rocha (`PLANEJAMENTO`), usuário do mesmo mecanismo no ETP e no TR.

## Pré-condições
- DFD criado (US-014) em `DRAFT` ou `RETURNED`.
- Usuário atende POL-02 para o tipo (`DFD_UPDATE` + custódia ou participação `COLLABORATOR`/`CONSULTANT`; processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`; tipo permitido na etapa).
- Seções do documento inicializadas com `revision = 1` na criação (US-014).

## Fluxo principal
1. Ao abrir SCR-007, o cliente carrega DFD-03 (cabeçalho, `ETag: "<dfd.version>"`) e DOC-03 (`draftContent` com `revision` por seção) e posiciona o wizard em `Dfd.wizardStep`.
2. A usuária digita na seção "Justificativa da necessidade". O hook marca a seção como alterada e o indicador mostra "Alterações não salvas" (discreto).
3. Após 1,5 s sem digitação — ou ao sair do editor —, o hook envia `PUT /api/v1/documents/{documentId}/sections/JUSTIFICATION` (DOC-05) com `If-Match: "s3"` e `{ content, notApplicable: false, justification: null }`. O indicador mostra "Salvando…".
4. A API, em uma transação: autoriza (permissão de edição do tipo + POL-02); valida a chave na versão do template, o schema do editor, o tamanho e `maxChars`; executa a **atualização condicional atômica** do documento (status editável **e** revisão da seção igual à informada); deriva o estado (`EMPTY`/`FILLED`); incrementa a revisão da seção e `draftRevision`; registra a auditoria coalescida.
5. A API responde **200** com a seção (`state`, `revision = 4`, `updatedAt`, `updatedBy`) e `ETag: "s4"`. O indicador mostra "Salvo às 14:32".
6. Campos do cabeçalho (passos 1 e 3) seguem o mesmo ciclo: o hook agrupa os campos alterados e envia `PATCH /api/v1/dfds/{id}` (DFD-04) com `If-Match: "<version>"` e **apenas** os campos alterados (ex.: `{ "priority": "HIGH" }`). A API valida as regras de US-014 (RN-DFD-09 a RN-DFD-16), atualiza e devolve o novo `ETag`.
7. Quantidades na grade de itens usam DOC-07 (US-014) pelo mesmo hook (debounce, fila e conflito com *merge* por `processItemId`).
8. Na troca de passo, o hook descarrega as gravações pendentes e grava `{ wizardStep, completedSteps }` por DFD-04.
9. Ao reabrir o DFD (no dia seguinte, em outro computador), o wizard abre no último passo salvo. Se houver alterações locais pendentes deste usuário e documento, a faixa "Recuperamos alterações não salvas de 14:32." oferece **Restaurar** e **Descartar**.
10. Ao sair da página com gravações pendentes, o hook tenta descarregá-las; se ainda houver pendência, o navegador pede confirmação (`beforeunload`).

## Fluxos alternativos
- **FA-01 — Conflito na mesma seção:** DOC-05 responde 412 `SECTION_REVISION_CONFLICT` com a seção atual em `meta.current` (conteúdo, revisão, autor e horário). O autosave daquela seção é pausado e o diálogo oferece: **Ver diferenças** (comparação lado a lado do texto local × servidor, com "Alterado por Bruno Carvalho às 14:31"); **Manter a minha versão** (reenvia com `If-Match: "s<revisão atual>"` e `overwrittenRevision`, gerando nova revisão); **Descartar a minha e recarregar** (substitui pelo conteúdo do servidor e apaga a pendência local). As demais seções continuam salvando normalmente.
- **FA-02 — Conflito no cabeçalho:** DFD-04 responde 412 `VERSION_CONFLICT` com `meta.current`. Se os campos alterados localmente não foram alterados no servidor, o cliente reenvia automaticamente com o novo `ETag` (até 3 tentativas); se houver interseção, o diálogo mostra, por campo, "Minha alteração" × "Alteração de {nome} às HH:mm" para escolha.
- **FA-03 — Sem conexão, tempo esgotado ou 5xx:** o hook guarda a pendência na contingência local e retenta com *backoff* exponencial (2, 4, 8, 16 e 30 s, máximo 30 s); o indicador mostra "Sem conexão — alterações guardadas neste navegador". Ao reconectar, reenvia com a revisão-base; se receber 412, segue FA-01.
- **FA-04 — Limite de requisições (429):** respeita `Retry-After`, mantém "Salvando…" e coalesce as alterações acumuladas em uma única gravação.
- **FA-05 — Documento deixou de ser editável:** 409 `DOCUMENT_NOT_EDITABLE` (ex.: o DFD foi enviado para aprovação em outra aba). O autosave para, o conteúdo local é preservado e a faixa informa "Este documento não pode mais ser editado (Em revisão desde 14:40). Suas últimas alterações foram guardadas neste navegador." com o botão **Copiar meu texto**.
- **FA-06 — Perda de custódia ou processo suspenso:** 403 `NOT_PROCESS_CUSTODIAN` ou 409 `INVALID_PROCESS_STATUS` → mesmo tratamento de FA-05, com a mensagem específica.
- **FA-07 — Sessão expirada (401 `SESSION_EXPIRED`):** a pendência local é mantida; após novo login, a mesma aba oferece a restauração.
- **FA-08 — Restauração após recarga:** "Restaurar" aplica o conteúdo local apenas se a revisão-base local for igual à revisão atual do servidor; caso contrário, abre o diálogo de FA-01.
- **FA-09 — Conteúdo inválido ou grande demais:** 413 `PAYLOAD_TOO_LARGE`, 422 `RICH_TEXT_INVALID` ou 422 `VALIDATION_ERROR` (`TOO_LONG`) → "Erro ao salvar" com a explicação ("O texto excede 50.000 caracteres."); o conteúdo fica na contingência local e a seção volta a salvar quando for corrigida.
- **FA-10 — Mesma pessoa em duas abas:** a segunda aba recebe 412 e o diálogo identifica "Você mesma, em outra aba, às 14:31".
- **FA-11 — Reúso em outros tipos:** ETP (US-020/US-022/US-023 com ETP-04), TR (US-036 com TRM-04) e documentos livres (US-063 com DOC-04) montam o mesmo hook, trocando o endpoint de cabeçalho e a permissão de edição do tipo.

## Regras de negócio
- **RN-DFD-23** — Gatilhos do autosave: 1,5 s após a última alteração (DEC-182), perda de foco, troca de passo, atalho `Ctrl+S` ("salvar agora") e saída da página. Há no máximo **uma** requisição em voo por alvo (seção, cabeçalho ou itens); alterações feitas durante o voo entram em fila e seguem com a nova revisão.
- **RN-DFD-24** — Autosave **não** cria `DocumentVersion` (DEC-017): atualiza o rascunho (`revision` da seção e `draftRevision`). Versões só nascem em salvar versão (US-066), submissão, finalização, importação e reabertura.
- **RN-DFD-25** — Concorrência por seção (DEC-055): DOC-05 exige `If-Match: "s<revision>"`; revisão divergente → 412 `SECTION_REVISION_CONFLICT` com `meta.current`; ausência → 428 `PRECONDITION_REQUIRED`. Gravações em seções diferentes nunca conflitam.
- **RN-DFD-26** — DOC-05 **não** incrementa `Document.version`, reservada a metadados, itens e comandos de ciclo de vida (DOC-04, DOC-07, DOC-09 a DOC-14); assim, salvar uma seção não invalida o `If-Match` de quem está finalizando ou editando itens. A consistência entre gravação de seção e comando de ciclo de vida é garantida pela atualização condicional (status `DRAFT`/`RETURNED` verificado no mesmo `UPDATE`).
- **RN-DFD-27** — Cabeçalho do DFD (DFD-04): `PATCH` parcial dos campos editáveis (`requestDate`, `requestingDepartmentId`, `responsibleId`, `objectSummary`, `priority`, `expectedDate`, `estimatedValue`, `pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification`, `wizardStep`, `completedSteps`) com `If-Match: "<version>"`; `version` + 1 a cada gravação; `processId` e `documentId` não são editáveis (`NOT_ALLOWED`).
- **RN-DFD-28** — *Merge* automático no cliente (FA-02): sem interseção entre os campos alterados localmente e os alterados no servidor desde a base, reenvio silencioso; `wizardStep` segue "última gravação vence" e `completedSteps` é a união dos dois lados.
- **RN-DFD-29** — "Manter a minha versão" informa `overwrittenRevision` e gera nova revisão; a auditoria registra `conflictResolution = KEEP_MINE` imediatamente (sem coalescência). "Descartar a minha" não chama o servidor e apaga a pendência local.
- **RN-DFD-30** — Toda gravação reavalia POL-02: permissão de edição do tipo (`DFD_UPDATE`; para outros tipos `ETP_UPDATE`, `TERM_UPDATE`, `DOCUMENT_UPDATE`…), custódia ou participação `COLLABORATOR`/`CONSULTANT`, documento em `DRAFT`/`RETURNED`, tipo permitido na etapa e processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`.
- **RN-DFD-31** — Conteúdo de seção: chave existente na versão do template do documento (`SECTION_NOT_IN_TEMPLATE`); schema de `packages/editor` (nós desconhecidos → `RICH_TEXT_INVALID`); até 1 MB serializado (`PAYLOAD_TOO_LARGE`); texto até `maxChars` (padrão 50.000 — `TOO_LONG`). Estado derivado no servidor: `FILLED` quando há texto não vazio (sem espaços) ou tabela com conteúdo; `EMPTY` caso contrário; `NOT_APPLICABLE` conforme US-020. `minChars` não altera o estado — é checado na completude (`SECTION_TOO_SHORT`).
- **RN-DFD-32** — Limite de 60 gravações de seção por minuto por usuário e documento (api.md §1.6); o cliente não o atinge em uso normal (debounce + uma requisição em voo).
- **RN-DFD-33** — Contingência local (IndexedDB): guarda **somente** alterações pendentes ou com falha, na chave `cf:{tenantId}:{userId}:{documentId}:{alvo}` com a revisão-base; conteúdo cifrado com AES-GCM por chave não exportável gerada por sessão de aba (WebCrypto), cujo material de *wrapping* fica em `sessionStorage` — fechar a aba torna o rascunho local ilegível e ele é descartado no próximo início; validade de 24 h; apagado após gravação bem-sucedida, no logout e na troca de órgão; campos mascarados por POL-09 nunca são guardados localmente.
- **RN-DFD-34** — Retomada: SCR-007 abre em `Dfd.wizardStep`; se o passo salvo for `CONCLUSION` e houver pendência `BLOCKING`, abre `REVIEW`.
- **RN-DFD-35** — Auditoria coalescida (`document.draft_update`): no máximo 1 registro por (documento, alvo, usuário) a cada 10 min, controlado no Redis; cada registro informa `fromRevision` (primeira revisão ainda não auditada daquele usuário/alvo), `toRevision`, tamanho antes/depois e `windowMinutes = 10`. São sempre auditadas de imediato, com `changes`: alterações de campos estruturados do cabeçalho (datas, prioridade, setor, responsável, PCA, estimativa) e sobrescritas após conflito. Com o Redis indisponível, grava a cada salvamento (*fail-safe*). A criação de versão sempre registra o `contentHash` final.
- **RN-DFD-36** — Reenvio idêntico: gravação de seção cujo conteúdo (hash) e estado são iguais aos atuais é aceita como *no-op* (200 com a revisão atual, sem nova revisão e sem auditoria), mesmo com `If-Match` desatualizado — cobre reenvios após *timeout*.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Conteúdo da seção | `content` (DOC-05) | TipTap JSON | Sim (pode ser `null`) | RN-DFD-31 | Editor |
| Não se aplica | `notApplicable` (DOC-05) | booleano | Sim | Regras em US-020 (no DFD sempre `false`) | `false` |
| Justificativa de "não se aplica" | `justification` (DOC-05) | texto | Condicional | US-020 | `null` |
| Revisão sobrescrita | `overwrittenRevision` (DOC-05) | inteiro | Não | Só em "Manter a minha versão" | — |
| Pré-condição da seção | `If-Match: "s<revision>"` | cabeçalho HTTP | Sim | RN-DFD-25 | `revision` lido em DOC-03 |
| Pré-condição do cabeçalho | `If-Match: "<version>"` | cabeçalho HTTP | Sim | RN-DFD-27 | `ETag` de DFD-03/DFD-04 |
| Campos do cabeçalho | `requestDate` … `completedSteps` (DFD-04) | conforme US-014 | Parcial | RN-DFD-09 a RN-DFD-16 | Formulário |
| Passo atual | `wizardStep` | `DfdWizardStep` | — | RN-DFD-34 | `IDENTIFICATION` |
| Passos concluídos | `completedSteps` | `DfdWizardStep[]` | — | União no *merge* | `[]` |
| *(sistema)* Revisões | `draftContent.sections[k].revision`, `Document.draftRevision` | inteiro | — | +1 por gravação efetiva | 1 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `If-Match` ausente | API | "Recarregue a página para continuar editando." | `PRECONDITION_REQUIRED` |
| V-02 | Revisão da seção divergente | API | "Esta seção foi alterada por {nome} às {hora}." | `SECTION_REVISION_CONFLICT` |
| V-03 | Versão do cabeçalho divergente com campos em comum | API | "Outra pessoa alterou {campos}. Escolha qual valor manter." | `VERSION_CONFLICT` |
| V-04 | Chave de seção fora do template | API | "Esta seção não existe no modelo do documento." | `SECTION_NOT_IN_TEMPLATE` |
| V-05 | Conteúdo fora do schema do editor | API | "O texto contém formatação não permitida. Cole como texto simples." | `RICH_TEXT_INVALID` |
| V-06 | Seção acima de 1 MB | API | "O conteúdo desta seção é grande demais." | `PAYLOAD_TOO_LARGE` |
| V-07 | Texto acima de `maxChars` | Front + API | "O texto excede {maxChars} caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-08 | Documento fora de `DRAFT`/`RETURNED` | API | "Este documento não pode mais ser editado." | `DOCUMENT_NOT_EDITABLE` |
| V-09 | Tipo não permitido na etapa | API | "Este documento não pode ser editado na etapa atual." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-10 | Sem custódia nem participação | API | "Somente quem está com o processo (ou colaboradores) pode editar." | `NOT_PROCESS_CUSTODIAN` |
| V-11 | Processo suspenso/cancelado/concluído | API | "O processo está {status} e não permite alterações." | `INVALID_PROCESS_STATUS` |
| V-12 | Campo do cabeçalho inválido (regras de US-014) | Front + API | Mensagem do campo (US-014, V-06 a V-13) | `VALIDATION_ERROR` |
| V-13 | Campo não editável no PATCH | API | — (erro de integração) | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-14 | Excesso de gravações | API | — (tratado em silêncio) | `RATE_LIMITED` |

## Permissões
- **Permissão:** `DFD_UPDATE` com escopo que cubra o processo (ou concedida por participação `COLLABORATOR`/`CONSULTANT`); para outros tipos, a permissão de edição do tipo.
- **Políticas:** POL-02 em toda gravação (RN-DFD-30); POL-09 para `estimatedValue` em processo sigiloso (US-014, RN-DFD-16).
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** SCR-007 abre em modo leitura e o hook não é montado; chamadas diretas recebem 403 (`PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`) com `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | DOC-05 e DFD-04 não emitem eventos de domínio (api.md): salvar rascunho não é fato de negócio. A rastreabilidade é feita pela auditoria coalescida (RN-DFD-35) e, nos marcos, pelas versões |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Conflitos são tratados na própria tela (diálogo); presença de outros editores é US-070 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Autosave, retomada e conflito na edição do DFD

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o DFD "DFD 0005/2026" do processo "0012/2026" está em "DRAFT" com a seção "JUSTIFICATION" na revisão 3
    And "Cláudia" é a responsável atual do processo e possui "DFD_UPDATE"
    And "Bruno" é participante "CONSULTANT" do processo até "2026-12-31"

  Scenario: [Sucesso] Salvar a seção automaticamente após uma pausa na digitação
    When "Cláudia" digitar na seção "Justificativa da necessidade" e parar por 1,5 segundo
    Then o front deve enviar PUT para a seção "JUSTIFICATION" com "If-Match" igual a "s3"
    And a API deve responder 200 com a revisão 4 e "ETag" igual a "s4"
    And o indicador deve exibir "Salvo às" seguido do horário local
    And nenhuma versão do documento deve ser criada e a versão do documento deve permanecer a mesma
    And deve gerar registro de auditoria "document.draft_update" com "fromRevision" 4 e "toRevision" 4

  Scenario: [Sucesso] Retomar no passo em que parou
    Given que "Cláudia" deixou o DFD no passo "Planejamento" ontem
    When "Cláudia" abrir o DFD hoje em outro computador
    Then o wizard deve abrir no passo "Planejamento"

  Scenario: [Sucesso] Edição simultânea em seções diferentes não gera conflito
    When "Cláudia" salvar a seção "JUSTIFICATION" e "Bruno" salvar a seção "EXPECTED_RESULTS" ao mesmo tempo
    Then as duas gravações devem responder 200
    And nenhuma das duas deve exibir o diálogo de conflito

  Scenario: [Validação] Texto acima do limite da seção
    When "Cláudia" colar na seção "JUSTIFICATION" um texto com 50.001 caracteres
    Then o indicador deve exibir "Erro ao salvar" com a explicação "O texto excede 50.000 caracteres."
    And a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_LONG"
    And o conteúdo deve permanecer guardado neste navegador

  Scenario: [Validação] Gravação sem pré-condição
    When a seção for enviada sem o cabeçalho "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"

  Scenario: [Permissão] Usuária que perdeu a custódia
    Given que o processo foi atribuído a "Patrícia" enquanto "Cláudia" editava
    When o autosave de "Cláudia" enviar a seção "JUSTIFICATION"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    And deve gerar registro de auditoria "access.denied" com reasonCode "POL-02"
    And o autosave deve parar e a faixa deve oferecer "Copiar meu texto"

  Scenario: [Permissão] DFD enviado para aprovação em outra aba
    Given que o DFD passou a "IN_REVIEW" às 14:40
    When o autosave enviar uma alteração pendente
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    And a faixa deve informar "Este documento não pode mais ser editado (Em revisão desde 14:40)."

  Scenario: [Tenant incorreto] Seção de documento de outro tenant
    Given que existe um documento no tenant "Prefeitura de Santa Luzia"
    When "Cláudia" enviar PUT para uma seção desse documento
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado de nenhum tenant deve ser alterado

  Scenario: [Duplicidade] Reenvio idêntico após tempo esgotado
    Given que a gravação da revisão 4 foi aplicada, mas a resposta não chegou ao navegador
    When o front reenviar o mesmo conteúdo com "If-Match" igual a "s3"
    Then a API deve responder 200 com a revisão 4, sem criar a revisão 5
    And nenhum diálogo de conflito deve ser exibido

  Scenario: [Concorrência] Duas pessoas editam a mesma seção
    Given que "Cláudia" e "Bruno" abriram a seção "JUSTIFICATION" na revisão 5
    When "Bruno" salvar primeiro, gerando a revisão 6
    And "Cláudia" salvar em seguida com "If-Match" igual a "s5"
    Then a API deve responder 412 com código "SECTION_REVISION_CONFLICT" e a revisão 6 de "Bruno" em "meta.current"
    And "Cláudia" deve ver o diálogo com "Ver diferenças", "Manter a minha versão" e "Descartar a minha e recarregar"
    When "Cláudia" escolher "Manter a minha versão"
    Then a seção deve ficar na revisão 7 com o texto de "Cláudia"
    And deve gerar registro de auditoria "document.draft_update" com "conflictResolution" igual a "KEEP_MINE" e "overwrittenRevision" igual a 6

  Scenario: [Concorrência] Conflito de cabeçalho em campos diferentes é mesclado
    Given que "Cláudia" e "Bruno" carregaram o DFD na versão 8
    When "Bruno" alterar a previsão e "Cláudia" alterar a prioridade com "If-Match" igual a "8"
    Then a gravação de "Cláudia" deve receber 412 "VERSION_CONFLICT" e ser reenviada automaticamente com "If-Match" igual a "9"
    And o DFD deve terminar na versão 10 com a previsão de "Bruno" e a prioridade de "Cláudia"

  Scenario: [Falha de banco] Banco indisponível durante a gravação
    Given que o banco de dados está indisponível
    When o autosave enviar a seção "JUSTIFICATION"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o conteúdo deve ser guardado cifrado neste navegador e retentado com backoff
    And quando o banco voltar a seção deve ser salva sem intervenção de "Cláudia"

  Scenario: [Falha de integração] Queda de rede e recarga da página
    Given que "Cláudia" está sem conexão
    When "Cláudia" editar a seção "EXPECTED_RESULTS" e recarregar a aba
    Then a faixa "Recuperamos alterações não salvas" deve ser exibida com "Restaurar" e "Descartar"
    When a conexão voltar e "Cláudia" escolher "Restaurar"
    Then a seção deve ser salva com a revisão seguinte à revisão-base

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Cláudia" salvar a seção "JUSTIFICATION" três vezes em 2 minutos
    Then as três gravações devem responder 200
    And devem existir três registros de auditoria "document.draft_update"
    And deve ser registrado log "warn" "audit.coalesce_store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Revisão de seção divergente | 412 | `SECTION_REVISION_CONFLICT` | "Esta seção foi alterada por {nome} às {hora}." | Pausa a seção e abre o diálogo de conflito |
| Versão do cabeçalho divergente | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou {campos}." | *Merge* automático ou diálogo por campo |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página para continuar editando." | Recarrega os dados e reaplica a pendência |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este documento não pode mais ser editado." | Para o autosave; "Copiar meu texto" |
| Sem custódia/participação | 403 | `NOT_PROCESS_CUSTODIAN` | "Somente quem está com o processo pode editar." | Para o autosave; mostra o responsável atual |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "O processo está {status} e não permite alterações." | Modo leitura |
| Conteúdo inválido/grande | 422 / 413 | `RICH_TEXT_INVALID` / `PAYLOAD_TOO_LARGE` | Ver V-05/V-06 | "Erro ao salvar"; mantém conteúdo local |
| Limite excedido | 429 | `RATE_LIMITED` | — | Aguarda `Retry-After`; coalesce |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Mantém pendência local; retorna ao DFD após o login |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Sem conexão com o servidor — alterações guardadas neste navegador." | *Backoff* e reenvio |

## Dependências
- **Stories:** US-014 (criação, campos e regras do DFD), US-065 (ciclo de vida e editabilidade), US-073 (auditoria), US-081 (concorrência otimista), US-086 (shell web e `packages/ui`), US-097 (POL-02). Complementar: US-070 (presença, P2). Consumidoras: US-020, US-022, US-023, US-036, US-063.
- **Decisões/ADRs:** DEC-017, DEC-055, DEC-056, DEC-104, DEC-131, DEC-138, DEC-182; PEND-08, PEND-12; ADR-006.
- **Configurações:** nenhuma chave de tenant (o debounce de 1,5 s e a janela de 10 min da auditoria são fixos por decisão).
- **Lacunas nas fontes canônicas:**
  1. entities.md diz que `version` é incrementada a cada alteração; para cumprir DEC-055 (conflito apenas por seção), DOC-05 não incrementa `Document.version` (RN-DFD-26) — registrar a exceção em entities.md §1.1.
  2. O mecanismo de coalescência de `document.draft_update` frente à auditoria *append-only* não está descrito (events.md §7); proposta de RN-DFD-35 (janela no Redis, faixa de revisões, *fail-safe*).
  3. O contrato de DOC-05 (corpo `{ content, notApplicable, justification, overwrittenRevision? }` e `meta.current` no 412) não está em api.md §4.

## Impacto técnico
- **Atualização condicional atômica** em vez de `SELECT … FOR UPDATE`: um único `UPDATE … SET draft_content = jsonb_set(…)` com as condições de status, `deleted_at` e revisão da seção; zero linhas afetadas → leitura de diagnóstico para distinguir 404, 409 e 412. Evita reescrever o JSON inteiro e mantém a transação curta.
- **Hook genérico:** `useAutosave` não conhece o tipo de documento — recebe `save(payload, etag)`, `getEtag()`, `onConflict(current)` e o armazenamento local; a fila por alvo garante ordem e uma requisição em voo.
- **Segurança local:** cifragem por sessão de aba evita que o texto fique legível em computador compartilhado após fechar a aba; nada de valores sigilosos no navegador.
- **Volume de auditoria:** coalescência reduz em ~90% os registros de rascunho em sessões típicas sem perder a trilha (as versões registram o hash final).
- **Compatibilidade:** os endpoints de cabeçalho de ETP (ETP-04), TR (TRM-04) e documento livre (DOC-04) devem seguir o mesmo contrato de `PATCH` parcial com `If-Match`.

## Backend
- **Módulo(s):** `document` (gravação genérica de seção — dono de `Document`), `dfd` (cabeçalho), `audit` (`AuditService` + `DraftAuditCoalescer`), `platform` (Redis, *rate limit*).
- **Casos de uso:** `SaveDocumentSectionCommand` → `SaveDocumentSectionHandler` (genérico, usado por todos os tipos); `PatchDfdHeaderCommand` → `PatchDfdHeaderHandler`; `GetDocumentQuery` (DOC-03).
- **Domínio:** `SectionDraft.apply(content, notApplicable, justification)` (deriva estado; RN-DFD-31/36); `ContentLimits` (lê `maxChars`/`minChars` da versão do template); `DfdHeaderPatch` (valida campos e imutáveis).
- **Integrações internas:** `TemplateFacade.getSectionDefinition(templateVersionId, key)`; `DocumentEditPolicy` (POL-02) do módulo `access`; `packages/editor` (`validateDoc`, `toPlainText`, `byteSize`).
- **Transação:** atualização condicional + auditoria (quando devida) na mesma transação; a janela de coalescência é consultada no Redis antes de abrir a transação (`SET NX EX 600`).

## Frontend
- **Tela(s):** SCR-007 (todos os passos editáveis); reutilizado em SCR-008, SCR-012 e SCR-105.
- **Componentes (`packages/ui`):** `useAutosave` (`debounceMs = 1500`, fila por alvo, *backoff*, integração com `LocalDraftStore`), `AutosaveIndicator` (estados "Alterações não salvas", "Salvando…", "Salvo às HH:mm", "Erro ao salvar", "Sem conexão — alterações guardadas neste navegador"), `ConflictDialog` com `SectionDiffView` (diff de texto por parágrafo), `HeaderConflictDialog` (por campo), `RecoveredDraftBanner`, `useWizardResume`.
- **Dados:** TanStack Query com atualização otimista da seção e reconciliação pela resposta; `ETag`/revisões guardados por alvo; invalidação de `['t', tenantId, 'documents', documentId, 'validation']` com *debounce* de 2 s após gravações.
- **Estados:** indicador sempre visível no cabeçalho do wizard; faixa de modo leitura (FA-05/06); faixa de recuperação (FA-08).
- **Acessibilidade:** indicador em região `aria-live="polite"` (anuncia "Salvo" sem interromper); diálogo de conflito com *focus trap*, título descritivo e botões com textos completos; diff legível por leitor de tela (marcações "inserido"/"removido" em texto, não só cor).
- **Responsivo:** indicador compacto (ícone + "Salvo") abaixo de 768 px; diálogo de conflito em tela cheia no celular.

## Banco de dados
- **Tabelas escritas:** `documents` (`draft_content`, `draft_revision`, `updated_at`, `updated_by_id`), `dfds` (cabeçalho, `version`), `audit_logs`.
- **Migrações:** nenhuma tabela nova. Função SQL utilitária opcional `cf_section_revision(draft_content, key)` para a condição de revisão.
- **Comando de referência (seção):**
```sql
UPDATE documents
   SET draft_content = jsonb_set(draft_content, ARRAY['sections', $key], $section::jsonb),
       draft_revision = draft_revision + 1, updated_at = now(), updated_by_id = $user
 WHERE tenant_id = $tenant AND id = $document AND deleted_at IS NULL
   AND status IN ('DRAFT','RETURNED')
   AND COALESCE((draft_content #>> ARRAY['sections', $key, 'revision'])::int, 0) = $expectedRevision
RETURNING draft_revision;
```

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-05 | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | `{ content, notApplicable, justification, overwrittenRevision? }` + `If-Match: "s<revision>"` | `200 { data: { sectionKey, state, revision, updatedAt, updatedBy, draftRevision } }` + `ETag: "s<revision>"` | 200, 403, 404, 409, 412, 413, 422, 428, 429, 503 |
| DFD-04 | PATCH | `/api/v1/dfds/{id}` | Campos alterados do cabeçalho (RN-DFD-27) + `If-Match: "<version>"` | `200 { data: Dfd }` + `ETag` | 200, 403, 404, 409, 412, 422, 428 |
| DFD-03 / DOC-03 | GET | `/api/v1/dfds/{id}` · `/api/v1/documents/{id}` | — | Cabeçalho com `ETag` · `draftContent` com `revision` por seção | 200, 404 |
| DOC-07 | PUT | `/api/v1/documents/{id}/items` | Ver US-014 | Ver US-014 | Ver US-014 |

Exemplo de 412 em DOC-05:
```json
{
  "type": "https://docs.contrataflow.com.br/errors/section-revision-conflict",
  "title": "A seção foi alterada por outra pessoa",
  "status": 412,
  "detail": "A seção \"Justificativa da necessidade\" foi alterada por Bruno Carvalho às 14:31.",
  "code": "SECTION_REVISION_CONFLICT",
  "correlationId": "c-9d2e41",
  "meta": { "current": { "sectionKey": "JUSTIFICATION", "state": "FILLED", "revision": 6, "content": { "type": "doc", "content": [] }, "updatedAt": "2026-10-05T17:31:02Z", "updatedBy": { "id": "0192…", "name": "Bruno Carvalho" } } }
}
```

## Logs
- `debug` `document.section_saved` — `documentId`, `sectionKey`, `revision`, `sizeBytes`, `durationMs`.
- `info` `document.section_conflict` — `documentId`, `sectionKey`, `expectedRevision`, `currentRevision`.
- `info` `dfd.header_saved` — `dfdId`, `changedFields` (nomes), `version`.
- `warn` `audit.coalesce_store_unavailable` — Redis indisponível (auditoria a cada gravação).
- `error` `document.section_save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções, valores dos campos do cabeçalho, justificativas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.draft_update` | `DATA_CHANGE` | Seção ou campos de texto do cabeçalho, coalescida (RN-DFD-35) | `metadata`: `target` (`SECTION:<CHAVE>`, `HEADER`, `ITEMS`), `fromRevision`, `toRevision`, `sizeBytesBefore`, `sizeBytesAfter`, `windowMinutes`; texto nunca registrado (hash + tamanho) |
| `document.draft_update` | `DATA_CHANGE` | Campo estruturado do cabeçalho (imediato) | `changes`: `[{ path, old, new }]` (estimativa mascarada se sigilosa) |
| `document.draft_update` | `DATA_CHANGE` | "Manter a minha versão" (imediato) | `metadata`: `conflictResolution = KEEP_MINE`, `overwrittenRevision`, `overwrittenAuthorId` |
| `access.denied` | `ACCESS` | POL-02 negada | `reasonCode` |

## Testes necessários
- **Unitários:** fila por alvo e debounce (relógio simulado); *merge* de cabeçalho (disjunto, interseção, `completedSteps`); derivação de estado (RN-DFD-31) e *no-op* idêntico (RN-DFD-36); janela de coalescência; cifragem/expiração do `LocalDraftStore`.
- **Integração (Testcontainers PostgreSQL + Redis):** atualização condicional sob 50 gravações concorrentes na mesma seção (exatamente uma por revisão); seções diferentes sem conflito; `Document.version` inalterada após DOC-05; auditoria coalescida com relógio simulado e *fail-safe* com Redis parado.
- **API/contrato:** DOC-05 e DFD-04 com 200/412/428/409/413/422; corpo de 412 com `meta.current`.
- **RBAC e multi-tenant:** custodiante, colaborador, consultor, usuário sem custódia, `SOMENTE_LEITURA`; documento de outro tenant → 404 (suíte "tenant leak").
- **E2E (Playwright):** autosave com indicador; `context.setOffline(true)` + recarga + restauração; conflito com dois contextos de navegador e as três opções do diálogo; retomada do passo.
- **Acessibilidade/performance:** anúncio do indicador por leitor de tela; diálogo navegável por teclado; k6 com 60 gravações/min por documento → p95 < 300 ms, 0 erros.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] POL-02 reavaliada em toda gravação; modo leitura quando não editável
- [ ] Concorrência por seção e por cabeçalho comprovada por testes de carga concorrente
- [ ] Auditoria coalescida e registros imediatos verificados em teste (incluindo *fail-safe*)
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de DOC-05 e DFD-04 compatível com api.md
- [ ] Logs sem conteúdo de documentos; métricas `document_section_saves_total`, `document_section_conflicts_total`
- [ ] `useAutosave`, `AutosaveIndicator` e `ConflictDialog` publicados em `packages/ui` com documentação de uso para ETP, TR e documentos livres
- [ ] Revisão de código e de segurança aprovadas (incluindo a cifragem local)

## Estimativa
**M** — dois endpoints de gravação com concorrência otimista e um conjunto de componentes de cliente (fila, *backoff*, contingência cifrada, diálogo de conflito com diff) reutilizáveis; a complexidade está na robustez e nos testes de concorrência, não no volume de telas.

## Prioridade
**P0** — sem autosave confiável o DFD, o ETP e o TR perdem conteúdo e geram retrabalho; é pré-requisito de US-016, US-020 e US-036.
