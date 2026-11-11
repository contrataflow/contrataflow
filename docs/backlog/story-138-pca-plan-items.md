---
id: US-138
title: "Criar o plano anual e manter os itens do PCA"
epic: EP-023
feature: FT-068
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-097, US-102, US-104]
modules: [pca, organization, catalog, access, audit, platform]
screens: [SCR-018, SCR-041]
endpoints: [PCA-01, PCA-02, PCA-03, PCA-04, PCA-05, PCA-06, PCA-07, PCA-08, PCA-09, DEP-02, CAT-01, USR-02, SET-02]
permissions: [PCA_VIEW, PCA_MANAGE]
events: [PcaCreated, PcaItemChanged]
---

# US-138 — Criar o plano anual e manter os itens do PCA

## Título
Criar o plano de contratações anual do órgão e manter os seus itens

## Descrição
**Como** responsável pelo planejamento (`PLANEJAMENTO`), **quero** criar o plano de contratações anual (PCA) do meu órgão para um exercício e cadastrar, editar, consultar e excluir os itens do plano (secretaria demandante, objeto, categoria, valor previsto, mês previsto, responsável e situação), **para** consolidar na plataforma o que o órgão pretende contratar no exercício, com códigos estáveis que depois ligam o plano aos DFDs, às revisões e à execução.

O plano nasce em `DRAFT`, é do órgão e do exercício e tem a lista de itens como núcleo. Cada alteração de item recalcula, na mesma transação, o valor previsto total e a quantidade de itens do plano. A tela SCR-018 lista os planos, abre o plano com abas de itens e de resumo (totais por secretaria, categoria, mês e situação), filtra e busca os itens e avisa do prazo de elaboração configurado. A importação por planilha é a US-139, o envio para aprovação é a US-140 e a revisão do plano aprovado é a US-141.

## Contexto
- A Lei 14.133/2021, art. 12, VII, prevê o plano de contratações anual; o roadmap §4.2 define o conteúdo do item: exercício, secretaria, objeto, categoria, valor previsto, **mês previsto** (não trimestre), responsável e situação. O texto do card de origem do épico falava em trimestre; prevalece o roadmap.
- No MVP 1 não existe entidade PCA: `Process` e `Dfd` só guardam `pcaStatus`, `pcaYear`, `pcaItemCode` e `pcaJustification` (DEC-029). A DEC-197 cria o módulo `pca` com `Pca` (um plano por órgão e exercício, com versões) e `PcaItem` (código estável no plano), `PcaPlanStatus` (`DRAFT`, `AWAITING_APPROVAL`, `APPROVED`, `SUPERSEDED`) e `PcaItemStatus` (`PLANNED`, `IN_PROGRESS`, `CONTRACTED`, `POSTPONED`, `CANCELED`). `PcaStatus` do MVP 1 continua sendo a situação do processo em relação ao plano.
- O código do item (`code`) é a chave que liga as versões do plano e a referência textual `pcaYear` + `pcaItemCode` do MVP 1 (reconciliação da US-143); por isso é normalizado, único no plano e imutável.
- Esta story entrega a **fase de elaboração** (`DRAFT`). Plano `AWAITING_APPROVAL`, `APPROVED` ou `SUPERSEDED` não aceita alteração de itens (RN-PCA-12, POL-22); no aprovado, só a situação do item muda no acompanhamento (US-144), e o conteúdo muda por revisão (US-141).
- Permissões `PCA_VIEW` e `PCA_MANAGE` (novas, POL-22) com escopo de unidade ou de órgão: quem tem escopo de secretaria vê e edita só os itens da própria secretaria; criar e excluir o plano exige escopo `ORGANIZATION` ou `TENANT` (permissions.md §5.1). `CONSULTOR_EXTERNO` não acessa o PCA (L-07, DEC-197).
- Sigilo (DEC-030): o valor previsto do item é dado do plano, que o órgão divulga (art. 12, § 1º); a máscara da POL-09 vale apenas para o valor do item **na visão por processo** (US-142, RN-PCA-07), não na SCR-018. Mesmo assim, valores nunca vão a logs, eventos nem notificações.
- `pca.elaborationDeadline` (calendário do plano, padrão 30/06 do exercício anterior, "a validar com o piloto") é configurável pela SCR-041 (SET-02) e alimenta o aviso de prazo desta story.

## Objetivo
Permitir que um órgão elabore o PCA do exercício na plataforma, com 100% dos itens validados na gravação (campos obrigatórios, referências ativas e do próprio tenant, códigos únicos), totais do plano sempre iguais à soma dos itens, nenhum item editável fora de `DRAFT` e consulta com p95 ≤ 500 ms para planos de até 2.000 itens.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`) — cria o plano e mantém os itens (`PCA_MANAGE`, escopo de órgão).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `PCA_MANAGE`/`PCA_VIEW`); responsável de secretaria com `PCA_MANAGE` em escopo de unidade (edita só os itens da secretaria); Administrador do órgão (`ADMIN_ORGAO`, `PCA_VIEW` e configura o calendário); demais perfis com `PCA_VIEW` (leitura). Sem acesso: `CONSULTOR_EXTERNO`.

## Pré-condições
- Usuário autenticado no tenant com vínculo `ACTIVE`; tenant ativo (não `SUSPENDED`/`OFFBOARDING`).
- `PCA_MANAGE` com escopo que cubra o plano para escrever; `PCA_VIEW` para ler (POL-22, permissions.md §5.1).
- Órgão (`Organization`) e secretarias (`Department`) cadastrados e ativos (US-102); catálogo `PCA_CATEGORY` semeado e ativo (US-104, M2-21); catálogos opcionais `CONTRACTING_TYPE` e `UNIT_OF_MEASURE`.
- Para criar um plano: não existir plano do mesmo órgão e exercício (qualquer versão).

## Fluxo principal
1. Em **Planejamento › PCA** (SCR-018, `/pca`), o usuário com `PCA_VIEW` abre a lista de planos (PCA-01), com o painel de filtros aberto (Exercício, Situação) e a ação primária **"Novo plano"** no cabeçalho (visível com `PCA_MANAGE` em escopo de órgão).
2. Clica em "Novo plano"; o diálogo pede **Exercício** (padrão: próximo ano), **Órgão** (se o tenant tem mais de um órgão no escopo; padrão: o órgão principal) e **Título** (padrão "PCA {exercício}"). Enviado, o front chama PCA-02 com `Idempotency-Key`.
3. A API, em uma transação com `app.tenant_id`: valida corpo e permissão; confirma que não há plano do órgão no exercício; cria `Pca` (`DRAFT`, `versionNumber = 1`, totais zerados); grava `pca.create` e `PcaCreated` no outbox; responde **201** com `Location`, `ETag` e o plano. O front abre `/pca/[pcaId]` na aba **Itens**, vazia, com o aviso do prazo de elaboração e a ação **"Novo item"**.
4. O usuário clica em "Novo item"; o painel lateral pede **Secretaria**, **Objeto**, **Categoria**, **Valor previsto**, **Mês previsto**, **Responsável** e **Situação**, mais "Mais campos" (código, quantidade, unidade de medida, sistema e código de catálogo, tipo de contratação, prioridade, observações). O **Código** vem vazio: a API atribui o próximo código livre (`0001`, `0002`…) se não for informado.
5. Ao salvar, o front chama PCA-07 com `Idempotency-Key`. A API, em uma transação: trava a linha do plano (`FOR UPDATE`), confirma `DRAFT`, valida o item (RN-PCA-03, RN-PCA-35, RN-PCA-36), atribui o `code` se ausente, grava o `PcaItem`, recalcula `totalPlannedValue` e `itemsCount` do plano (incrementa `Pca.version`), grava `pca.item_create` e `PcaItemChanged` (`CREATED`) e responde **201** com o item. A tabela atualiza o item e os totais.
6. O usuário filtra e busca (PCA-06: secretaria, categoria, mês, situação, responsável e busca por código/objeto), ordena colunas e pagina; o rodapé mostra a quantidade e o valor previsto do **conjunto filtrado**.
7. Para editar, clica na linha: o painel traz o item; ao salvar, o front chama PCA-08 com `If-Match` da versão do item. A API valida, grava, recalcula os totais, registra `pca.item_update` (antes e depois por campo) e `PcaItemChanged` (`UPDATED`, ou `STATUS_CHANGED` quando só a situação muda).
8. Para excluir, usa "Excluir item" e confirma; o front chama PCA-09 com `If-Match`. A API faz a exclusão lógica (libera o código), recalcula os totais, registra `pca.item_delete` e `PcaItemChanged` (`DELETED`). Item em uso é recusado (`PCA_ITEM_IN_USE`).
9. Na aba **Resumo** (dados do PCA-03), o usuário vê o total do plano, a contagem de itens e os totais por secretaria, categoria, mês e situação; o cabeçalho mostra o **prazo de elaboração** ("Elaboração até 30/06/2026 — faltam 12 dias" ou "prazo vencido há 3 dias") enquanto a versão 1 não estiver aprovada.
10. Para corrigir o título, usa "Editar plano" (PCA-04, `If-Match`); para desfazer um plano criado por engano (versão 1, `DRAFT`, nunca enviado), usa "Excluir plano" (PCA-05).

## Fluxos alternativos
- **FA-01 — Plano do exercício já existe:** PCA-02 responde 409 `PCA_ALREADY_EXISTS` com `meta.existingPcaId` e `meta.existingStatus`; o front oferece "Abrir o plano de {ano}". Se o plano existente está `APPROVED`, a orientação é "Para alterar o plano aprovado, crie uma revisão" (US-141).
- **FA-02 — Código informado já usado no plano:** 409 `PCA_ITEM_CODE_DUPLICATED` com o código normalizado; o front sugere o próximo livre. O código de um item excluído pode ser usado de novo.
- **FA-03 — Escopo de secretaria:** usuário com `PCA_MANAGE` em escopo de unidade vê só os itens das suas secretarias, cria e edita itens apenas dessas secretarias (o seletor de secretaria lista só as do escopo) e não vê "Novo plano", "Editar plano" nem "Excluir plano". Os totais que vê são os dos itens visíveis (`meta.scope = DEPARTMENTS`).
- **FA-04 — Plano fora de `DRAFT`:** com o plano em `AWAITING_APPROVAL`, `APPROVED` ou `SUPERSEDED`, a aba Itens abre em leitura (faixa "Plano em aprovação" / "Plano aprovado — para alterar, crie uma revisão") e as escritas respondem 409 `PCA_NOT_EDITABLE`.
- **FA-05 — Situação do item:** "Adiado" e "Cancelado" exigem o motivo (10 a 2.000 caracteres); "Em andamento" e "Contratado" não podem ser escolhidos à mão em `DRAFT` (nascem do vínculo com processos — US-142/US-144) e aparecem apenas em itens herdados de revisão.
- **FA-06 — Edição concorrente do mesmo item:** a segunda gravação com `If-Match` antigo recebe 412 `VERSION_CONFLICT` com o item atual em `meta.current`; o painel mostra "Outra pessoa alterou este item" e oferece "Recarregar".
- **FA-07 — Prazo de elaboração vencido:** a faixa muda para o estado de alerta ("prazo vencido há N dias"), sem bloquear nenhuma escrita (o prazo é indicativo, não regra de negócio).
- **FA-08 — Excluir plano com histórico:** plano de versão > 1, já enviado alguma vez (`approvalId` preenchido) ou com item em uso não pode ser excluído (409 `PCA_NOT_EDITABLE` com `meta.reason`); a orientação é manter o rascunho e usar o fluxo de revisão.
- **FA-09 — Referência inativada depois do cadastro:** itens existentes mantêm a referência a categoria/secretaria/responsável inativado (marcada "inativa" na tabela); a próxima edição que altere o campo exige valor ativo, e o envio para aprovação (US-140) lista a pendência.
- **FA-10 — Sem itens e sem resultado:** estado vazio da aba Itens ("Este plano ainda não tem itens. Crie o primeiro ou importe uma planilha") com as ações "Novo item" e "Importar planilha" (US-139); filtro sem resultado mostra "Nenhum item encontrado" e "Limpar filtros".

## Regras de negócio
- **RN-PCA-01** — O plano é do órgão e do exercício; `organizationId`, `year` e `versionNumber` são imutáveis. Há no máximo um plano em `DRAFT` ou `AWAITING_APPROVAL` e no máximo um `APPROVED` por órgão e exercício (DEC-197; unique parciais de `entities.md §4.1`).
- **RN-PCA-02** — O `code` do item é único no plano (entre os não excluídos), normalizado (sem espaços nas pontas, maiúsculas) e estável entre versões (DEC-197).
- **RN-PCA-03** — Item exige secretaria, objeto (10 a 2.000 caracteres), categoria ativa, valor previsto ≥ 0 e mês de 1 a 12; `catalogCode` exige `catalogSystem` informado (DEC-197).
- **RN-PCA-04** — `PCA_MANAGE` com escopo de unidade edita só itens da própria secretaria; criar o plano e excluí-lo exigem escopo `ORGANIZATION` ou `TENANT` (permissions.md §5.1; DEC-197).
- **RN-PCA-06** — Plano e itens são isolados por `tenant_id`; item vinculado a DFD ou processo não é excluído (`PCA_ITEM_IN_USE`) (DEC-197).
- **RN-PCA-07** — O mascaramento do valor previsto de item vinculado a processo com orçamento sigiloso vale na visão por processo (US-142); na SCR-018 o valor é exibido a quem tem `PCA_VIEW` (DEC-030, POL-09).
- **RN-PCA-08** — `CONSULTOR_EXTERNO` não acessa o plano nem os itens (DEC-197, L-07).
- **RN-PCA-12** — Plano fora de `DRAFT` não aceita alteração de itens (POL-22); a regra vale na API (409 `PCA_NOT_EDITABLE`) e no banco (trigger de `pca_items`, ver lacuna 4).
- **RN-PCA-30** — O plano nasce `DRAFT`, `versionNumber = 1`, título padrão "PCA {year}", `organizationId` padrão `tenants.primary_organization_id`, totais zerados. Se já existe qualquer versão do órgão no exercício, a criação é recusada com `PCA_ALREADY_EXISTS`; a nova versão do plano aprovado é a revisão (US-141).
- **RN-PCA-31** — O exercício (`year`) é inteiro de 2000 a 2100; não há outra restrição de data. A UI sugere do ano anterior ao corrente até dois anos à frente.
- **RN-PCA-32** — Só plano `DRAFT` aceita alteração de título, criação, edição e exclusão de item, e exclusão do plano; qualquer outra situação responde 409 `PCA_NOT_EDITABLE`.
- **RN-PCA-33** — Código opcional na criação: se omitido, a API atribui o próximo código numérico livre do plano (maior código inteiro existente + 1, com 4 dígitos no mínimo), sob a trava da linha do plano para não repetir em criações simultâneas.
- **RN-PCA-34** — Formato do código após a normalização: 1 a 60 caracteres, `^[A-Z0-9][A-Z0-9._/-]*$` (letras sem acento, dígitos, ponto, barra, hífen e sublinhado; sem espaços internos). O código é imutável depois de gravado.
- **RN-PCA-35** — Referências do item: `departmentId` — secretaria ativa do órgão do plano e dentro do escopo de quem grava; `categoryId` — item ativo de `PCA_CATEGORY`; `contractingTypeId` — ativo de `CONTRACTING_TYPE`; `unitOfMeasureId` — ativo de `UNIT_OF_MEASURE`; `responsibleId` — usuário com vínculo `ACTIVE` no tenant. Id inexistente, de outro tenant ou fora do escopo → 422 `VALIDATION_ERROR` com `REFERENCE_NOT_FOUND`; inativo → `REFERENCE_INACTIVE` (api.md §1.5), sem revelar existência em outro tenant.
- **RN-PCA-36** — `plannedValue`: decimal com até 2 casas, ≥ 0 e < 10^16 (DEC-003; string no JSON); `plannedMonth`: inteiro de 1 a 12 (o plano é mensal, não trimestral); `quantity` > 0 com até 4 casas; `priority` em `LOW`, `MEDIUM`, `HIGH`, `URGENT` (padrão `MEDIUM`); `catalogSystem` em `CATMAT`, `CATSER`, `OTHER`.
- **RN-PCA-37** — Situação em `DRAFT`: padrão `PLANNED`; transições manuais permitidas `PLANNED → POSTPONED|CANCELED`, `POSTPONED → PLANNED` e, para itens herdados de revisão, `IN_PROGRESS → POSTPONED|CANCELED`; `POSTPONED` e `CANCELED` exigem `statusReason` (10 a 2.000 caracteres); voltar a `PLANNED` limpa o motivo. `IN_PROGRESS` e `CONTRACTED` não são atribuídos à mão em `DRAFT` (nascem do vínculo e da execução — US-142/US-144). Transição fora da lista → 422 com `NOT_ALLOWED` no campo `status`.
- **RN-PCA-38** — Totais: `totalPlannedValue` = soma de `plannedValue` dos itens não excluídos e **não cancelados**; `itemsCount` = itens não excluídos (inclui cancelados). São recalculados na mesma transação de toda escrita de item, sob a trava da linha do plano, e cada recálculo incrementa `Pca.version`. O detalhe (PCA-03) devolve ainda as quebras por secretaria, categoria, mês e situação, calculadas na consulta.
- **RN-PCA-39** — Leituras respeitam o escopo: com escopo de unidade, PCA-05 e PCA-06 devolvem só itens das secretarias do escopo (item de outra secretaria → 404 `NOT_FOUND`), e totais e quebras refletem apenas esses itens; `totalPlannedValue`/`itemsCount` do órgão só com escopo `ORGANIZATION`/`TENANT` (permissions.md §5.1).
- **RN-PCA-40** — Exclusão do item é lógica (`deleted_at`), só em `DRAFT`, recusada com `PCA_ITEM_IN_USE` quando `linkedProcessesCount > 0` ou há `Process`/`Dfd` com `pcaItemId` do item (consulta pela porta `PcaLinkTarget`). Exclusão do plano é física e só para `versionNumber = 1`, `DRAFT`, sem `approvalId` e sem item em uso; leva os itens junto.
- **RN-PCA-41** — Prazo de elaboração: `pca.elaborationDeadline` `{ month, day }` aplicado ao ano anterior ao exercício (31/02 vira o último dia do mês); só é calculado para planos de `versionNumber = 1` ainda não `APPROVED`; dias restantes em dias corridos no fuso do tenant. É informativo: não bloqueia escrita nem gera notificação nesta story.
- **RN-PCA-42** — Listagens: PCA-01 ordena por `-year,-versionNumber` e oculta `SUPERSEDED` por padrão (`includeSuperseded=true` mostra); PCA-06 ordena por `code` (natural: `2` antes de `10`) por padrão e aceita `sort` em `code`, `plannedMonth`, `plannedValue`, `department`, `category`, `status`; paginação padrão `pageSize` ≤ 100; busca `q` (2 a 200 caracteres) sem acento nem caixa em `code` e `object`.
- **RN-PCA-43** — Concorrência: `Pca` e `PcaItem` expõem `ETag` = `version`; `PATCH`/`DELETE` exigem `If-Match` (sem ele, 428 `PRECONDITION_REQUIRED`); divergência → 412 `VERSION_CONFLICT`. Escritas de itens do mesmo plano serializam na trava da linha do plano.
- **RN-PCA-44** — Eventos e logs não carregam valores nem texto livre: `PcaItemChanged` leva ids, `code`, `change`, `status` e `changedFields[]` (nomes de campo); a auditoria guarda `notes` e `statusReason` como `{ sha256, length }`.
- **RN-PCA-45** — Aviso de prazo e totais são leitura derivada: nenhum cálculo de prazo grava dado, e a leitura do plano não gera auditoria.

## Campos
**Plano (diálogo "Novo plano" e "Editar plano")**

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Exercício | `year` | inteiro | Sim | 2000–2100; imutável; RN-PCA-31 | Próximo ano |
| Órgão | `organizationId` | uuid | Não | Órgão do tenant dentro do escopo; imutável | `tenants.primary_organization_id` |
| Título | `title` | texto (200) | Não | 1–200 caracteres; editável em `DRAFT` | `"PCA {year}"` |
| *(saída)* Situação | `status` | `PcaPlanStatus` | — | Somente leitura | `DRAFT` |
| *(saída)* Versão | `versionNumber` | inteiro | — | Somente leitura | `1` |
| *(saída)* Valor previsto total | `totalPlannedValue` | decimal (string) | — | RN-PCA-38 | `"0.00"` |
| *(saída)* Itens | `itemsCount` | inteiro | — | RN-PCA-38 | `0` |
| *(saída)* Prazo de elaboração | `elaborationDeadline { date, daysLeft, isOverdue }` | objeto | — | RN-PCA-41 | `pca.elaborationDeadline` |

**Item (painel "Novo item" / "Editar item")**

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Código | `code` | texto (60) | Não (na criação) | RN-PCA-02, RN-PCA-33, RN-PCA-34; imutável | Próximo livre |
| Secretaria | `departmentId` | uuid | Sim | RN-PCA-35 (DEP-02) | — |
| Objeto | `object` | texto longo (2.000) | Sim | 10–2.000 caracteres | — |
| Categoria | `categoryId` | uuid | Sim | Ativa em `PCA_CATEGORY` (CAT-01) | — |
| Valor previsto (R$) | `plannedValue` | decimal (string) | Sim | ≥ 0, 2 casas; RN-PCA-36 | — |
| Mês previsto | `plannedMonth` | inteiro | Sim | 1–12 (exibido "Janeiro"…"Dezembro") | — |
| Responsável | `responsibleId` | uuid | Não | Vínculo `ACTIVE` (USR-02) | — |
| Situação | `status` | `PcaItemStatus` | Não | RN-PCA-37 | `PLANNED` |
| Motivo da situação | `statusReason` | texto (2.000) | Condicional | Obrigatório em `POSTPONED`/`CANCELED` | — |
| Quantidade | `quantity` | decimal (string) | Não | > 0, 4 casas | — |
| Unidade de medida | `unitOfMeasureId` | uuid | Não | Ativa em `UNIT_OF_MEASURE` | — |
| Sistema de catálogo | `catalogSystem` | `ItemCatalogSystem` | Condicional | `CATMAT`, `CATSER`, `OTHER`; obrigatório se há `catalogCode` | — |
| Código no catálogo | `catalogCode` | texto (30) | Não | Exige `catalogSystem` | — |
| Tipo de contratação | `contractingTypeId` | uuid | Não | Ativo em `CONTRACTING_TYPE` | — |
| Prioridade | `priority` | `Priority` | Não | `LOW`, `MEDIUM`, `HIGH`, `URGENT` | `MEDIUM` |
| Observações | `notes` | texto longo | Não | até 5.000 caracteres | — |

**Filtros da aba Itens (PCA-06)**

| Campo (UI) | Parâmetro | Tipo | Regras |
|---|---|---|---|
| Busca | `q` | texto | 2–200 caracteres, código e objeto |
| Secretaria | `departmentId` | uuid (múltiplo) | Dentro do escopo |
| Categoria | `categoryId` | uuid (múltiplo) | — |
| Mês | `plannedMonth` | 1–12 (múltiplo) | — |
| Situação | `status` | `PcaItemStatus` (múltiplo) | — |
| Responsável | `responsibleId` | uuid | — |
| Valor de / até | `valueFrom`, `valueTo` | decimal | `valueFrom` ≤ `valueTo` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Exercício ausente ou fora de 2000–2100 | Front + API (Zod) | "Informe um exercício entre 2000 e 2100." | `VALIDATION_ERROR` (`REQUIRED`/`OUT_OF_RANGE`) |
| V-02 | Já existe plano do órgão no exercício | API | "Já existe um plano de {ano} para este órgão. Abra o plano existente ou crie uma revisão." | `PCA_ALREADY_EXISTS` |
| V-03 | Título vazio ou acima de 200 caracteres | Front + API | "O título deve ter de 1 a 200 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-04 | Órgão inexistente, de outro tenant ou fora do escopo | API | "Órgão não encontrado." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Código com formato inválido | Front + API | "O código aceita letras, números, ponto, barra, hífen e sublinhado, sem espaços." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-06 | Código já usado no plano | API | "O código {código} já existe neste plano. Use o próximo livre: {sugestão}." | `PCA_ITEM_CODE_DUPLICATED` |
| V-07 | Objeto com menos de 10 ou mais de 2.000 caracteres | Front + API | "Descreva o objeto com 10 a 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-08 | Secretaria inexistente, de outro órgão/tenant ou fora do escopo | API | "Secretaria não encontrada." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-09 | Secretaria, categoria, tipo, unidade ou responsável inativo | API | "{Campo} está inativo. Escolha um valor ativo." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-10 | Categoria ausente ou que não é do catálogo `PCA_CATEGORY` | Front + API | "Escolha a categoria." | `VALIDATION_ERROR` (`REQUIRED`/`REFERENCE_NOT_FOUND`) |
| V-11 | Valor previsto ausente, negativo, com mais de 2 casas ou ≥ 10^16 | Front + API | "Informe um valor previsto válido (zero ou mais, com até 2 casas)." | `VALIDATION_ERROR` (`INVALID_DECIMAL`/`OUT_OF_RANGE`) |
| V-12 | Mês previsto fora de 1–12 | Front + API | "Escolha o mês previsto de janeiro a dezembro." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-13 | Quantidade ≤ 0 ou com mais de 4 casas | Front + API | "A quantidade deve ser maior que zero." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-14 | `catalogCode` sem `catalogSystem` | Front + API | "Informe o sistema do catálogo (CATMAT, CATSER ou outro)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-15 | `POSTPONED`/`CANCELED` sem motivo (10–2.000) | Front + API | "Informe o motivo (mínimo de 10 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) |
| V-16 | Situação atribuída à mão não permitida (`IN_PROGRESS`, `CONTRACTED`) ou transição fora da RN-PCA-37 | API | "Esta situação não pode ser definida manualmente." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-17 | Tentativa de alterar `code`, `year`, `organizationId` ou `pcaId` | API | "Este campo não pode ser alterado." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-18 | Plano fora de `DRAFT` | API | "Este plano não pode mais ser editado. Para alterar o plano aprovado, crie uma revisão." | `PCA_NOT_EDITABLE` |
| V-19 | Item em uso (vinculado a processo ou DFD) na exclusão | API | "Este item está vinculado a processos ou DFDs e não pode ser excluído." | `PCA_ITEM_IN_USE` |
| V-20 | `If-Match` ausente ou divergente | API | "Outra pessoa alterou este registro. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-21 | Filtros inválidos (`valueFrom` > `valueTo`, enum, `pageSize` > 100, `q` curto) | Front + API | "Revise os filtros informados." | `VALIDATION_ERROR` |
| V-22 | Exclusão do plano com histórico, versão > 1 ou item em uso | API | "Este plano não pode ser excluído." | `PCA_NOT_EDITABLE` (`meta.reason`) |
| V-23 | Responsável sem vínculo ativo no tenant | API | "Responsável não encontrado neste órgão." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |

## Permissões
- **Permissão:** `PCA_VIEW` para PCA-01, PCA-03 e PCA-06; `PCA_MANAGE` para PCA-02, PCA-04, PCA-05, PCA-07, PCA-08 e PCA-09. Escopo conforme permissions.md §5.1: criar, editar o título e excluir o plano exigem `ORGANIZATION`/`TENANT`; itens exigem escopo que cubra a secretaria do item.
- **Políticas:** POL-22 (elaboração só em `DRAFT`, escopo da §5.1); POL-09 aplicada na visão por processo (não aqui); DEC-024 não se aplica (PCA não é processo).
- **MFA:** não exigido (`PCA_VIEW` risco L, `PCA_MANAGE` risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o item de menu "Planejamento › PCA" some sem `PCA_VIEW`; ações de escrita ficam ocultas sem `PCA_MANAGE`. A API responde 403 `PERMISSION_DENIED` (registra `access.denied` com `reasonCode` da permissão) em qualquer rota para quem não tem a permissão, inclusive `CONSULTOR_EXTERNO`; plano ou item de outro tenant, inexistente ou de secretaria fora do escopo → 404 `NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PcaCreated` | `pca.created` | Commit de PCA-02 | `pcaId`, `organizationId`, `year`; consumidor M |
| `PcaItemChanged` | `pca.item_changed` | Commit de PCA-07 (`CREATED`), PCA-08 (`UPDATED` ou `STATUS_CHANGED`), PCA-09 e PCA-05 (`DELETED`, um por item) | `pcaId`, `pcaItemId`, `code`, `change`, `status`, `changedFields[]` (nomes, sem valores); consumidor R |

Sem evento para a alteração de título (auditoria `pca.update`). Nenhum evento é gerado em leitura, em validação recusada ou em rollback.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: edição de rascunho é ação do próprio usuário. O prazo de elaboração é só exibido (RN-PCA-41); não há tipo de notificação de prazo do PCA (ver lacuna 5). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar o plano anual e manter os itens do PCA

  Background:
    Given que o tenant "Prefeitura A" está ativo com o órgão "Prefeitura Municipal" e as secretarias "Saúde" e "Educação"
    And o catálogo "PCA_CATEGORY" tem as categorias ativas "MATERIAL", "SERVICO" e "OBRA"
    And "Helena" tem vínculo ativo e "PCA_MANAGE" com escopo "ORGANIZATION" no órgão
    And "pca.elaborationDeadline" é 30/06 e hoje é 18/06/2026

  Scenario: [Sucesso] Criar o plano do exercício
    When "Helena" criar o plano do exercício 2027 sem informar título
    Then a API deve responder 201 com o plano "PCA 2027" em "DRAFT", versão 1, "totalPlannedValue" "0.00" e "itemsCount" 0
    And a resposta deve trazer "elaborationDeadline" com data "2026-06-30", "daysLeft" 12 e "isOverdue" falso
    And deve gerar registro de auditoria "pca.create"
    And deve gerar o evento "PcaCreated"

  Scenario: [Sucesso] Criar item com código automático e recalcular os totais
    Given que o plano "PCA 2027" está em "DRAFT" e vazio
    When "Helena" criar o item da secretaria "Saúde", categoria "MATERIAL", objeto "Aquisição de medicamentos da farmácia básica", valor "125000.50", mês 3, sem informar o código
    Then a API deve responder 201 com o item de código "0001", situação "PLANNED" e prioridade "MEDIUM"
    And o plano deve ter "itemsCount" 1 e "totalPlannedValue" "125000.50"
    And deve gerar registro de auditoria "pca.item_create"
    And deve gerar o evento "PcaItemChanged" com "change" "CREATED" e sem valor monetário no payload

  Scenario: [Sucesso] Editar valor e cancelar item atualiza os totais
    Given que o item "0001" vale "125000.50" e existe o item "0002" de "40000.00"
    When "Helena" alterar o valor do item "0001" para "130000.00" com o "If-Match" atual
    Then o plano deve ter "totalPlannedValue" "170000.00" e a auditoria "pca.item_update" deve registrar o valor antes e depois
    When "Helena" mudar o item "0002" para "CANCELED" com o motivo "Demanda atendida por ata de registro de preços vigente"
    Then o plano deve ter "totalPlannedValue" "130000.00" e "itemsCount" 2
    And deve gerar o evento "PcaItemChanged" com "change" "STATUS_CHANGED"

  Scenario: [Sucesso] Filtrar e buscar itens com totais do conjunto filtrado
    Given que o plano tem 3 itens da "Saúde" e 2 da "Educação"
    When "Helena" listar os itens com "departmentId" da "Saúde" e "plannedMonth" 3
    Then a lista deve conter somente itens da "Saúde" previstos para março
    And "meta.filteredPlannedValue" deve ser a soma desses itens

  Scenario: [Sucesso] Responsável de secretaria edita apenas os itens da própria secretaria
    Given que "Rui" tem "PCA_MANAGE" com escopo "DEPARTMENT" na "Saúde"
    When "Rui" listar os itens do plano
    Then a lista deve conter somente itens da "Saúde" e "meta.scope" deve ser "DEPARTMENTS"
    When "Rui" editar um item da "Saúde"
    Then a API deve responder 200

  Scenario: [Validação] Item com dados inválidos
    When "Helena" criar item com objeto "curto", valor "-10", mês 13 e "catalogCode" "123456" sem "catalogSystem"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erros "TOO_SHORT" em "object", "INVALID_DECIMAL" em "plannedValue", "OUT_OF_RANGE" em "plannedMonth" e "CONDITIONAL_REQUIRED" em "catalogSystem"
    And nenhum item, auditoria ou evento deve ser gravado

  Scenario: [Validação] Situação manual não permitida e motivo obrigatório
    When "Helena" definir a situação "CONTRACTED" em um item de plano "DRAFT"
    Then a API deve responder 422 com erro "NOT_ALLOWED" no campo "status"
    When "Helena" definir "POSTPONED" sem motivo
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" no campo "statusReason"

  Scenario: [Validação] Plano fora de rascunho não aceita alteração
    Given que o plano "PCA 2027" está "AWAITING_APPROVAL"
    When "Helena" criar, editar ou excluir um item
    Then a API deve responder 409 com código "PCA_NOT_EDITABLE"
    And a aba Itens deve abrir em leitura

  Scenario: [Permissão] Sem PCA_MANAGE, sem escopo e consultoria externa
    Given que "Bruno" tem apenas "PCA_VIEW"
    When "Bruno" tentar criar um item
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Rui" tem "PCA_MANAGE" com escopo "DEPARTMENT" na "Saúde"
    When "Rui" tentar criar o plano do exercício 2028
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Rui" tentar criar um item da "Educação"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" no campo "departmentId"
    Given que "Caio" é "CONSULTOR_EXTERNO"
    When "Caio" chamar "GET /pcas"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Plano, item e referências de outro tenant
    Given que existe o plano "PCA 2027" e o item "0001" no tenant "Prefeitura B"
    When "Helena", no tenant "Prefeitura A", chamar "GET /pcas/{id}" e "PATCH /pca-items/{id}" com os ids do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND" nas duas chamadas
    When "Helena" criar um item com a "departmentId" ou a "categoryId" do tenant "Prefeitura B"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" sem revelar se o recurso existe
    And a lista "GET /pcas" não deve conter planos do tenant "Prefeitura B"

  Scenario: [Duplicidade] Plano do exercício, código de item e reenvio idempotente
    Given que o plano "PCA 2027" do órgão já existe
    When "Helena" criar outro plano para 2027
    Then a API deve responder 409 com código "PCA_ALREADY_EXISTS" e "meta.existingPcaId" do plano existente
    Given que o item "0001" existe no plano
    When "Helena" criar um item com o código " 0001 "
    Then a API deve responder 409 com código "PCA_ITEM_CODE_DUPLICATED"
    Given que "Helena" criou um item com a chave "k-138" e recebeu 201
    When a mesma requisição for reenviada com a chave "k-138"
    Then a API deve responder 201 com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir um único item e um único evento "PcaItemChanged" de criação

  Scenario: [Concorrência] Duas pessoas editam o mesmo item e criam itens ao mesmo tempo
    Given que "Helena" e "Marina" abriram o item "0001" na versão 4
    When "Helena" salvar com "If-Match" 4 e depois "Marina" salvar com "If-Match" 4
    Then a segunda resposta deve ser 412 "VERSION_CONFLICT" com o item atual em "meta.current"
    When "Helena" e "Marina" criarem itens sem código ao mesmo tempo
    Then os dois itens devem ser criados com códigos diferentes e o plano deve ter totais iguais à soma dos itens
    When as duas criarem o plano de 2028 ao mesmo tempo
    Then uma resposta deve ser 201 e a outra 409 "PCA_ALREADY_EXISTS"

  Scenario: [Falha de banco] Banco falha ao gravar o item ou recalcular os totais
    Given que o banco de dados falha durante a transação de criação do item
    When "Helena" salvar o item
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum item, total alterado, auditoria ou evento deve ter sido gravado
    And o painel deve manter os dados digitados com o botão "Tentar novamente"

  Scenario: [Falha de integração] Redis de cache e idempotência indisponível
    Given que o Redis está indisponível
    When "Helena" criar um item e listar os itens
    Then a API deve responder 201 e 200 lendo permissões, catálogos e configuração direto do banco
    And deve ser registrado log "warn" "cache.store_unavailable"
    And o prazo de elaboração deve usar o padrão 30/06 se a configuração não puder ser lida
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão (inclui `CONSULTOR_EXTERNO`) | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação no PCA." | Oculta a ação; no acesso direto, mostra a página de acesso negado |
| Plano ou item inexistente, de outro tenant ou fora do escopo | 404 | `NOT_FOUND` | "Plano ou item não encontrado." | Volta à lista de planos |
| Plano do exercício já existe | 409 | `PCA_ALREADY_EXISTS` | "Já existe um plano de {ano} para este órgão." | Oferece "Abrir o plano de {ano}" |
| Plano fora de `DRAFT` | 409 | `PCA_NOT_EDITABLE` | "Este plano não pode mais ser editado." | Abre em leitura e recarrega |
| Código de item repetido | 409 | `PCA_ITEM_CODE_DUPLICATED` | "O código {código} já existe neste plano." | Marca o campo e sugere o próximo livre |
| Item em uso | 409 | `PCA_ITEM_IN_USE` | "Este item está vinculado a processos ou DFDs e não pode ser excluído." | Fecha o diálogo e mostra o motivo |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue o registro e tente de novo." | Recarrega |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou este registro. Recarregue e tente de novo." | Mostra o valor atual e oferece "Recarregar" |
| Campos inválidos | 422 | `VALIDATION_ERROR` | Mensagens por campo (V-01 a V-23) | Marca cada campo com a mensagem |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém o formulário |

## Dependências
- **Stories:** US-097 (autorização por permissão, escopo e `meta.allowedActions`), US-102 (órgão e secretarias), US-104 (catálogos `PCA_CATEGORY`, `CONTRACTING_TYPE`, `UNIT_OF_MEASURE`). Indiretas: US-103 (SET-02 para o calendário do plano), US-092 (USR-02). Habilita US-139 (importação), US-140 (envio para aprovação), US-141 (revisão), US-142 (vínculo), US-144 e US-145.
- **Decisões/ADRs:** DEC-197 (PCA como módulo), DEC-029, DEC-030, DEC-003 (decimais), DEC-104 (`If-Match`), DEC-105 (idempotência), DEC-106 (envelope), DEC-108 (compatibilidade).
- **Configurações:** `pca.elaborationDeadline` (`{ month: 1..12, day: 1..31 }`, padrão 30/06 do exercício anterior).
- **Lacunas nas fontes canônicas:**
  1. **Rotas e IDs:** a feature FT-068 lista `/pca`, `/pca/{id}/items` e `/pca-items/{itemId}`; esta story adota `/api/v1/pcas`, `/api/v1/pcas/{pcaId}/items` e `/api/v1/pca-items/{itemId}` e os IDs `PCA-01` a `PCA-09` (a consolidar em `api.md` do MVP 2). `GET` de item avulso não foi criado: o item completo vem na lista e nas respostas de escrita.
  2. **Códigos de erro novos:** `PCA_ALREADY_EXISTS` (409), `PCA_ITEM_CODE_DUPLICATED` (409); `PCA_NOT_EDITABLE` (POL-22) e `PCA_ITEM_IN_USE` (RN-PCA-06) já existem nas fontes e são adotados com os significados acima.
  3. **Ação de auditoria `pca.delete`** (DATA_CHANGE) para a exclusão do plano (`entities.md §4.1` permite o `DELETE` físico do `DRAFT` v1, mas `events.md §7` não tem a ação). Sem evento próprio: cada item excluído emite `PcaItemChanged` (`DELETED`).
  4. **Trigger de imutabilidade:** `entities.md §4.1` bloqueia itens de plano `APPROVED`/`SUPERSEDED`; propõe-se estender o bloqueio a `AWAITING_APPROVAL` (todas as colunas), para que a regra valha também contra escrita fora da API.
  5. **Prazo de elaboração do PCA:** `pca.elaborationDeadline` existe, mas não há evento nem `NotificationType` de lembrete (ver `events.md §6`); o aviso é só visual. **Dúvida de produto:** notificar `PLANEJAMENTO` quando o prazo vencer sem plano enviado?
  6. **Atribuição automática do código** (RN-PCA-33) e o formato do código (RN-PCA-34) não estão nas fontes (só "normalizado, sem espaços nas pontas, maiúsculas"); adotados como proposta. **Dúvida de produto:** os órgãos usam códigos próprios com outros símbolos (ex.: espaços, acentos)?
  7. **Itens `CANCELED` nos totais:** `itemsCount` conta itens cancelados e `totalPlannedValue` não (RN-PCA-38); `entities.md` só define a regra do valor.
  8. **Exercício livre:** nenhuma regra de janela de exercício (ex.: recusar exercício muito antigo); adotado só o intervalo 2000–2100 da entidade.

## Impacto técnico
- **Performance:** listas com índices `(tenant_id, pca_id, department_id|category_id|status)` e um novo `(tenant_id, pca_id, planned_month)`; busca `q` por `ILIKE` com trigram em `object` e prefixo em `code`; meta de p95 ≤ 500 ms para PCA-06 em planos de 2.000 itens e ≤ 300 ms para PCA-03 (quebras agregadas por `GROUP BY` na consulta, sem tabela auxiliar).
- **Concorrência e totais:** todas as escritas de item travam a linha do plano (`SELECT … FOR UPDATE`) por poucos milissegundos para atribuir código, validar o estado e recalcular os totais; a trava é por plano, sem contenção entre tenants. A importação (US-139) usa a mesma trava durante a aplicação.
- **Consistência dos totais:** `totalPlannedValue`/`itemsCount` são derivados; um teste de propriedade confere, após sequências aleatórias de escritas, que o total é igual à soma dos itens; a US-143/US-144 não recalculam, apenas leem.
- **Compatibilidade:** nenhuma mudança em entidade do MVP 1; `pcas` e `pca_items` entram na migração M2-11 (`expand`, reversível); `PcaItem.status` e o enum `PcaItemStatus` já existem para as stories seguintes.
- **Segurança:** valores e texto do objeto não vão a logs; nomes e e-mails de responsáveis não vão a eventos; consultas sempre filtradas por escopo antes da paginação; id de outro tenant → 404 pelo RLS e pelo filtro de aplicação.
- **Evolução:** o escopo por unidade já nasce nas consultas para que a US-144 (execução por secretaria) e a US-145 (exportação) reaproveitem o mesmo predicado.

## Backend
- **Módulo(s):** `pca` (dono de `Pca` e `PcaItem`); `organization` (secretarias e escopo), `catalog` (categorias e demais catálogos), `access` (permissões e escopos), `audit`, `platform` (outbox, cache e idempotência).
- **Casos de uso:** `CreatePcaCommand`, `UpdatePcaCommand` (título), `DeletePcaCommand`, `GetPcaQuery` (com `PcaTotalsQuery` e `ElaborationDeadlineCalculator`), `ListPcasQuery`, `ListPcaItemsQuery`, `CreatePcaItemCommand`, `UpdatePcaItemCommand`, `DeletePcaItemCommand`.
- **Domínio:** `Pca` (invariantes de estado e imutabilidade), `PcaItem` (código normalizado, transições manuais de situação — RN-PCA-37), `PcaCode` (value object de normalização e formato), `PcaTotals` (recálculo), `PcaScope` (predicado de cobertura por organização/secretaria), `PcaEditGuard` (`PCA_NOT_EDITABLE`).
- **Integrações internas:** `OrganizationFacade` (secretaria ativa, árvore do escopo), `CatalogFacade` (itens ativos por `catalogType`), `AccessFacade` (escopo efetivo do usuário), `IdentityFacade` (vínculo `ACTIVE` do responsável), porta `PcaLinkTarget` (consulta de vínculos para `PCA_ITEM_IN_USE`), `SettingsFacade` (`pca.elaborationDeadline`), `OutboxWriter`, `AuditService`.
- **Transação:** com `app.tenant_id`: autorização → trava do plano → validações → escrita do item → recálculo dos totais e `version` do plano → auditoria → outbox (um `PcaItemChanged` por item afetado) → commit. Falha em qualquer passo desfaz tudo.

## Frontend
- **Tela(s):** SCR-018 (`/pca` lista; `/pca/[pcaId]` detalhe com abas "Itens" e "Resumo", mais as abas das stories seguintes); SCR-041 (`/admin/configuracoes`) para o calendário do plano via SET-02.
- **Componentes:** `PcaListTable` com `FilterPanel` aberto (Exercício, Situação) e "Mais filtros" para o resto; `PcaCreateDialog`; `PcaStatusBadge`; `PcaDeadlineBanner`; `PcaItemsTable` (colunas Código, Secretaria, Objeto, Categoria, Mês, Valor previsto, Responsável, Situação; ordenação, paginação e chips só dos filtros extras); `PcaItemDrawer` (formulário em duas seções, "Mais campos" recolhido, contador de caracteres do objeto, campo de moeda BRL); `PcaTotalsSummary` (cartões e tabelas por secretaria, categoria, mês e situação); `ConfirmDeleteDialog`; mensagens de erro por campo.
- **Estados:** loading (skeleton da tabela e dos totais), vazio ("Este plano ainda não tem itens…" com ações), erro (mensagem e "Tentar novamente"), sucesso (toast "Item salvo"), leitura (faixa de situação do plano), conflito (412 com "Recarregar"), lista filtrada sem resultado.
- **Acessibilidade e responsividade:** tabela com cabeçalhos associados e ordenação anunciada; situação do item e do plano por texto e ícone, nunca só por cor; valores alinhados à direita com `aria-label` completo ("Valor previsto: R$ 125.000,50"); drawer com foco preso e fechamento por Esc; formulário em coluna única abaixo de 768 px e tabela em cartões; contraste AA; totais atualizados anunciados por `aria-live` ao salvar.

## Banco de dados
- **Tabelas:** `pcas` e `pca_items` (módulo `pca`, `entities.md §4.1`); leitura de `organizations`, `departments`, `catalog_items`, `users`/`memberships`, `tenant_settings`; `audit_logs`, `outbox_events`.
- **Migrações:** M2-11 (`expand`, reversível): criação de `pcas`, `pca_items` com FKs compostas por `tenant_id`, RLS por `tenant_id`, triggers de imutabilidade (`organization_id`, `year`, `version_number`; `pca_id`, `code`) e `deleted_at` em `pca_items`; sementes de `PCA_CATEGORY` e da chave `pca.elaborationDeadline` em M2-21.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, organization_id, year, version_number)`; `UNIQUE (tenant_id, organization_id, year) WHERE status IN ('DRAFT','AWAITING_APPROVAL')`; `UNIQUE (tenant_id, organization_id, year) WHERE status = 'APPROVED'`; `UNIQUE (tenant_id, pca_id, code) WHERE deleted_at IS NULL`; `CHECK planned_value >= 0`, `planned_month BETWEEN 1 AND 12`, `quantity IS NULL OR quantity > 0`, `status NOT IN ('POSTPONED','CANCELED') OR status_reason IS NOT NULL`, `catalog_code IS NULL OR catalog_system IS NOT NULL`, `code ~ '^[A-Z0-9][A-Z0-9._/-]{0,59}$'`; índices `(tenant_id, year, status)`, `(tenant_id, pca_id, department_id|category_id|status|planned_month)` e `(tenant_id, code)` (reconciliação); trigram em `object`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-01` | GET | `/api/v1/pcas` | query `year`, `status` (múltiplo), `organizationId`, `q`, `includeSuperseded`, `page`, `pageSize`, `sort` (`-year,-versionNumber`) | `200 { data: Pca[], meta }` (sem itens; totais do órgão só com escopo de órgão) | 200, 403, 422 |
| `PCA-02` | POST | `/api/v1/pcas` | `{ year, organizationId?, title? }` + `Idempotency-Key` | `201 { data: Pca }` + `Location`, `ETag` | 201, 403, 409, 422, 503 |
| `PCA-03` | GET | `/api/v1/pcas/{pcaId}` | — | `200 { data: Pca, meta: { allowedActions, scope, elaborationDeadline, totals { byDepartment[], byCategory[], byMonth[], byStatus[] } } }` + `ETag` | 200, 403, 404 |
| `PCA-04` | PATCH | `/api/v1/pcas/{pcaId}` | `{ title }` + `If-Match` | `200 { data: Pca }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428 |
| `PCA-05` | DELETE | `/api/v1/pcas/{pcaId}` | `If-Match` | `204` | 204, 403, 404, 409, 412, 428 |
| `PCA-06` | GET | `/api/v1/pcas/{pcaId}/items` | query `q`, `departmentId`, `categoryId`, `plannedMonth`, `status`, `responsibleId`, `valueFrom`, `valueTo`, `page`, `pageSize`, `sort` | `200 { data: PcaItem[], meta: { page, pageSize, totalItems, totalPages, filteredPlannedValue, scope } }` | 200, 403, 404, 422 |
| `PCA-07` | POST | `/api/v1/pcas/{pcaId}/items` | corpo do item (campos da tabela) + `Idempotency-Key` | `201 { data: PcaItem }` + `Location`, `ETag` | 201, 403, 404, 409, 422, 503 |
| `PCA-08` | PATCH | `/api/v1/pca-items/{itemId}` | campos alteráveis (sem `code`) + `If-Match` | `200 { data: PcaItem }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428 |
| `PCA-09` | DELETE | `/api/v1/pca-items/{itemId}` | `If-Match` | `204` | 204, 403, 404, 409, 412, 428 |
| `DEP-02` | GET | `/api/v1/departments/lookup` | seletor de secretaria (existente) | secretarias ativas do órgão | 200 |
| `CAT-01` | GET | `/api/v1/catalogs/{catalogType}/items` | `PCA_CATEGORY`, `CONTRACTING_TYPE`, `UNIT_OF_MEASURE` (existente) | itens ativos | 200 |
| `USR-02` | GET | `/api/v1/users/lookup` | seletor de responsável (existente) | usuários com vínculo ativo | 200 |
| `SET-02` | PATCH | `/api/v1/settings` | `pca.elaborationDeadline` (existente; `SETTINGS_MANAGE`) | `200` | 200, 403, 422 |

- **Cabeçalhos:** `Idempotency-Key` obrigatório em PCA-02 e PCA-07; `If-Match` obrigatório em PCA-04, PCA-05, PCA-08 e PCA-09.
- **`PcaItem` (resposta):** `id`, `pcaId`, `code`, `department { id, name, acronym, isActive }`, `object`, `category { id, code, label, isActive }`, `plannedValue` (string), `plannedMonth`, `responsible { id, name, isActive } | null`, `status`, `statusReason`, `quantity`, `unitOfMeasure`, `catalogSystem`, `catalogCode`, `contractingType`, `priority`, `notes`, `linkedProcessesCount`, `importRowNumber`, `version`, `createdAt`, `updatedAt`.
- **`meta.allowedActions`:** `UPDATE`, `DELETE`, `CREATE_ITEM`, `IMPORT` (US-139), `SUBMIT` (US-140), conforme permissão, escopo e situação do plano.

## Logs
- `info` `pca.created` — `pcaId`, `year`, `organizationId`, `durationMs`.
- `info` `pca.item_written` — `pcaId`, `pcaItemId`, `change`, `changedFields[]`, `itemsCount`, `durationMs`.
- `info` `pca.deleted` e `pca.item_deleted` — ids.
- `warn` `pca.write_rejected` — `reason` (`PCA_NOT_EDITABLE`, `PCA_ALREADY_EXISTS`, `PCA_ITEM_CODE_DUPLICATED`, `PCA_ITEM_IN_USE`, `VERSION_CONFLICT`), `pcaId`.
- `warn` `cache.store_unavailable` — Redis fora (leitura direta do banco).
- `error` `pca.write_failed` — `errorCode`, `pcaId`, `correlationId`.
- Métricas: `cf_pca_write_duration_ms{operation}`, `cf_pca_items_query_duration_ms`.
- **Nunca logar:** objeto, observações, motivo da situação, valores previstos, nome ou e-mail do responsável.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.create` | `DATA_CHANGE` | Commit de PCA-02 | `changes`: `year`, `organizationId`, `title`; `metadata`: `pcaId`, `versionNumber` |
| `pca.update` | `DATA_CHANGE` | Commit de PCA-04 | `changes.title` antes/depois |
| `pca.delete` | `DATA_CHANGE` | Commit de PCA-05 (ver lacuna 3) | `metadata`: `pcaId`, `year`, `itemsCount` |
| `pca.item_create` | `DATA_CHANGE` | Commit de PCA-07 | `changes`: campos do item (`notes` e `statusReason` como `{ sha256, length }`); `metadata`: `pcaId`, `pcaItemId`, `code` |
| `pca.item_update` | `DATA_CHANGE` | Commit de PCA-08 (campos alterados) | `changes`: antes/depois por campo; `metadata`: `pcaId`, `pcaItemId`, `code` |
| `pca.item_status_change` | `DATA_CHANGE` | PCA-08 quando `status` muda | `changes.status` antes/depois; `metadata.hasReason` |
| `pca.item_delete` | `DATA_CHANGE` | Commit de PCA-09 e PCA-05 | `metadata`: `pcaId`, `pcaItemId`, `code` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = `PCA_VIEW` ou `PCA_MANAGE`, `pcaId?` |

## Testes necessários
- **Unitários:** `PcaCode` (normalização, formato, próximo código com e sem lacunas); transições de situação (RN-PCA-37); `PcaTotals` (cancelados fora do valor, dentro da contagem); `ElaborationDeadlineCalculator` (31/02, ano bissexto, vencido, versão > 1); `PcaScope` (organização, secretaria, subárvore); `PcaEditGuard` por situação do plano.
- **Integração (Testcontainers PostgreSQL + Redis):** criação do plano e dos itens com RLS; unique parciais (plano duplicado, plano em elaboração × aprovado); trava do plano e códigos automáticos concorrentes; recálculo atômico; triggers de imutabilidade (`code`, `year`, plano fora de `DRAFT`); exclusão lógica liberando o código; exclusão do plano com e sem histórico; rollback total sem evento nem auditoria.
- **API/contrato:** PCA-01 a PCA-09 conforme tabela (códigos, `ETag`, `Idempotent-Replayed`, `meta`); mensagens e `errors[].code`; teste de propriedade "total = soma dos itens não cancelados".
- **RBAC e multi-tenant:** matriz `PCA_VIEW`/`PCA_MANAGE` × perfis × escopos (organização e secretaria); `CONSULTOR_EXTERNO` 403; ids de outro tenant → 404 e referências de outro tenant → 422 (suíte `test/tenant-leak`, inclusive listas).
- **Concorrência:** duas edições do mesmo item (412); criações simultâneas de plano e de item; edição durante a aplicação de importação (serializa).
- **E2E (Playwright):** criar plano, cadastrar itens, filtrar, editar, cancelar, excluir, ver o resumo; leitura com plano `APPROVED`; usuário de secretaria; prazo vencido.
- **Acessibilidade/performance:** axe na lista, no detalhe e no drawer; navegação por teclado na tabela; PCA-06 com 2.000 itens dentro da meta (medido no endurecimento).

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
- [ ] Migração M2-11 (`pcas`, `pca_items`) com reversão testada e RLS verificada
- [ ] Teste de propriedade dos totais e de escopo por secretaria passando

## Estimativa
**L** — duas entidades novas com invariantes de estado, escopo por organização e secretaria, códigos estáveis com geração segura sob concorrência, totais derivados na mesma transação, nove endpoints, tela de lista e detalhe com formulário completo, filtros, totais e prazo; é a base de todas as stories do épico.

## Prioridade
**P1** — sem o plano e os itens não há aprovação, vínculo com DFD, reconciliação nem execução; é o primeiro card do EP-023 e pré-requisito da US-139 e da US-140, mas não bloqueia o fechamento da fase preparatória do MVP 2 que não use o plano.
