---
id: US-158
title: "Gerenciar checklists versionados do Controle Interno"
epic: EP-026
feature: FT-076
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-097, US-103]
modules: [internal-control, rules, tenancy, access, audit, platform]
screens: [SCR-119]
endpoints: [ICT-01, ICT-02, ICT-03, ICT-04, ICT-05, ICT-06, ICT-07]
permissions: [INTERNAL_CONTROL_CHECKLIST_MANAGE, INTERNAL_CONTROL_REVIEW_VIEW, PROCESS_VIEW]
events: [InternalControlChecklistPublished, TenantSettingsChanged]
---

# US-158 — Gerenciar checklists versionados do Controle Interno

## Título
Gerenciar checklists versionados do Controle Interno

## Descrição
**Como** administrador do órgão (ou analista do Controle Interno com a permissão de gerenciar modelos), **quero** criar, duplicar, editar, publicar e aposentar versões de modelos de checklist, com itens, base legal, obrigatoriedade, dica de evidência, regra de sugestão de resposta e regra de aplicabilidade, e pré-visualizar o modelo como será respondido, **para** que o órgão tenha o seu próprio roteiro de verificação, aplicado do mesmo jeito a todo processo, e que mudanças de critério fiquem datadas e auditáveis sem reescrever o que já foi analisado.

A story entrega a administração dos modelos (`InternalControlChecklist`, SCR-119, `/admin/controle-interno/checklists`): ciclo `DRAFT` para `PUBLISHED` para `RETIRED`, imutabilidade da versão publicada, um rascunho por chave, um modelo padrão por tenant, validação das regras contra o `RuleContext` v2, a pré-visualização (ICT-07), a projeção da chave padrão em `internalControl.defaultChecklistKey` e a semente `FASE_PREPARATORIA` v1 por tenant, inclusive os já existentes. **Não** entrega a abertura da manifestação nem a escolha do checklist aplicado ao processo (fixado na abertura, US-159) nem a resposta aos itens (US-160). Não há IA no controle interno (RN-ICT-20).

## Contexto
- A DEC-200 cria o checklist como modelo configurável por tenant e versionado: cada linha de `internal_control_checklists` é uma versão (`key` + `versionNumber`), com `status` `DRAFT`, `PUBLISHED` ou `RETIRED` (`TemplateVersionStatus`), `items` (`ChecklistItem[]`, 1..200), `applicabilityRule` (`RuleRef`), `isDefault`, `publishedAt` e `publishedById`. A versão publicada é imutável (trigger); mudar é criar nova versão.
- A manifestação **fixa** a versão publicada na abertura (`InternalControlReview.checklistId`, US-159): publicar, aposentar ou trocar o padrão depois não muda uma análise em curso (RN-ICT-05). O padrão é o mesmo que o MVP 1 usa para templates de documento (US-107/US-108): rascunho, validação completa na publicação, sem efeito retroativo.
- O princípio 17 proíbe regra legal ou administrativa fixa em código: o conteúdo do checklist é configuração semeada e editável, "a validar com o piloto" (overview §7). O `RuleContext` v2 (DEC-204, US-129) fornece os caminhos que `autoCheck` e `applicabilityRule` podem ler (`pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*`, além dos da v1); o executor é o mesmo `RuleEvaluator` com a *allowlist* de operadores do ADR-008.
- `autoCheck` apenas **sugere** a resposta (`COMPLIANT` ou `NON_COMPLIANT`) a quem preenche o checklist; a resposta é sempre humana (RN-ICT-03, DEC-200). Valores de orçamento sigiloso entram na avaliação no servidor, mas nunca saem em prévias, mensagens, eventos, auditoria ou logs para quem não tem POL-09 (DEC-030).
- A permissão `INTERNAL_CONTROL_CHECKLIST_MANAGE` é de risco `H` (MFA conforme `security.mfaPolicy`), sem escopo, e é concedida a `ADMIN_ORGAO` e `CONTROLE_INTERNO` (permissions.md); `INTERNAL_CONTROL_REVIEW_VIEW` (Gestor de contratações, Controle Interno, Autoridade e Auditor) lê o modelo aplicado, sem acessar rascunhos.
- A chave padrão do tenant é `internalControl.defaultChecklistKey` (padrão `FASE_PREPARATORIA`, entities.md §8); o modelo `FASE_PREPARATORIA` v1 é semeado por tenant, inclusive nos existentes, respeitando customizações (entities.md §9, M2-21).

## Objetivo
Garantir que 100% das manifestações abertas encontrem um checklist `PUBLISHED` para fixar (todo tenant tem exatamente um modelo padrão publicado), que nenhuma versão publicada seja alterada depois de publicada e que um administrador publique uma nova versão em até 3 cliques a partir da duplicação da anterior, com a listagem (ICT-01) abrindo em p95 < 500 ms.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `INTERNAL_CONTROL_CHECKLIST_MANAGE`.
- **Secundárias:** Analista do Controle Interno (`CONTROLE_INTERNO`, também gerencia os modelos); Auditor (`AUDITOR`, lê versões e histórico); Gestor de contratações e Autoridade (leem o modelo aplicado, `INTERNAL_CONTROL_REVIEW_VIEW`); Sistema (ator `SYSTEM`: semente incremental).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, com `INTERNAL_CONTROL_CHECKLIST_MANAGE` e sessão com MFA conforme `security.mfaPolicy` para as escritas (permissão `H`).
- Para publicar: versão em `DRAFT` válida (RN-ICT-26) e, se for marcada como padrão com outro padrão vigente, a confirmação de troca (RN-ICT-28).
- Para pré-visualizar com processo: `PROCESS_VIEW` cobrindo o processo informado (DEC-024).
- Catálogo do `RuleContext` v2 registrado (US-129); sem ele a validação das regras de publicação não roda.

## Fluxo principal
1. O administrador abre **Administração › Checklists do Controle Interno** (SCR-119); o front carrega `ICT-01` e mostra os modelos agrupados por chave, com as versões (número, situação, padrão, itens, publicação) e quantas manifestações abertas usam cada uma.
2. Para mudar um critério, aciona **"Nova versão"** na versão publicada; o front envia `ICT-02` (`fromChecklistId`) com `Idempotency-Key`. A API cria um rascunho da mesma chave, com `versionNumber` seguinte, copiando itens, regra de aplicabilidade e indicação de padrão (RN-ICT-22), e responde 201 com `ETag`.
3. No editor, ele acrescenta, altera, reordena e remove itens (grupo, pergunta, base legal, obrigatoriedade, dica de evidência, regra de sugestão), ajusta a regra de aplicabilidade e salva (`ICT-04`, `If-Match`); o rascunho pode ficar incompleto (RN-ICT-23).
4. Aciona **"Pré-visualizar"** (`ICT-07`): sem processo, vê o formulário como o analista o verá; escolhendo um processo, vê também a aplicabilidade e a resposta sugerida por item (sem valores).
5. Aciona **"Publicar"**; o diálogo resume a mudança (itens acrescentados, alterados e removidos em relação à publicada), informa se a versão é o padrão e avisa que a versão anterior da chave será aposentada, sem afetar análises em curso. O front envia `ICT-05` (`If-Match`, `Idempotency-Key`, `confirmReplaceDefault?`).
6. A API valida por inteiro (RN-ICT-26); sem violações, em uma transação: trava as versões da chave, marca a nova como `PUBLISHED` (`publishedAt`, `publishedById`), aposenta a anterior publicada da mesma chave, ajusta o padrão e a chave `internalControl.defaultChecklistKey` (RN-ICT-27 a RN-ICT-29), grava a auditoria `internal_control_checklist.publish` e o evento `InternalControlChecklistPublished` (outbox).
7. O front exibe "Versão {n} publicada. As análises em andamento continuam com a versão {n-1}." e a próxima manifestação aberta já usa a nova versão (US-159).
8. Mais adiante o administrador pode **aposentar** uma versão publicada que não seja o padrão (`ICT-06`): ela deixa de ser escolhida em novas manifestações, mas segue legível e usada pelas análises que a fixaram.

## Fluxos alternativos
- **FA-01 — Criar um modelo novo:** `ICT-02` com `key` inexistente cria a versão 1 em `DRAFT`; `key` já usada responde 409 `INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN` (RN-ICT-22). Também é possível copiar uma versão para outra chave (`fromChecklistId` com `key` e `name` novos), nascendo a versão 1.
- **FA-02 — Rascunho já existente para a chave:** `ICT-02` para nova versão responde 409 `INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS` com `meta.draftId`; a UI abre o rascunho existente (RN-ICT-21).
- **FA-03 — Editar versão publicada ou aposentada:** `ICT-04` responde 409 `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT` e a UI orienta "Crie uma nova versão para alterar este checklist" (RN-ICT-25).
- **FA-04 — Publicação inválida:** `ICT-05` responde 422 `INTERNAL_CONTROL_CHECKLIST_INVALID` com `errors[]` por item e por regra (sem item obrigatório, mais de 200 itens, chave de item duplicada, caminho ou operador não permitido, padrão com regra de aplicabilidade); nada é gravado e o painel de validação leva ao ponto (RN-ICT-26).
- **FA-05 — Trocar o padrão:** publicar como padrão uma chave diferente do padrão vigente exige `confirmReplaceDefault: true`; sem ele, 409 `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT` com `meta.currentDefault`; com ele, o anterior deixa de ser padrão (continua publicado, aplicável só por regra) (RN-ICT-28).
- **FA-06 — Nova versão da chave que é o padrão:** a nova versão herda a indicação de padrão; ao publicar, a anterior é aposentada e a nova passa a ser a padrão na mesma transação, sem janela sem padrão (RN-ICT-28).
- **FA-07 — Aposentar o padrão:** `ICT-06` responde 409 `INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT`; para substituí-lo, publica-se outra versão como padrão (RN-ICT-30).
- **FA-08 — Aposentar com manifestações abertas:** permitido; a resposta traz `openReviewsCount` e a UI informou antes "N análises em andamento continuam com esta versão" (RN-ICT-31).
- **FA-09 — Pré-visualizar rascunho incompleto ou aposentado:** funciona em qualquer situação; regras inválidas dão sugestão vazia com o motivo, sem bloquear a prévia (RN-ICT-32).
- **FA-10 — Pré-visualizar com processo de orçamento sigiloso sem POL-09:** a sugestão que depende de valor sigiloso sai vazia com o motivo `CONFIDENTIAL_INPUT`; nenhum valor é devolvido (RN-ICT-32).
- **FA-11 — Tenant sem o modelo semeado:** a semente incremental cria `FASE_PREPARATORIA` v1 padrão; se o tenant já tem a chave (customizada ou não), nada é alterado (RN-ICT-34).
- **FA-12 — Auditor ou analista só com leitura:** vê versões `PUBLISHED` e `RETIRED` e o histórico; rascunhos respondem 404 (RN-ICT-33).

## Regras de negócio
- **RN-ICT-01** — Versão `PUBLISHED` ou `RETIRED` é imutável (trigger no banco); só mudam `status` e a data de aposentadoria (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-02** — Há no máximo um rascunho por chave e um único modelo padrão publicado por tenant; publicar um novo padrão exige aposentar ou desmarcar o anterior (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-03** — O modelo tem de 1 a 200 itens, com `key` única dentro do modelo; `autoCheck` apenas **sugere** a resposta, nunca a grava (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-04** — Publicar exige ao menos um item obrigatório e validação das regras de `autoCheck` e de aplicabilidade contra o `RuleContext` v2 (DEC-200, DEC-204). *(regra da feature, adotada)*
- **RN-ICT-05** — Aposentar uma versão não afeta manifestações abertas, que mantêm a versão fixada na abertura (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-06** — Criar, publicar e aposentar exigem `INTERNAL_CONTROL_CHECKLIST_MANAGE` (permissão `HIGH`, com MFA) e geram auditoria de configuração (DEC-200). *(regra da feature, adotada)*
- **RN-ICT-20** — Não há geração por IA no controle interno: nem os itens, nem as sugestões, nem a manifestação (DEC-200, DEC-202). *(regra da feature, adotada)*
- **RN-ICT-21** — Identidade: `key` (1..60, `^[A-Z][A-Z0-9_]{2,59}$`) e `versionNumber` formam a identidade única `(tenant_id, key, version_number)`; `versionNumber` é sequencial por chave (`max + 1`, nunca reaproveitado) e `key` não muda depois de criada. Há no máximo um `DRAFT` por `(tenant_id, key)` (`UNIQUE … WHERE status = 'DRAFT'`); duas criações simultâneas resultam em uma 201 e uma 409 `INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS`.
- **RN-ICT-22** — Criar (`ICT-02`) tem dois modos, ambos com `Idempotency-Key`: **novo modelo** (`key` inexistente, `name`, itens opcionais; nasce a versão 1) e **duplicar** (`fromChecklistId` de qualquer versão do tenant, em qualquer situação; sem `key`, cria o próximo rascunho da mesma chave; com `key` diferente e `name`, cria a versão 1 da chave nova). A cópia leva `items`, `applicabilityRule` e `isDefault` da origem (a indicação só vale quando a versão for publicada); `status = DRAFT`, `publishedAt` e `publishedById` nulos. `key` já em uso por modelo novo responde 409 `INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN`.
- **RN-ICT-23** — Editar (`ICT-04`) só no `DRAFT`, com `If-Match`; altera `name` (1..150), `items` (lista completa substitui a anterior), `applicabilityRule` (`RuleRef` ou nulo) e `isDefault`; `key`, `versionNumber`, `status` e datas não são editáveis. Salvar é **tolerante**: aceita rascunho incompleto (inclusive sem item obrigatório e com regra ainda não avaliável) e valida só a forma (Zod: tipos, tamanhos, `key` de item única, máx. 200 itens, `RuleRef` bem formado); a validação completa é a da publicação.
- **RN-ICT-24** — Item (`ChecklistItem`, entities.md §7.6): `key` 1..60 `^[A-Z][A-Z0-9_]{0,59}$` (única no modelo e estável entre versões, pois as respostas e os achados a referenciam); `group` 1..80; `question` 5..500; `legalBasis` até 200; `required` booleano; `evidenceHint` até 300; `autoCheck` opcional (`RuleRef`). A ordem do vetor é a ordem de exibição; os grupos aparecem na ordem da primeira ocorrência. Textos são texto puro (sem HTML), aparados nas pontas.
- **RN-ICT-25** — Imutabilidade: `PATCH` em versão `PUBLISHED` ou `RETIRED` responde 409 `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT` com a orientação de criar nova versão; o trigger do banco rejeita qualquer `UPDATE` de colunas de conteúdo (`name`, `items`, `applicabilityRule`, `isDefault`, `key`, `versionNumber`) fora do `DRAFT` e permite apenas a passagem `PUBLISHED` para `RETIRED` com `retiredAt`.
- **RN-ICT-26** — Validação de publicação (`ICT-05`), reexecutada por inteiro e sem efeito parcial: 1..200 itens; ≥ 1 item `required`; `key` de item única e no formato; regras (`autoCheck` e `applicabilityRule`) com `contextVersion = 2` (INLINE) ou referência `LIBRARY` a versão publicada de regra compatível; caminhos de variável existentes no schema do `RuleContext` v2 (`WF_RULE_PATH_UNKNOWN`), operadores dentro da *allowlist* do ADR-008, profundidade ≤ 20 e tamanho ≤ 10 KB (`WF_RULE_OPERATOR_FORBIDDEN`); cada regra avaliável sem erro sobre o contexto neutro do schema (`CHECKLIST_RULE_NOT_EVALUABLE`); modelo padrão sem `applicabilityRule` (`CHECKLIST_DEFAULT_WITH_RULE`). Qualquer violação responde 422 `INTERNAL_CONTROL_CHECKLIST_INVALID` com `errors[]` (`code`, `itemKey?`, `path?`, mensagem) e nada muda.
- **RN-ICT-27** — Efeitos da publicação, numa transação com `app.tenant_id` e trava por `(tenant, key)`: `status = PUBLISHED`; `publishedAt`/`publishedById`; a versão `PUBLISHED` anterior da mesma chave (se houver) vai a `RETIRED` com `retiredAt` (há no máximo uma versão publicada por chave); ajuste do padrão (RN-ICT-28); auditoria `internal_control_checklist.publish` (`metadata`: `key`, `versionNumber`, `itemsCount`, `requiredItemsCount`, `retiredVersionNumber?`, `isDefault`, `defaultKeyChange?`); evento `InternalControlChecklistPublished` pelo outbox; novo `ETag`. Publicar uma versão já `PUBLISHED` ou `RETIRED` responde 409 `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT`.
- **RN-ICT-28** — Modelo padrão: no máximo uma versão `PUBLISHED` com `isDefault = true` por tenant (`UNIQUE (tenant_id) WHERE is_default AND status = 'PUBLISHED'`), usada quando nenhum outro modelo se aplica ao processo; por isso o padrão não tem `applicabilityRule`. Ao publicar com `isDefault = true`: (a) se a mesma chave já era a padrão, a nova a substitui na mesma transação; (b) se outra chave é a padrão, exige `confirmReplaceDefault: true` (senão 409 `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT`, `meta.currentDefault` com chave e versão) e o padrão anterior apenas deixa de ser padrão (`isDefault` passa a `false` por meio da passagem controlada do trigger de imutabilidade; segue `PUBLISHED`). Publicar sem `isDefault` uma versão cuja chave era a padrão responde 409 `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT` (o tenant ficaria sem padrão); marcar outro modelo como padrão é o caminho.
- **RN-ICT-29** — A chave `internalControl.defaultChecklistKey` é a **projeção** da chave do padrão publicado: a publicação (RN-ICT-28) a atualiza na mesma transação, publica `TenantSettingsChanged` (invalida o cache de configurações) e registra a mudança em `metadata.defaultKeyChange` da auditoria da publicação; `SET-02` não altera esta chave (422 `VALIDATION_ERROR`, `READ_ONLY`), de modo que setting e `isDefault` nunca divergem. Nunca se escolhe uma chave sem versão publicada.
- **RN-ICT-30** — Aposentar (`ICT-06`) exige `PUBLISHED` (senão 409 `INVALID_STATE`) e que a versão **não** seja o padrão (409 `INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT`); define `RETIRED` e `retiredAt`, grava a auditoria `internal_control_checklist.retire` e não publica evento de domínio. Versão aposentada não é escolhida em novas manifestações, mas segue legível, pré-visualizável e usável como origem de duplicação.
- **RN-ICT-31** — Sem efeito retroativo: publicar, aposentar ou trocar o padrão nunca altera `InternalControlReview.checklistId`, respostas nem achados já registrados; a manifestação em andamento continua com a versão fixada, e `openReviewsCount` (derivado: análises `PENDING` ou `IN_REVIEW` que fixaram a versão) informa o alcance antes de aposentar. A escolha do modelo na abertura (primeiro cuja aplicabilidade é verdadeira; senão o padrão) é da US-159.
- **RN-ICT-32** — Pré-visualização (`ICT-07`): qualquer situação da versão, sem persistir nada. Sem `processId`: devolve o modelo como será respondido (`applicable = null` e `suggestion = null` com `reason = NO_PROCESS`). Com `processId` (`PROCESS_VIEW` cobrindo o processo, DEC-024; senão 404): avalia `applicabilityRule` e cada `autoCheck` com o `RuleEvaluator` sobre o `RuleContext` v2 do processo, montado só com os namespaces usados; resultado verdadeiro sugere `COMPLIANT`, falso sugere `NON_COMPLIANT`; item sem regra, regra inválida ou namespace indisponível (falha fechada, `NAMESPACE_UNAVAILABLE`) devolve sugestão nula com o `reason` (`NO_RULE`, `RULE_NOT_EVALUABLE`, `NAMESPACE_UNAVAILABLE`). `NOT_APPLICABLE` nunca é sugerido. Quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo recebe sugestão nula (`CONFIDENTIAL_INPUT`) nos itens cuja regra leia valor sigiloso; nenhum valor do processo é devolvido (DEC-030, RN-WF2-85).
- **RN-ICT-33** — Leitura: `ICT-01` e `ICT-03` com `INTERNAL_CONTROL_CHECKLIST_MANAGE` devolvem todas as versões, inclusive rascunhos; com `INTERNAL_CONTROL_REVIEW_VIEW` (e `AUDITOR` com `AUDIT_VIEW`) só `PUBLISHED` e `RETIRED` (rascunho por id responde 404). O conteúdo do checklist é configuração e não contém valor de processo; a lista não traz dado de outro tenant.
- **RN-ICT-34** — Semente incremental (`TenantSeeder`, M2-21, idempotente por `TenantSeeder.version`): para cada tenant, se não existe nenhuma versão da chave `FASE_PREPARATORIA`, cria a v1 `PUBLISHED` com os itens do quadro desta story, `isDefault = true` (se o tenant ainda não tiver outro padrão publicado; senão nasce sem a indicação) e `internalControl.defaultChecklistKey = FASE_PREPARATORIA`; se a chave já existe (customizada ou não), não altera nada. Ator `SYSTEM`; nova execução não duplica. O conteúdo é editável (nova versão) e a validar com o piloto no UAT.
- **RN-ICT-35** — MFA: as escritas (`ICT-02`, `ICT-04`, `ICT-05`, `ICT-06`) exigem sessão com MFA conforme `security.mfaPolicy` (permissão `H`, POL-14); leituras e pré-visualização não. Auditoria `internal_control_checklist.create`, `internal_control_checklist.update`, `internal_control_checklist.publish` e `internal_control_checklist.retire` (`CONFIGURATION`) sem o texto das perguntas, só `key`, `versionNumber`, contagens e nomes dos campos alterados.
- **RN-ICT-36** — Concorrência: `ICT-04`, `ICT-05` e `ICT-06` exigem `If-Match` com o `ETag` da versão (428 sem o cabeçalho, 412 divergente); duas publicações simultâneas da mesma chave resultam em uma 200 e outra 412 ou 409 `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT`; a abertura de manifestação concorrente (US-159) lê a versão publicada sob a mesma trava e fixa exatamente a versão antiga ou a nova, nunca uma mistura.
- **RN-ICT-37** — Idempotência: `ICT-02` e `ICT-05` exigem `Idempotency-Key` (24 h); reenvio devolve a resposta original com `Idempotent-Replayed: true`; chave reutilizada com corpo diferente responde 422 `IDEMPOTENCY_KEY_REUSED`. `ICT-04` e `ICT-06` são naturalmente idempotentes pelo `If-Match` e pelo estado.
- **RN-ICT-38** — Listagem (`ICT-01`): agrupada por chave, ordenada por nome da chave e versão decrescente; filtros `status`, `key` e `q` (nome); cada linha traz `itemsCount`, `requiredItemsCount`, `hasApplicabilityRule`, `isDefault`, `openReviewsCount`, `publishedAt`, `retiredAt` e `etag`; `meta.defaultChecklistKey` indica o padrão. Sem filtro, aposentadas aparecem recolhidas.
- **RN-ICT-39** — Diferença entre versões: o diálogo de publicação e o histórico mostram, por `key` de item, o que foi acrescentado, removido e alterado (campo a campo) em relação à versão `PUBLISHED` anterior da chave; é cálculo de leitura (front a partir de `ICT-03` das duas versões), sem coluna nem endpoint novo.

**Itens semeados de `FASE_PREPARATORIA` v1** (conteúdo a validar com o piloto; bases legais da Lei 14.133/2021 a validar com o jurídico do órgão; 15 itens, 12 obrigatórios):
| # | Grupo | `key` | Pergunta (resumo) | Base legal | Obrig. | Sugestão (`autoCheck`) |
|---|---|---|---|---|---|---|
| 1 | Demanda | `DFD_FORMALIZADO` | DFD finalizado, com necessidade e quantidade descritas? | art. 18, caput | Sim | — |
| 2 | Demanda | `PCA_VINCULADO` | Contratação prevista no plano de contratações anual ou com justificativa da ausência? | art. 12, VII | Sim | `pca.linked = true` |
| 3 | Estudo e riscos | `ETP_NECESSIDADE` | ETP demonstra a necessidade e as alternativas de solução? | art. 18, § 1º | Sim | — |
| 4 | Estudo e riscos | `ETP_VIABILIDADE` | ETP traz posicionamento conclusivo sobre a adequação da contratação? | art. 18, § 1º, XIII | Sim | — |
| 5 | Estudo e riscos | `RISCOS_MAPEADOS` | Mapa de riscos identifica riscos e tratamentos para o objeto? | art. 18, X | Sim | — |
| 6 | Pesquisa de preços | `PRECOS_METODOLOGIA` | Pesquisa segue os parâmetros do art. 23 e registra a metodologia? | art. 23, § 1º | Sim | — |
| 7 | Pesquisa de preços | `PRECOS_FONTES` | Número de fontes suficiente e cotações compatíveis com o objeto? | art. 23, § 1º | Não | — |
| 8 | Termo de referência | `TR_ELEMENTOS` | TR contém os elementos do art. 6º, XXIII? | art. 6º, XXIII | Sim | — |
| 9 | Termo de referência | `TR_COERENCIA_ETP` | TR coerente com o ETP em objeto, quantidades e requisitos? | art. 18, II | Não | — |
| 10 | Dotação | `DOTACAO_INDICADA` | Há indicação de recursos orçamentários e a cobertura é compatível com a estimativa? | art. 150 | Sim | `budget.coverageRatio >= 1` |
| 11 | Edital e contrato | `EDITAL_COMPLETO` | Minuta do edital completa e fiel ao TR? | art. 25 | Sim | `tender.isComplete = true` |
| 12 | Edital e contrato | `MINUTA_CONTRATO` | Minuta de contrato traz as cláusulas necessárias? | art. 92 | Não | — |
| 13 | Parecer jurídico | `PARECER_CONCLUIDO` | Há parecer jurídico concluído (ou dispensa registrada) sobre a versão analisada? | art. 53 | Sim | `legalReview.concluded = true` |
| 14 | Parecer jurídico | `PARECER_RESSALVAS` | Ressalvas atendidas ou com risco aceito e nenhum documento alterado depois do parecer? | art. 53 | Sim | `legalReview.openReservations = 0` e `legalReview.outdatedDocuments` vazio |
| 15 | Avisos superados | `AVISOS_SUPERADOS` | Avisos `WARNING` superados na tramitação têm justificativa registrada e aceitável? | art. 169, II | Sim | — |

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chave do modelo | `key` | texto (1..60) | Sim (novo modelo) | `^[A-Z][A-Z0-9_]{2,59}$`, única no tenant, imutável | — |
| Nome | `name` | texto (1..150) | Sim | texto puro | nome da origem na duplicação |
| Duplicar de | `fromChecklistId` | uuid | Condicional | versão do tenant, qualquer situação | versão de origem |
| Itens | `items[]` | lista de `ChecklistItem` | Sim (publicar) | 1..200 itens, ≥ 1 obrigatório para publicar (RN-ICT-24/26) | herdado ou `[]` |
| Código do item | `items[].key` | texto (1..60) | Sim | `^[A-Z][A-Z0-9_]{0,59}$`, única no modelo, estável | — |
| Grupo | `items[].group` | texto (1..80) | Sim | agrupa na tela de resposta | — |
| Pergunta | `items[].question` | texto (5..500) | Sim | texto puro | — |
| Base legal | `items[].legalBasis` | texto (≤ 200) | Não | — | — |
| Obrigatório | `items[].required` | booleano | Sim | exige resposta diferente de `PENDING` ao concluir (US-161) | `true` |
| Dica de evidência | `items[].evidenceHint` | texto (≤ 300) | Não | — | — |
| Regra de sugestão | `items[].autoCheck` | `RuleRef` | Não | `contextVersion = 2` ou `LIBRARY`; só sugere | — |
| Regra de aplicabilidade | `applicabilityRule` | `RuleRef` ou nulo | Não | nulo no padrão; `contextVersion = 2` | herdada |
| Modelo padrão | `isDefault` | booleano | Não | um por tenant; sem regra de aplicabilidade (RN-ICT-28) | `false` |
| Confirmo a troca do padrão | `confirmReplaceDefault` | booleano | Condicional | exigido ao publicar como padrão outra chave que não a vigente | `false` |
| Processo da prévia | `processId` | uuid | Não | `PROCESS_VIEW` cobrindo o processo | — |
| Versão | `If-Match` (ETag) | texto | Sim (ICT-04/05/06) | ETag da versão | `GET` ICT-03 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (ICT-02/05) | 24 h | gerada pelo front |
| *(saída)* Situação | `status`, `versionNumber`, `publishedAt`, `retiredAt` | enum, int, datetime | — | RN-ICT-21/27/30 | servidor |
| *(saída)* Manifestações abertas | `openReviewsCount` | inteiro | — | derivado (RN-ICT-31) | consulta |
| *(saída)* Sugestão da prévia | `suggestion`, `reason` | `COMPLIANT` \| `NON_COMPLIANT` \| nulo; enum | — | RN-ICT-32 | `RuleEvaluator` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `key`, `name` ou item fora de formato ou de tamanho; mais de 200 itens; `key` de item repetida | Front + API (Zod) | "Revise os campos destacados do checklist." | `VALIDATION_ERROR` |
| V-02 | `If-Match` ausente | API | "Atualize a página e tente de novo." | `PRECONDITION_REQUIRED` (428) |
| V-03 | `If-Match` divergente | API | "Este checklist foi alterado por outra pessoa. Atualize a página." | `VERSION_CONFLICT` (412) |
| V-04 | Editar ou publicar versão que não está `DRAFT` | API | "Esta versão já foi publicada ou aposentada. Crie uma nova versão para alterar." | `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT` (409) |
| V-05 | Já existe rascunho para a chave | API | "Já existe um rascunho em edição para este checklist." | `INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS` (409) |
| V-06 | Chave de modelo novo já usada | API | "Já existe um checklist com esta chave." | `INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN` (409) |
| V-07 | Publicação com violações (sem item obrigatório, itens fora de 1..200, regra inválida, padrão com regra) | API | "O checklist tem pendências que impedem a publicação." | `INTERNAL_CONTROL_CHECKLIST_INVALID` (422) com `errors[]` (`CHECKLIST_NO_REQUIRED_ITEM`, `CHECKLIST_ITEMS_COUNT`, `CHECKLIST_ITEM_KEY_DUPLICATE`, `CHECKLIST_RULE_NOT_EVALUABLE`, `CHECKLIST_DEFAULT_WITH_RULE`, `WF_RULE_PATH_UNKNOWN`, `WF_RULE_OPERATOR_FORBIDDEN`, `WF_RULE_CONTEXT_VERSION_INVALID`) |
| V-08 | Trocar o padrão sem confirmação, ou publicar sem a marca uma chave que é o padrão | API | "Já existe outro checklist padrão. Confirme a troca para continuar." | `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT` (409) |
| V-09 | Aposentar versão que não está `PUBLISHED` | API | "Só é possível aposentar uma versão publicada." | `INVALID_STATE` (409) |
| V-10 | Aposentar a versão padrão | API | "Este checklist é o padrão do órgão. Publique outro como padrão antes de aposentá-lo." | `INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT` (409) |
| V-11 | Alterar `internalControl.defaultChecklistKey` por `SET-02` | API | "A chave padrão é definida ao publicar o checklist." | `VALIDATION_ERROR` (`READ_ONLY`) |
| V-12 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` (sem escopo, risco `H`) para `ICT-02`, `ICT-04`, `ICT-05`, `ICT-06` e, com rascunhos, `ICT-01`, `ICT-03` e `ICT-07`; `INTERNAL_CONTROL_REVIEW_VIEW` (e `AUDITOR` com `AUDIT_VIEW`) para ler versões `PUBLISHED` e `RETIRED` (`ICT-01`, `ICT-03`); `PROCESS_VIEW` cobrindo o processo para pré-visualizar com `processId`; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas desmascara sugestões que dependem de valor sigiloso.
- **Políticas:** POL-14 (MFA nas ações `H`), POL-09 e DEC-030 (sigilo na prévia), DEC-024 (visibilidade do processo), princípio 17 (conteúdo é configuração, não código).
- **MFA:** exigido em `ICT-02`, `ICT-04`, `ICT-05` e `ICT-06` conforme `security.mfaPolicy`; sem MFA, 403 `MFA_REQUIRED`.
- **Sem permissão:** o item de menu "Administração › Checklists do Controle Interno" e as ações ficam ocultos sem `INTERNAL_CONTROL_CHECKLIST_MANAGE`; a API responde 403 `PERMISSION_DENIED` e grava `access.denied`; versão de outro tenant ou rascunho para quem só lê responde 404 `INTERNAL_CONTROL_CHECKLIST_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `InternalControlChecklistPublished` | `internal_control_review.checklist_published` | Commit de `ICT-05` | Payload `checklistId`, `key`, `versionNumber`, `itemsCount` (sem texto de pergunta); consumidor C (configuração e cache de leitura); a semente não publica o evento |
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit de `ICT-05` quando a chave padrão muda | `changedKeys: ["internalControl.defaultChecklistKey"]`; invalida o cache de configurações (MVP 1) |

Criar, editar e aposentar geram só auditoria (`internal_control_checklist.create`, `.update`, `.retire`), sem evento de domínio próprio.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: administração de modelos é atividade de configuração; o registro fica na auditoria (events.md §6 não prevê tipo para checklist). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar checklists versionados do Controle Interno

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o checklist "FASE_PREPARATORIA" v1 está "PUBLISHED" e é o padrão do tenant, com 15 itens e 12 obrigatórios
    And a análise "IC-0045" do processo "0045/2026" está "IN_REVIEW" e fixou o checklist "FASE_PREPARATORIA" v1
    And "Marta Souza" tem vínculo ativo no perfil "ADMIN_ORGAO" com "INTERNAL_CONTROL_CHECKLIST_MANAGE" e sessão com MFA
    And "Rui Alves" é "AUDITOR" com "AUDIT_VIEW" e "INTERNAL_CONTROL_REVIEW_VIEW"
    And "Carla Mendes", da "Secretaria de Obras", não tem "INTERNAL_CONTROL_CHECKLIST_MANAGE"

  Scenario: [Sucesso] Criar a v2 a partir da v1 e publicá-la sem alterar a análise em curso
    When "Marta Souza" duplicar a v1 com a chave "K1"
    Then a API deve responder 201 com o rascunho "FASE_PREPARATORIA" v2 "DRAFT", 15 itens copiados e um "ETag"
    When "Marta Souza" acrescentar o item obrigatório "MATRIZ_RISCOS_ALOCACAO" e salvar com o "If-Match" atual
    Then a API deve responder 200 com 16 itens
    When "Marta Souza" publicar a v2 com a chave "K2"
    Then a API deve responder 200 com a v2 "PUBLISHED", "publishedAt" preenchido e "isDefault" verdadeiro
    And a v1 deve ficar "RETIRED" com "retiredAt" preenchido
    And "internalControl.defaultChecklistKey" deve continuar "FASE_PREPARATORIA"
    And a análise "IC-0045" deve continuar com o checklist v1 e seus 15 itens
    And a próxima manifestação aberta deve fixar a v2
    And deve gerar registro de auditoria "internal_control_checklist.publish" com "key", "versionNumber" 2 e "itemsCount" 16
    And deve gerar o evento "InternalControlChecklistPublished"

  Scenario: [Sucesso] Novo modelo com regra de aplicabilidade e sugestão, com prévia
    When "Marta Souza" criar o modelo "OBRAS_ENGENHARIA" com um item "DOTACAO_INDICADA" com "autoCheck" "budget.coverageRatio >= 1" e a aplicabilidade "modalidade igual a CONCORRENCIA"
    Then a API deve responder 201 com a versão 1 "DRAFT"
    When "Marta Souza" pré-visualizar a versão com o processo "0045/2026"
    Then a API deve responder 200 com "applicable" verdadeiro ou falso conforme a modalidade e "suggestion" "COMPLIANT" ou "NON_COMPLIANT" no item "DOTACAO_INDICADA"
    And nenhuma resposta, auditoria de dados ou valor do processo deve ter sido gravado ou devolvido

  Scenario: [Sucesso] Prévia sem processo e com valor sigiloso mascarado
    When "Marta Souza" pré-visualizar a v1 sem processo
    Then a API deve responder 200 com os 15 itens agrupados e "suggestion" nula com "reason" "NO_PROCESS"
    Given que o processo "0031/2026" tem orçamento sigiloso e "Marta Souza" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Marta Souza" pré-visualizar a v1 com o processo "0031/2026"
    Then o item "DOTACAO_INDICADA" deve vir com "suggestion" nula e "reason" "CONFIDENTIAL_INPUT" e nenhum valor monetário na resposta

  Scenario: [Sucesso] Semente incremental respeita a customização do tenant
    Given que o tenant "Prefeitura B" não tem checklist e o tenant "Prefeitura C" já tem a chave "FASE_PREPARATORIA" customizada
    When o seeder do MVP 2 rodar duas vezes
    Then a "Prefeitura B" deve ter "FASE_PREPARATORIA" v1 "PUBLISHED" e padrão, e "internalControl.defaultChecklistKey" igual a "FASE_PREPARATORIA"
    And a "Prefeitura C" deve manter as suas versões sem alteração
    And a segunda execução não deve criar versões duplicadas

  Scenario: [Sucesso] Aposentar uma versão publicada que não é o padrão
    Given que existe o modelo "OBRAS_ENGENHARIA" v1 "PUBLISHED" e uma análise aberta que o fixou
    When "Marta Souza" aposentar "OBRAS_ENGENHARIA" v1
    Then a API deve responder 200 com a versão "RETIRED", "retiredAt" preenchido e "openReviewsCount" 1
    And a análise aberta deve continuar com a v1 e deve gerar registro de auditoria "internal_control_checklist.retire"

  Scenario: [Validação] Publicar versão inválida e editar versão publicada
    Given que o rascunho v3 não tem nenhum item obrigatório e um item usa o caminho "legalReview.inexistente"
    When "Marta Souza" tentar publicar a v3
    Then a API deve responder 422 com código "INTERNAL_CONTROL_CHECKLIST_INVALID" e "errors" com "CHECKLIST_NO_REQUIRED_ITEM" e "WF_RULE_PATH_UNKNOWN" no item
    And a v3 deve continuar "DRAFT"
    When "Marta Souza" tentar alterar um item da v2 publicada
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT" e a orientação de criar nova versão
    When "Marta Souza" tentar aposentar o padrão vigente
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT"
    When "Marta Souza" tentar salvar 201 itens
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Validação] Padrão com regra de aplicabilidade e troca de padrão sem confirmação
    Given que o rascunho "OBRAS_ENGENHARIA" v1 tem aplicabilidade e está marcado como padrão
    When "Marta Souza" tentar publicá-lo
    Then a API deve responder 422 com código "INTERNAL_CONTROL_CHECKLIST_INVALID" e erro "CHECKLIST_DEFAULT_WITH_RULE"
    Given que o rascunho "SERVICOS_TIC" v1 não tem aplicabilidade e está marcado como padrão
    When "Marta Souza" publicá-lo sem "confirmReplaceDefault"
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT" e "meta.currentDefault" com a chave "FASE_PREPARATORIA"
    When "Marta Souza" publicá-lo com "confirmReplaceDefault" igual a "true"
    Then "SERVICOS_TIC" v1 deve ser o padrão, "FASE_PREPARATORIA" deve continuar "PUBLISHED" sem a marca de padrão e "internalControl.defaultChecklistKey" deve ser "SERVICOS_TIC"

  Scenario: [Permissão] Sem permissão, sem MFA e leitura restrita a versões publicadas
    When "Carla Mendes" chamar "POST /internal-control/checklists"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar registro de auditoria "access.denied"
    Given que a sessão de "Marta Souza" não tem MFA e a política exige MFA
    When "Marta Souza" tentar publicar a v2
    Then a API deve responder 403 com código "MFA_REQUIRED" e a v2 deve continuar "DRAFT"
    When "Rui Alves" chamar "GET /internal-control/checklists/{id-v2-publicada}"
    Then a API deve responder 200 com os itens
    When "Rui Alves" chamar "GET /internal-control/checklists/{id-rascunho}"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_CHECKLIST_NOT_FOUND"
    And "Rui Alves" não deve conseguir "POST /internal-control/checklists/{id}/publish"

  Scenario: [Tenant incorreto] Checklist de outro órgão
    Given que o checklist "FASE_PREPARATORIA" v1 da "Prefeitura B" tem outro identificador
    When "Marta Souza", da "Prefeitura A", chamar "GET", "PATCH", "publish", "retire" e "preview" para esse identificador
    Then a API deve responder 404 com código "INTERNAL_CONTROL_CHECKLIST_NOT_FOUND" nas cinco chamadas
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria
    When "Marta Souza" duplicar a partir desse identificador
    Then a API deve responder 404 com código "INTERNAL_CONTROL_CHECKLIST_NOT_FOUND"

  Scenario: [Duplicidade] Rascunho existente, chave repetida e reenvio da publicação
    Given que existe o rascunho "FASE_PREPARATORIA" v2
    When "Marta Souza" duplicar a v1 de novo com a chave "K3"
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS" e "meta.draftId" do rascunho existente
    When "Marta Souza" criar um modelo novo com a chave "FASE_PREPARATORIA"
    Then a API deve responder 409 com código "INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN"
    Given que "Marta Souza" publicou a v2 com a chave "K2" e recebeu 200
    When a mesma requisição for reenviada com a chave "K2"
    Then a API deve responder 200 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único evento "InternalControlChecklistPublished" e uma única auditoria "internal_control_checklist.publish"

  Scenario: [Concorrência] Duas publicações e edição com ETag velha
    Given que o rascunho v2 está pronto e "Marta Souza" e "Paulo Dias", também administrador, abriram a mesma ETag
    When os dois publicarem a v2 ao mesmo tempo
    Then exatamente uma chamada deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT"
    And deve existir uma única versão "PUBLISHED" da chave "FASE_PREPARATORIA"
    Given que "Marta Souza" abriu o rascunho v3 com a ETag "E1" e "Paulo Dias" salvou uma alteração
    When "Marta Souza" salvar com "If-Match" "E1"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    Given que uma nova manifestação é aberta no mesmo instante da publicação da v2
    Then a manifestação deve fixar a v1 ou a v2 inteira, nunca uma mistura, e a v1 não deve ficar sem versão publicada em nenhum momento

  Scenario: [Falha de banco] Falha ao gravar a publicação
    Given que o banco de dados fica indisponível durante a transação de "POST /internal-control/checklists/{id}/publish"
    When "Marta Souza" confirmar a publicação da v2
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a v2 deve continuar "DRAFT", a v1 deve continuar "PUBLISHED" e nenhum evento, auditoria ou alteração de configuração deve ter sido gravado

  Scenario: [Falha de integração] Provedor do RuleContext indisponível na prévia
    Given que o provedor do namespace "legalReview" do RuleContext está indisponível
    When "Marta Souza" pré-visualizar a v1 com o processo "0045/2026"
    Then a API deve responder 200 com os itens que dependem de "legalReview" com "suggestion" nula e "reason" "NAMESPACE_UNAVAILABLE"
    And os demais itens devem ter a sugestão normal e nenhuma sugestão deve ser inventada

  Scenario: [Falha de integração] Redis indisponível no armazenamento de idempotência
    Given que o Redis está indisponível
    When "Marta Souza" duplicar a v1
    Then a API deve responder 201 e concluir a criação sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campos fora de formato ou limite | 422 | `VALIDATION_ERROR` | "Revise os campos destacados do checklist." | Marca o campo ou o item |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega a versão |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este checklist foi alterado por outra pessoa. Atualize a página." | Recarrega e mostra as diferenças |
| Versão não está em rascunho | 409 | `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT` | "Esta versão já foi publicada ou aposentada. Crie uma nova versão para alterar." | Oferece "Nova versão" |
| Rascunho já existente | 409 | `INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS` | "Já existe um rascunho em edição para este checklist." | Abre o rascunho existente |
| Chave de modelo já usada | 409 | `INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN` | "Já existe um checklist com esta chave." | Marca o campo |
| Publicação inválida | 422 | `INTERNAL_CONTROL_CHECKLIST_INVALID` | "O checklist tem pendências que impedem a publicação." | Painel de validação com link para o item ou a regra |
| Conflito de padrão | 409 | `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT` | "Já existe outro checklist padrão. Confirme a troca para continuar." | Diálogo de confirmação com o padrão atual |
| Aposentar o padrão | 409 | `INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT` | "Este checklist é o padrão do órgão. Publique outro como padrão antes de aposentá-lo." | Oculta/desabilita a ação com o motivo |
| Aposentar versão não publicada | 409 | `INVALID_STATE` | "Só é possível aposentar uma versão publicada." | Recarrega |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar checklists do Controle Interno." | Oculta a ação |
| Sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Abre o desafio de MFA e repete a ação |
| Checklist inexistente, de outro tenant ou rascunho sem permissão | 404 | `INTERNAL_CONTROL_CHECKLIST_NOT_FOUND` | "Checklist não encontrado." | Volta à lista |
| Processo da prévia inexistente ou invisível | 404 | `NOT_FOUND` | "Processo não encontrado." | Limpa o processo da prévia |
| Chave padrão alterada por configurações gerais | 422 | `VALIDATION_ERROR` (`READ_ONLY`) | "A chave padrão é definida ao publicar o checklist." | Campo somente leitura |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-097 (autorização no API e no frontend: permissão `H`, MFA, matriz); US-103 (configurações do tenant: `internalControl.defaultChecklistKey`, `SET-02`). Indiretas: US-129 (`RuleContext` v2 e `RuleEvaluator`, que validam e avaliam `autoCheck` e aplicabilidade), US-099 (provisionamento e `TenantSeeder`), US-107/US-108 (padrão de versionamento de template reaproveitado), US-044 (rule builder de condição). Habilitam: US-159 (fixa o checklist na abertura), US-160 (responde os itens), US-161 (exige as obrigatórias), US-130 (workflow v2 que abre a etapa).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-196, DEC-200, DEC-204; ADR-008 (executor de regras), ADR-015; princípio 17; POL-09, POL-14.
- **Configurações:** `internalControl.defaultChecklistKey` (padrão `FASE_PREPARATORIA`; passa a ser projeção do padrão publicado, RN-ICT-29).
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos** (`INTERNAL_CONTROL_CHECKLIST_NOT_FOUND`, `_NOT_DRAFT`, `_DRAFT_EXISTS`, `_KEY_TAKEN`, `_INVALID`, `_DEFAULT_CONFLICT`, `_IS_DEFAULT` e os `errors[]` `CHECKLIST_*`) não existem em `permissions.md`, `events.md` nem no catálogo de API; a consolidar no card 9. Reutilizados: `WF_RULE_PATH_UNKNOWN`, `WF_RULE_OPERATOR_FORBIDDEN`, `WF_RULE_CONTEXT_VERSION_INVALID` (US-129), `MFA_REQUIRED`, `INVALID_STATE`.
  2. **Colunas e índices do `InternalControlChecklist`:** o texto de integridade cita `retiredAt`, mas a tabela de campos (entities.md §4.4) só tem `publishedAt`/`publishedById`; propõe-se `retiredAt` e `retiredById` e o índice `UNIQUE (tenant_id, key) WHERE status = 'PUBLISHED'` (uma versão publicada por chave, RN-ICT-27), além dos já previstos. O trigger de imutabilidade precisa permitir `isDefault` verdadeiro para falso e `status` `PUBLISHED` para `RETIRED` (RN-ICT-25/RN-ICT-28).
  3. **`isDefault` x `internalControl.defaultChecklistKey`:** as fontes têm as duas indicações sem dizer qual manda; a story adota o `isDefault` publicado como fonte de verdade e a chave como projeção somente leitura em `SET-02` (RN-ICT-29). **Dúvida de produto.**
  4. **Padrão não tem regra de aplicabilidade** (RN-ICT-28), decorrente de "usado quando nenhum outro se aplica" (entities.md §4.4); confirmar. **Dúvida de produto.**
  5. **Mapeamento de `autoCheck`:** a fonte diz "sugere a resposta" sem dizer como; adotado: verdadeiro sugere `COMPLIANT`, falso `NON_COMPLIANT`, `NOT_APPLICABLE` nunca (RN-ICT-32). Também faltam o tipo (`kind`) de `RuleDefinition` aceito para referência `LIBRARY` em `autoCheck` e aplicabilidade, e o desempate quando mais de um modelo publicado se aplica ao processo (decisão da US-159; sugestão: o publicado mais recentemente). **Dúvida de produto.**
  6. **Auditoria `internal_control_checklist.update`** (edição do rascunho) e eventual registro de pré-visualização com processo real não constam em `events.md` §5 (só `create`, `publish`, `retire`); a story propõe `update` (`CONFIGURATION`, só nomes de campos) e não audita a prévia (somente log), ao contrário de `rule.simulate`. A confirmar.
  7. **Limites de texto** de nome, pergunta, base legal e dica (RN-ICT-24) e o formato de `key` não estão nas fontes; valores adotados, a validar na implementação.
  8. **Routing key** `internal_control_review.checklist_published` (events.md §4.6) usa o prefixo da análise para um evento do checklist; mantida como está no catálogo.
  9. **Conteúdo semeado** (15 itens, bases legais e quais são obrigatórios) é "a validar com o piloto" (overview §7) e com o jurídico do órgão; as bases do art. 18, § 1º, XIII e do art. 12, VII devem ser conferidas. A semente não publica `InternalControlChecklistPublished` (sem consumidores úteis); confirmar.
  10. **Alteração de `SET-02`** para tornar `internalControl.defaultChecklistKey` somente leitura muda o contrato da US-103; confirmar com o dono das configurações. **Dúvida de produto.**

## Impacto técnico
- A publicação é uma transação curta com trava por `(tenant, key)` (`pg_advisory_xact_lock`) e leitura das versões da chave `FOR UPDATE`; a aposentadoria da anterior, a nova publicação e o ajuste do padrão acontecem juntos para nunca haver uma janela sem versão publicada nem dois padrões. A abertura de manifestação (US-159) lê a versão publicada sob a mesma trava ou em leitura consistente, de modo que fixa uma versão inteira.
- A validação (`ChecklistPublishValidator`) reúne a forma dos itens, a regra "≥ 1 obrigatório" e o `RuleValidator`/`RuleEvaluator` do módulo `rules` (US-129) sobre o contexto neutro do schema do `RuleContext` v2 (casos `RuleTestCase` com padrões neutros); roda por inteiro a cada publicação e na pré-visualização, sem gravar.
- Imutabilidade por trigger em `internal_control_checklists` (colunas de conteúdo bloqueadas fora do `DRAFT`; passagens permitidas `PUBLISHED` para `RETIRED` e remoção da marca de padrão); índices parciais garantem um rascunho por chave, uma versão publicada por chave e um padrão publicado por tenant.
- Pré-visualização com processo monta o `RuleContext` v2 só com os namespaces que as regras usam (montagem preguiçosa, ADR-015), com falha fechada por namespace (2 s) e valores sigilosos mascarados (RN-WF2-85); metas p95: `ICT-01` < 500 ms, `ICT-05` < 1 s, `ICT-07` < 1,5 s (200 itens), escritas na suíte de performance e medidas no endurecimento.
- A semente é um passo do `TenantSeeder` incremental (M2-21), idempotente e executado por tenant em transação própria; o conteúdo vem de fixture versionada com o release (como a biblioteca de templates, US-110).
- Compatibilidade: nenhuma rota do MVP 1 muda; `SET-02` passa a recusar a escrita da chave padrão (lacuna 10). Eventos novos nascem com `eventVersion = 1`.

## Backend
- **Módulo(s):** `internal-control` (dono), `rules` (validação e avaliação de regras, fachada `RuleEvaluator`), `tenancy` (configuração e `TenantSeeder`), `access`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`, trava por tenant); `process` apenas para validar a visibilidade da prévia.
- **Casos de uso:** `ListInternalControlChecklistsQuery` (ICT-01), `CreateInternalControlChecklistCommand` (ICT-02, novo modelo e duplicação), `GetInternalControlChecklistQuery` (ICT-03), `UpdateInternalControlChecklistDraftCommand` (ICT-04), `PublishInternalControlChecklistCommand` (ICT-05), `RetireInternalControlChecklistCommand` (ICT-06), `PreviewInternalControlChecklistQuery` (ICT-07); `SeedInternalControlChecklistStep` (semente).
- **Domínio:** `InternalControlChecklist` (invariantes `DRAFT` para `PUBLISHED` para `RETIRED`, um rascunho por chave, um padrão por tenant), `ChecklistItem` (value object, schema Zod em `packages/types`), `ChecklistPublishValidator`, `ChecklistDiffCalculator` (RN-ICT-39), `DefaultChecklistPolicy`.
- **Integrações internas:** `RuleEvaluator`/`RuleContextBuilder` (US-129), `TenantSettingsService` (projeção da chave padrão, evento `TenantSettingsChanged`), `ProcessFacade.canView`, `OutboxWriter`, `AuditService`.
- **Transação:** `ICT-05` trava a chave e o padrão, valida, publica, aposenta a anterior, ajusta padrão e configuração, audita e grava o outbox; falha em qualquer passo desfaz tudo; `ICT-07` é somente leitura.

## Frontend
- **Tela(s):** SCR-119 (`/admin/controle-interno/checklists`, lista agrupada por chave com histórico de versões) e o editor da versão (`/admin/controle-interno/checklists/[id]`).
- **Componentes:** `ChecklistList` (grupos por chave, selos de situação e padrão, contagem de análises abertas), `ChecklistEditor` (itens por grupo com reordenação por teclado e arrastar), `ChecklistItemForm`, `RuleBuilder` (o construtor de condições do administrador de workflows, para `autoCheck` e aplicabilidade), `ChecklistPreviewPanel` (formulário como será respondido e sugestões), `PublishChecklistDialog` (resumo das diferenças, aviso de aposentadoria da anterior, troca de padrão), `ChecklistDiffView`, `ValidationResultPanel`, `StatusBadge`.
- **Estados:** skeleton; vazio ("Nenhum checklist cadastrado", improvável pela semente); erro com "Tentar novamente"; salvando; conflito de versão (recarrega e mostra diferenças); publicação inválida (painel de pendências); sucesso com aviso de que as análises em curso mantêm a versão fixada; somente leitura para `INTERNAL_CONTROL_REVIEW_VIEW`.
- **Acessibilidade e responsividade:** situação e padrão com texto e ícone, nunca só cor; reordenação de itens também por botões "Mover para cima/baixo"; diálogos com foco preso e retorno do foco; erros de validação ligados ao campo por `aria-describedby`; abaixo de 768 px a lista de itens vira cartões e o editor ocupa a tela; contraste AA nos temas claro e escuro.

## Banco de dados
- **Tabelas:** `internal_control_checklists` (insert/update), `tenant_settings` (chave padrão), `audit_logs`, `outbox_events`; leitura de `internal_control_reviews` (contagem de análises abertas por `checklist_id`).
- **Migrações:** nenhuma além da M2-16 (tabela do checklist) e da M2-21 (semente); acrescentar na M2-16 `retired_at` e `retired_by_id`, o índice `UNIQUE (tenant_id, key) WHERE status = 'PUBLISHED'` e o trigger de imutabilidade com as passagens permitidas (lacuna 2).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key, version_number)`; `UNIQUE (tenant_id, key) WHERE status = 'DRAFT'`; `UNIQUE (tenant_id, key) WHERE status = 'PUBLISHED'` (proposto); `UNIQUE (tenant_id) WHERE is_default AND status = 'PUBLISHED'`; check `jsonb_array_length(items) BETWEEN 1 AND 200` para `PUBLISHED`; check `is_default = false OR applicability_rule IS NULL`; RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ICT-01` | GET | `/api/v1/internal-control/checklists` | `status?`, `key?`, `q?`, paginação padrão | `200 { data: [ { id, key, versionNumber, name, status, isDefault, itemsCount, requiredItemsCount, hasApplicabilityRule, openReviewsCount, publishedAt, retiredAt, etag } ], meta: { defaultChecklistKey } }` | 200, 401, 403, 429, 503 |
| `ICT-02` | POST | `/api/v1/internal-control/checklists` | `{ key, name, items?, applicabilityRule?, isDefault? }` ou `{ fromChecklistId, key?, name? }` + `Idempotency-Key` | `201 { data: Checklist }` + `ETag` e `Location` | 201, 401, 403, 404, 409, 422, 429, 503 |
| `ICT-03` | GET | `/api/v1/internal-control/checklists/{id}` | — | `200 { data: Checklist, meta: { etag, openReviewsCount } }` | 200, 401, 403, 404 |
| `ICT-04` | PATCH | `/api/v1/internal-control/checklists/{id}` | `{ name?, items?, applicabilityRule?, isDefault? }` + `If-Match` | `200 { data: Checklist }` + novo `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `ICT-05` | POST | `/api/v1/internal-control/checklists/{id}/publish` | `{ confirmReplaceDefault? }` + `If-Match` + `Idempotency-Key` | `200 { data: Checklist, meta: { retiredVersionNumber?, defaultKeyChanged } }` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `ICT-06` | POST | `/api/v1/internal-control/checklists/{id}/retire` | corpo vazio + `If-Match` | `200 { data: Checklist, meta: { openReviewsCount } }` | 200, 401, 403, 404, 409, 412, 428, 503 |
| `ICT-07` | POST | `/api/v1/internal-control/checklists/{id}/preview` | `{ processId? }` | `200 { data: { applicable, items: [ { key, group, question, legalBasis, required, evidenceHint, suggestion, reason } ] } }` | 200, 401, 403, 404, 429, 503 |

## Logs
- `info` `internal_control_checklist.created` e `internal_control_checklist.updated` — `checklistId`, `key`, `versionNumber`, `itemsCount`, `correlationId`; `info` `internal_control_checklist.published` — `checklistId`, `key`, `versionNumber`, `itemsCount`, `retiredVersionNumber`, `defaultKeyChanged`, `durationMs`; `info` `internal_control_checklist.retired` — `checklistId`, `openReviewsCount`.
- `info` `internal_control_checklist.previewed` — `checklistId`, `withProcess` (booleano), `suggestedCount`, `durationMs` (sem `processId` em claro além do identificador técnico, sem valores).
- `warn` `internal_control_checklist.publish_rejected` — `checklistId`, códigos de `errors[]`; `warn` `internal_control_checklist.preview_namespace_unavailable` — `namespace`; `warn` `idempotency.store_unavailable`.
- `error` `internal_control_checklist.publish_failed` — `errorCode`, causa resumida, `correlationId`; `info` `internal_control_checklist.seeded` — `tenantId`, `created` (0 ou 1).
- **Nunca logar:** texto de perguntas, base legal ou dicas, expressões de regra completas, valores de processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `internal_control_checklist.create` | `CONFIGURATION` | Commit de `ICT-02` | `metadata`: `checklistId`, `key`, `versionNumber`, `fromChecklistId?`, `itemsCount`; nunca o texto das perguntas |
| `internal_control_checklist.update` | `CONFIGURATION` | Commit de `ICT-04` | `changes`: nomes dos campos alterados (`name`, `items`, `applicabilityRule`, `isDefault`); `metadata`: `itemsCount`, itens acrescentados, alterados e removidos por `key` |
| `internal_control_checklist.publish` | `CONFIGURATION` | Commit de `ICT-05` | `changes`: `status` `DRAFT` para `PUBLISHED`; `metadata`: `key`, `versionNumber`, `itemsCount`, `requiredItemsCount`, `retiredVersionNumber?`, `isDefault`, `defaultKeyChange?` (de/para) |
| `internal_control_checklist.retire` | `CONFIGURATION` | Commit de `ICT-06` | `changes`: `status` `PUBLISHED` para `RETIRED`; `metadata`: `key`, `versionNumber`, `openReviewsCount` |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `checklistId?` |

## Testes necessários
- **Unitários:** invariantes do modelo (transições, um rascunho por chave, padrão sem regra, `versionNumber` sequencial); schema de `ChecklistItem` (limites, `key` única, 200 itens); `ChecklistPublishValidator` (sem obrigatório, caminho desconhecido, operador proibido, regra não avaliável, `contextVersion`); `DefaultChecklistPolicy` (substituição pela mesma chave, troca com confirmação, publicar sem a marca o padrão); `ChecklistDiffCalculator`; mapeamento de sugestão do `autoCheck` e mascaramento de sigilo; fixture da semente (15 itens, 12 obrigatórios, regras válidas).
- **Integração (Testcontainers PostgreSQL):** ICT-01..07 ponta a ponta; publicação atômica (nova publicada, anterior aposentada, padrão e configuração ajustados, auditoria e outbox) e rollback total na falha; triggers (`UPDATE` de conteúdo fora do `DRAFT` falha; `PUBLISHED` para `RETIRED` e remoção da marca de padrão passam); índices parciais (segundo rascunho, segunda versão publicada da chave, segundo padrão); manifestação aberta que fixa a versão antiga continua intacta; semente idempotente em tenant novo, existente e customizado.
- **API/contrato:** corpo, ETag, `Location`, `Idempotent-Replayed` e `errors[]` de ICT-01..07; `SET-02` recusando `internalControl.defaultChecklistKey`; evento `InternalControlChecklistPublished` e `TenantSettingsChanged` conforme `events.md`.
- **RBAC e multi-tenant:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` (ADM e CI) × `INTERNAL_CONTROL_REVIEW_VIEW` × sem permissão; MFA nas escritas; rascunho oculto a quem só lê; checklist e processo da prévia de outro tenant → 404; testes novos na suíte `test/tenant-leak` para ICT-01..07 e para a semente.
- **Concorrência:** duas publicações simultâneas da mesma chave; criação simultânea de rascunho; edição com ETag velha; publicação x abertura de manifestação (versão fixada inteira).
- **E2E (Playwright):** duplicar a v1, editar um item, pré-visualizar com um processo, publicar, conferir que a análise em curso mantém a v1 e a nova abertura usa a v2; tentar editar a publicada; trocar o padrão; aposentar.
- **Acessibilidade/performance:** axe sem violações sérias no editor, no construtor de regra e nos diálogos; reordenação por teclado; 360 px; metas de p95 de ICT-01, ICT-05 e ICT-07 na suíte de performance.

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
- [ ] Teste prova a imutabilidade da versão publicada (trigger) e que nenhuma publicação altera a versão fixada por manifestação aberta
- [ ] Teste prova um único padrão publicado e uma única versão publicada por chave, inclusive sob concorrência
- [ ] Semente `FASE_PREPARATORIA` v1 idempotente, respeitando tenants customizados, com as regras válidas no `RuleContext` v2

## Estimativa
**M** — sete rotas de administração sobre uma única entidade versionada, reaproveitando o padrão de versionamento de templates e o motor de regras do MVP 2; o esforço está na validação de publicação contra o `RuleContext` v2, na troca atômica de versão e de padrão com a projeção da configuração, na prévia sem vazar sigilo e na semente incremental.

## Prioridade
**P0** — sem um checklist publicado e fixável a manifestação do Controle Interno não pode ser aberta (US-159) nem concluída (US-161), e a fase preparatória da v2 não fecha (DEC-196).
