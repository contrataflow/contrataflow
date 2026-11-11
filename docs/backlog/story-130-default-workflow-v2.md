---
id: US-130
title: "Workflow padrão v2 da fase preparatória e oferta de adoção"
epic: EP-021
feature: FT-065
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-042, US-045, US-129, US-148, US-155, US-161, US-168]
modules: [workflow, process, notification, access, audit, platform]
screens: [SCR-034]
endpoints: [WF-62, WF-63, WF-64]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH]
events: [WorkflowSeedVersionOffered, WorkflowSeedVersionAdopted, WorkflowVersionPublished]
---

# US-130 — Workflow padrão v2 da fase preparatória e oferta de adoção

## Título
Semear a v2 do workflow padrão da fase preparatória (e da contratação direta) e oferecê-la ao órgão sem impô-la

## Descrição
**Como** administrador do órgão, **quero** receber a versão 2 do workflow padrão — com dotação, minuta do edital, análise jurídica, controle interno e autorização da licitação — publicada sozinha quando eu uso o padrão sem alterações e **oferecida** (com as diferenças à vista) quando já personalizei o meu fluxo, **para** adotar a fase preparatória completa no meu ritmo, sem que nenhum processo em andamento mude de versão e sem perder a minha personalização.

A story entrega o *seeder* incremental da v2 das duas definições semeadas ("Fase preparatória — Lei 14.133/2021" e "Contratação direta"), a classificação do tenant como "sem customização" (`WorkflowVersion.seedVersion`, comparado por `definitionHash`), a **publicação automática** só para quem usa o padrão intacto, a **oferta** (`Workflow.offeredSeedVersion`, evento e notificação) para os demais, e as ações do administrador na SCR-034: consultar a oferta com a comparação, **adotar** (cria uma nova versão `DRAFT` copiada da semente) e **dispensar**. Nenhum processo é migrado aqui: a migração é sempre pedida (DEC-195, FT-064) e a continuação dos processos já concluídos na v1 é a US-131.

## Contexto
- O workflow padrão do MVP 1 tem sete etapas e termina em `CONCLUSAO` ("Planejamento da contratação concluído"; DEC-015, US-042). A fase preparatória da Lei 14.133/2021 exige ainda dotação, minuta do edital, parecer jurídico (art. 53) e manifestação do Controle Interno (art. 169, II). A DEC-196 resolve a lacuna L-04 e fixa a v2 com as etapas 7 a 12, **a validar com o jurídico do piloto** (overview §7): por isso a ordem Jurídico × Controle Interno é configurável por tenant, na versão do próprio tenant.
- Roadmap §4.10: tenants que customizaram o workflow padrão recebem a nova versão **oferecida para adoção, nunca imposta**. DEC-196: publicação automática só onde o padrão está sem customização; os demais recebem a oferta (cópia como nova versão `DRAFT` do próprio workflow).
- DEC-014/RN-WF-67: processos fixam `workflowVersionId` na criação; publicar versão nova não afeta processos em andamento, e o MVP 2 só os leva a outra versão por `WorkflowMigration` (DEC-195, RN-WF2-21 da feature).
- As regras de saída das etapas novas são conteúdo de outros épicos: a de dotação vem da US-148 (compatibilidade da dotação com o valor estimado e regra de saída da etapa), a do jurídico da US-155 (concluir a análise com a situação conclusiva), a do controle interno da US-161 (emitir a manifestação e concluir com a situação) e a do edital da US-168 (concluir a minuta do edital). Esta story **referencia** essas definições, não as reescreve (única dependência "de volta" do MVP 2).
- Os provedores do `RuleContext` v2 (US-129) alimentam essas regras; módulos não dependem da v2 semeada e testam com versões de workflow próprias.

## Objetivo
Garantir que 100% dos tenants que usam o padrão sem customização tenham a v2 publicada e que 100% dos demais tenham a oferta resolvida (adotada ou dispensada), sem nenhum processo em andamento trocar de versão e sem alterar a versão publicada de quem personalizou.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_VIEW`, `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH`).
- **Secundárias:** Gestor de contratações (acompanha os novos processos na fase preparatória completa; `WORKFLOW_VIEW`); Sistema (ator `SYSTEM`: *seeder* e publicação automática); Auditor e Controle Interno (leem a trilha de adoção).

## Pré-condições
- As quatro regras de saída (US-148, US-155, US-161, US-168) e o `RuleContext` v2 (US-129) estão entregues e registrados; sem isso o *seeder* da v2 não roda para o tenant (RN-WF2-100).
- O tenant tem o workflow semeado (`key` `DEFAULT_PREPARATORY` e/ou `DIRECT_CONTRACTING_ART72`, RN-WF-34) ativo e com versão publicada.
- Para consultar a oferta: `WORKFLOW_VIEW`. Para adotar: `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH`. Para dispensar: `WORKFLOW_PUBLISH`.
- Configuração `workflow.offerSeedUpdates = true` (padrão) — com `false` o tenant não recebe oferta nem publicação automática (RN-WF2-95).

## Fluxo principal
1. A implantação do MVP 2 executa o `TenantSeeder` incremental (`applyToExistingTenants`), passo "workflows padrão v2", em uma transação por tenant e por workflow semeado.
2. Para cada workflow com versão publicada, o *seeder* liga o workflow à semente (`Workflow.seedKey` = `PREPARATORY_PHASE` ou `DIRECT_CONTRACTING`) e calcula o `definitionHash` canônico da versão publicada; se for igual ao da semente v1, grava `WorkflowVersion.seedVersion = 1` (padrão intacto), senão deixa nulo (customizado).
3. **Tenant sem customização** (`seedVersion` preenchido, sem rascunho aberto e `workflow.offerSeedUpdates = true`): o *seeder* cria a nova versão com a definição da v2 (`versionNumber = máx + 1`, `seedVersion = 2`), roda a validação interna (WF-20) sem erros, publica (a anterior vira `RETIRED`), atualiza `currentPublishedVersionId` e emite `WorkflowVersionPublished` e `WorkflowSeedVersionAdopted` (`automatic = true`), com auditoria de ator `SYSTEM`.
4. **Tenant com customização** (ou com rascunho aberto): o *seeder* só grava `offeredSeedVersion = 2`, emite `WorkflowSeedVersionOffered` e a notificação `WORKFLOW_VERSION_OFFERED` chega aos vínculos com `WORKFLOW_PUBLISH` (máx. 50).
5. O administrador abre a SCR-034 do workflow e vê a faixa "Nova versão do fluxo padrão disponível" com "Ver diferenças", "Adotar" e "Dispensar"; o front consulta `GET /workflows/{id}/seed-offer` (WF-62), que traz a situação e a comparação com a versão publicada.
6. Em "Ver diferenças" o administrador revisa etapas incluídas, removidas e alteradas, e as regras de saída incluídas; nada é gravado.
7. Ao **adotar**, o front envia `POST /workflows/{id}/seed-offer/adopt` (WF-63, `Idempotency-Key` e `If-Match`); a API cria uma nova versão `DRAFT` copiada da **semente v2** (não da versão atual), limpa `offeredSeedVersion`, emite `WorkflowSeedVersionAdopted` (`automatic = false`) e audita `workflow.seed_adopt`.
8. O administrador ajusta o rascunho no editor (unidade responsável de `DOTACAO`, `MINUTA_EDITAL`, `JURIDICO` e `CONTROLE_INTERNO`; ordem ou paralelismo de Jurídico e Controle Interno; prazos), valida e publica pelo fluxo normal (WF-20/WF-21, US-045). Na publicação o sistema compara o `definitionHash` com o da semente e preenche `seedVersion` somente se continuar idêntica.
9. Se não quiser adotar agora, o administrador **dispensa** a oferta (`POST /workflows/{id}/seed-offer/dismiss`, WF-64): grava `offerDismissedAt` e a faixa vira um aviso discreto "Oferta dispensada — adotar mesmo assim", sem nova notificação.
10. Processos em andamento continuam na versão em que estão; novos processos passam a usar a versão publicada corrente do workflow aplicável (DEC-014).

## Fluxos alternativos
- **FA-01 — Rascunho aberto no momento do *seeder*:** tenant com `seedVersion` mas com versão `DRAFT` aberta é tratado como em customização: só oferta (RN-WF-46 permite um rascunho por workflow).
- **FA-02 — Adoção com rascunho existente:** `WORKFLOW_DRAFT_EXISTS` (409) com `meta.draftVersionId`; a UI oferece "Abrir o rascunho existente"; a oferta fica intacta.
- **FA-03 — Oferta dispensada e adoção posterior:** adotar continua possível enquanto `offeredSeedVersion` estiver preenchido; a faixa mostra o histórico ("dispensada em {data}").
- **FA-04 — Nova versão da semente (v3) no futuro:** `offeredSeedVersion` passa a 3 e `offerDismissedAt` é zerado; uma oferta dispensada da v2 não bloqueia a oferta seguinte.
- **FA-05 — Contratação direta:** a v2 de "Contratação direta" (art. 72) segue o mesmo ciclo (publicação automática, oferta, adoção, dispensa), com `DOTACAO` e `JURIDICO` antes de `AUTORIZACAO` e sem `MINUTA_EDITAL`.
- **FA-06 — Workflow sem semente (criado pelo órgão):** sem `seedKey` não há oferta; `GET /workflows/{id}/seed-offer` responde `NONE`.
- **FA-07 — Validação interna da semente falha:** nenhuma versão é criada nem oferta gravada para o tenant; erro registrado e alerta operacional; as demais transações do *seeder* seguem.
- **FA-08 — Tenant desliga as ofertas:** com `workflow.offerSeedUpdates = false` o *seeder* ignora o tenant (sem publicação nem oferta); ao ligar de novo, a próxima execução do passo resolve.
- **FA-09 — Atualização depois de a oferta existir:** o administrador adota, personaliza e publica; a versão resultante tem `seedVersion` nulo (customizada) e não recebe publicação automática de futuras sementes.

## Regras de negócio
- **RN-WF2-91** — A v2 de "Fase preparatória — Lei 14.133/2021" (`seedKey = PREPARATORY_PHASE`) mantém as etapas 1 a 6 da v1 e inclui, entre `APROVACAO_AUTORIDADE` e `CONCLUSAO`, as etapas da DEC-196: `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO` → `CONCLUSAO` (rótulo "Fase preparatória concluída"). `JURIDICO` nasce com `isLegallyRequired = true` e `JURIDICO` e `CONTROLE_INTERNO` com `pauseSlaWhileReturned = true`. A unidade responsável de `DOTACAO`, `MINUTA_EDITAL`, `JURIDICO` e `CONTROLE_INTERNO` nasce `CHOSEN_ON_FORWARD` até o administrador configurar a unidade fixa na versão do tenant (DEC-196). A ordem entre Jurídico e Controle Interno é configurável por tenant (inverter ou paralelizar — US-123), sem chave de configuração.
- **RN-WF2-92** — A v2 de "Contratação direta" (`seedKey = DIRECT_CONTRACTING`, `key` `DIRECT_CONTRACTING_ART72`) inclui `DOTACAO` e `JURIDICO` antes de `AUTORIZACAO` (art. 72, III e IV), sem `MINUTA_EDITAL`, preservando a `applicabilityRule` do workflow e as regras da v1 (RN-WF-35, RN-WF-38).
- **RN-WF2-93** — Classificação do tenant: o *seeder* liga o workflow à semente pela `Workflow.key` (RN-WF-34), grava `seedKey` (imutável depois) e preenche `WorkflowVersion.seedVersion` da versão publicada **somente** se o `definitionHash` canônico (RFC 8785, DEC-084) for igual ao da semente daquela versão. "Sem customização" = `currentPublishedVersionId` com `seedVersion` preenchido (entities MVP 2 §5.7). A canonicalização do snapshot da US-129 (RN-WF2-89) preserva a comparabilidade com as versões do MVP 1.
- **RN-WF2-94** — Publicação automática só quando: workflow ativo e com versão publicada; `seedVersion` preenchido; **sem** versão `DRAFT` aberta; `workflow.offerSeedUpdates = true`; pré-requisitos da RN-WF2-100 satisfeitos. Cria a versão (`versionNumber = máx + 1`, `seedVersion` da semente, `changeNotes` "Fluxo padrão v2 (DEC-196)"), valida, publica, retira a anterior e atualiza `currentPublishedVersionId` numa transação; emite `WorkflowVersionPublished` e `WorkflowSeedVersionAdopted` (`automatic = true`). O número da versão do tenant e o da semente podem diferir (ex.: versão 3 do tenant = padrão v2).
- **RN-WF2-95** — Fora do caso da RN-WF2-94, o *seeder* só oferece: `offeredSeedVersion = <semente>`, evento `WorkflowSeedVersionOffered` e notificação `WORKFLOW_VERSION_OFFERED` aos vínculos com `WORKFLOW_PUBLISH` (máx. 50); a versão publicada **não** é alterada. A oferta é idempotente: reexecutar o *seeder* com a mesma semente não duplica evento nem notificação. Com `workflow.offerSeedUpdates = false` não há publicação automática nem oferta.
- **RN-WF2-96** — Adotar (WF-63) cria uma única versão `DRAFT` copiada da definição da semente v2 (etapas, transições e regras com ids novos; `seedVersion` ainda nulo), limpa `offeredSeedVersion` e emite `WorkflowSeedVersionAdopted` (`automatic = false`, `workflowVersionId` do rascunho). A versão publicada e os processos não são tocados. Depende de oferta existente (`offeredSeedVersion` preenchido), mesmo se dispensada; sem oferta → `SEED_OFFER_NOT_AVAILABLE` (409). Rascunho existente → `WORKFLOW_DRAFT_EXISTS` (RN-WF-46).
- **RN-WF2-97** — Dispensar (WF-64) grava `offerDismissedAt = agora` sem apagar `offeredSeedVersion` e é idempotente (repetir não muda o carimbo nem audita de novo). Dispensar não impede adotar depois (FA-03).
- **RN-WF2-98** — Nenhuma operação desta story altera processo, etapa de processo, aprovação ou prazo: publicar, ofertar, adotar e dispensar nunca migram nada (RN-WF2-21). Processos novos criados depois da publicação usam a nova versão corrente; os concluídos na v1 só continuam pela US-131.
- **RN-WF2-99** — A comparação (`comparison`, WF-62) é calculada no servidor, por `key` de etapa, entre a versão publicada corrente e a semente oferecida: etapas incluídas, removidas e alteradas (tipo, aprovador, política de decisão, prazo, unidade, flags `isLegallyRequired`/`pauseSlaWhileReturned`) e regras de saída incluídas, removidas e alteradas. É leitura pura, sem valores de processo e sem dado sigiloso.
- **RN-WF2-100** — Portão de prontidão: o passo "workflows padrão v2" só roda para o tenant quando estão registradas as definições de regra de saída de US-148 (`DOTACAO`), US-155 (`JURIDICO`), US-161 (`CONTROLE_INTERNO`) e US-168 (`MINUTA_EDITAL`) e os provedores do `RuleContext` v2 de US-129; falta de qualquer uma desliga o passo (log `warn`, sem oferta). A definição semeada tem de passar na validação WF-20 sem erros em teste de CI. As regras semeadas são exatamente as definidas nessas stories; esta story não define nem altera esse conteúdo.

### Definição semeada da v2 da fase preparatória
| # | Chave | Nome | Tipo | Observação |
|---|---|---|---|---|
| 1 a 6 | `ABERTURA`, `APROVACAO_DFD`, `ESTUDOS_PRELIMINARES`, `PESQUISA_PRECOS`, `TERMO_REFERENCIA`, `APROVACAO_AUTORIDADE` | como na v1 | `START`/`TASK`/`APPROVAL` | sem alteração de regras (RN-WF-37) |
| 7 | `DOTACAO` | Dotação orçamentária | `TASK` | regra de saída: US-148 |
| 8 | `MINUTA_EDITAL` | Minuta do edital | `TASK` | regras de saída: US-168 |
| 9 | `JURIDICO` | Análise jurídica | `TASK` | `isLegallyRequired`, `pauseSlaWhileReturned`; regra de saída: US-155; devolve para etapas já percorridas (DEC-196) |
| 10 | `CONTROLE_INTERNO` | Controle interno | `TASK` | `pauseSlaWhileReturned`; regra de saída: US-161; pode devolver da mesma forma |
| 11 | `AUTORIZACAO_LICITACAO` | Aprovação do edital e autorização da licitação | `APPROVAL` | aprovador: perfil `AUTORIDADE_COMPETENTE` com cobertura da secretaria solicitante (DEC-022); cobre `EDITAL`, `MINUTA_CONTRATO`, `PARECER_JURIDICO`, `MANIFESTACAO_CONTROLE_INTERNO` |
| 12 | `CONCLUSAO` | Fase preparatória concluída | `END` | `COMPLETED` na v2 = fase preparatória concluída (DEC-196) |

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação da oferta | `status` (resposta de WF-62) | `NONE` \| `OFFERED` \| `DISMISSED` \| `AUTO_PUBLISHED` | — | derivado | calculado |
| Versão da semente oferecida | `offeredSeedVersion` | inteiro | — | só leitura | *seeder* |
| Oferta dispensada em | `offerDismissedAt` | data/hora | — | RN-WF2-97 | ação de dispensar |
| Chave da semente | `Workflow.seedKey` | texto | — | `PREPARATORY_PHASE` \| `DIRECT_CONTRACTING`; imutável | *seeder* |
| Versão da semente da versão | `WorkflowVersion.seedVersion` | inteiro | — | preenchido por comparação de hash | *seeder*/publicação |
| Personalizado? | `customized` (resposta) | booleano | — | `true` quando a versão corrente não tem `seedVersion` | derivado |
| Comparação | `comparison.stages[]`, `comparison.rules[]` | listas | — | RN-WF2-99 | servidor |
| Chave de idempotência | `Idempotency-Key` | UUID (cabeçalho) | Sim (WF-63, WF-64) | DEC-105 | gerada pelo front |
| Versão do workflow | `If-Match` | ETag | Sim (WF-63, WF-64) | `Workflow.version` (DEC-104) | lida em WF-62 |
| Receber ofertas do padrão | `workflow.offerSeedUpdates` | booleano | Não | via SET-02 (`SETTINGS_MANAGE`) | `true` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Adotar ou dispensar sem oferta (`offeredSeedVersion` nulo) | API | "Não há nova versão do fluxo padrão para este fluxo." | `SEED_OFFER_NOT_AVAILABLE` |
| V-02 | Adotar com rascunho aberto | API | "Já existe um rascunho deste fluxo. Continue o rascunho ou descarte-o antes de adotar." | `WORKFLOW_DRAFT_EXISTS` |
| V-03 | `Idempotency-Key` ausente ou reutilizada com corpo diferente | API | "Não foi possível repetir esta ação com os mesmos dados." | `VALIDATION_ERROR` / `IDEMPOTENCY_KEY_REUSED` |
| V-04 | `If-Match` ausente ou divergente | API | "Outra pessoa alterou este fluxo. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-05 | Workflow inexistente ou de outro tenant | API | "Fluxo não encontrado." | `NOT_FOUND` |
| V-06 | Semente não validada em CI/execução (WF-20 com erros) | *Seeder* | (log técnico; sem oferta) | `SEED_DEFINITION_INVALID` |
| V-07 | Corpo de adoção/dispensa com campo desconhecido | API (Zod) | "Revise os campos enviados." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `WORKFLOW_VIEW` (WF-62); `WORKFLOW_MANAGE` + `WORKFLOW_PUBLISH` (WF-63 — cria rascunho e consome a oferta); `WORKFLOW_PUBLISH` (WF-64). O *seeder* e a publicação automática atuam como `SYSTEM`. A publicação da versão adotada segue a US-045 (`WORKFLOW_PUBLISH`).
- **Políticas:** nenhuma política contextual de processo; visibilidade de administração (`ADMIN_ORGAO`); POL-14 (MFA).
- **MFA:** `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH` são risco `H`: exigido conforme `security.mfaPolicy` (`ADMINS` ou `ALL`); sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** faixa de oferta visível só a quem tem `WORKFLOW_VIEW`, com "Adotar" e "Dispensar" ocultos sem `WORKFLOW_PUBLISH`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode = WORKFLOW_PUBLISH`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowSeedVersionOffered` | `workflow.seed_version_offered` | *Seeder* grava a oferta (RN-WF2-95) | `workflowId`, `seedKey`, `offeredSeedVersion`; consumidor `N` (notificação `WORKFLOW_VERSION_OFFERED`) |
| `WorkflowSeedVersionAdopted` | `workflow.seed_version_adopted` | Publicação automática (`automatic = true`) ou adoção pelo administrador (`automatic = false`) | `workflowId`, `workflowVersionId`, `seedVersion`, `automatic`; consumidor `C` (catálogo/cache de resolução de aplicabilidade) |
| `WorkflowVersionPublished` | `workflow.version_published` | Somente na publicação automática | `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash` (evento do MVP 1, US-045) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `WORKFLOW_VERSION_OFFERED` | Vínculos ativos com `WORKFLOW_PUBLISH` do tenant (máx. 50) | in-app + e-mail (padrão ligado); não obrigatória | `WorkflowSeedVersionOffered`; uma vez por semente oferecida |
| — | — | — | Publicação automática e adoção/dispensa não têm tipo de notificação no registro (ver lacuna 4); a mudança aparece na SCR-034 e na trilha de auditoria. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Workflow padrão v2 da fase preparatória e oferta de adoção

  Background:
    Given que as regras de saída de dotação, edital, jurídico e controle interno e o RuleContext v2 estão registrados
    And o tenant "Prefeitura A" tem o workflow "Fase preparatória — Lei 14.133/2021" ativo
    And "Carla" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH) e MFA na sessão

  Scenario: [Sucesso] Tenant sem customização recebe a v2 publicada e os processos em andamento ficam na v1
    Given que a versão publicada 1 do workflow tem o mesmo "definitionHash" da semente v1
    And o processo "0012/2026" está em "ESTUDOS_PRELIMINARES" na versão 1
    When o seeder da v2 rodar para o tenant "Prefeitura A"
    Then deve existir a versão 2 "PUBLISHED" com "seedVersion" igual a 2 e as etapas "DOTACAO", "MINUTA_EDITAL", "JURIDICO", "CONTROLE_INTERNO" e "AUTORIZACAO_LICITACAO"
    And a versão 1 deve ficar "RETIRED"
    And o processo "0012/2026" deve continuar na versão 1
    And deve gerar registro de auditoria "workflow.seed_adopt" com ator "SYSTEM"
    And deve gerar os eventos "WorkflowVersionPublished" e "WorkflowSeedVersionAdopted" com "automatic" verdadeiro

  Scenario: [Sucesso] Tenant com customização recebe só a oferta e depois adota
    Given que a versão publicada tem a etapa extra "ASSESSORIA_GABINETE" e "seedVersion" nulo
    When o seeder da v2 rodar
    Then a versão publicada deve permanecer inalterada
    And "offeredSeedVersion" deve ser 2
    And deve gerar o evento "WorkflowSeedVersionOffered" e a notificação "WORKFLOW_VERSION_OFFERED" para "Carla"
    When "Carla" consultar a oferta
    Then a resposta deve ter "status" "OFFERED", "customized" verdadeiro e a comparação com 5 etapas incluídas
    When "Carla" adotar a oferta com "Idempotency-Key" "k-001" e "If-Match" da versão do workflow
    Then a API deve responder 201 com uma versão "DRAFT" copiada da semente v2
    And "offeredSeedVersion" deve ficar nulo
    And deve gerar registro de auditoria "workflow.seed_adopt" e o evento "WorkflowSeedVersionAdopted" com "automatic" falso

  Scenario: [Sucesso] Dispensar a oferta mantém a possibilidade de adotar
    Given que existe a oferta da v2 para o workflow
    When "Carla" dispensar a oferta
    Then "offerDismissedAt" deve ser preenchido e "offeredSeedVersion" deve continuar 2
    And deve gerar registro de auditoria "workflow.seed_offer_dismiss"
    When "Carla" adotar a oferta depois
    Then a API deve responder 201

  Scenario: [Sucesso] Contratação direta recebe a v2 sem edital
    Given que o workflow "Contratação direta" tem a versão 1 sem customização
    When o seeder da v2 rodar
    Then a v2 deve ter "DOTACAO" e "JURIDICO" antes de "AUTORIZACAO" e não deve ter "MINUTA_EDITAL"

  Scenario: [Validação] Adotar sem oferta e rascunho já existente
    Given que o workflow não tem oferta
    When "Carla" tentar adotar
    Then a API deve responder 409 com código "SEED_OFFER_NOT_AVAILABLE"
    Given que existe oferta e um rascunho aberto da versão 2
    When "Carla" tentar adotar
    Then a API deve responder 409 com código "WORKFLOW_DRAFT_EXISTS" e "meta.draftVersionId" do rascunho
    And a oferta deve continuar disponível

  Scenario: [Permissão] Usuário somente leitura tenta adotar ou dispensar
    Given que "Bruno" possui apenas "WORKFLOW_VIEW"
    When "Bruno" enviar POST de adoção ou de dispensa
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" consultar a oferta
    Then a API deve responder 200

  Scenario: [Tenant incorreto] Adotar a oferta de workflow de outro tenant
    Given que existe oferta para um workflow do tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura A", enviar POST de adoção para esse workflow
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reexecução do seeder e reenvio da adoção
    Given que o seeder da v2 já rodou para "Prefeitura A"
    When o seeder rodar de novo
    Then não deve existir nova versão, novo evento nem nova notificação
    Given que "Carla" adotou com "Idempotency-Key" "k-001"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder 201 com o cabeçalho "Idempotent-Replayed" verdadeiro e uma única versão "DRAFT"
    When a mesma chave for reenviada com corpo diferente
    Then a API deve responder 422 com código "IDEMPOTENCY_KEY_REUSED"

  Scenario: [Concorrência] Dois administradores adotam ao mesmo tempo
    Given que "Carla" e "Diego" consultaram a oferta com a mesma ETag
    When os dois enviarem a adoção ao mesmo tempo
    Then apenas um rascunho deve ser criado
    And o segundo receberá 409 "WORKFLOW_DRAFT_EXISTS" ou 412 "VERSION_CONFLICT"

  Scenario: [Falha de banco] Falha na transação de um tenant durante o seeder
    Given que o banco falha ao publicar a v2 do tenant "Prefeitura A"
    When o seeder rodar para todos os tenants
    Then a transação de "Prefeitura A" deve ser desfeita sem versão parcial, evento ou auditoria
    And os demais tenants devem ser processados
    And a próxima execução deve retomar "Prefeitura A"

  Scenario: [Falha de integração] Relay do outbox ou fila de notificação indisponível
    Given que o relay do outbox está indisponível
    When o seeder gravar a oferta
    Then a oferta e o evento "WorkflowSeedVersionOffered" devem ficar persistidos como "PENDING" no outbox
    And a notificação deve ser entregue quando o relay voltar, uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem oferta para adotar/dispensar | 409 | `SEED_OFFER_NOT_AVAILABLE` | "Não há nova versão do fluxo padrão para este fluxo." | Recarrega e esconde a faixa |
| Rascunho já existe | 409 | `WORKFLOW_DRAFT_EXISTS` | "Já existe um rascunho deste fluxo. Continue o rascunho ou descarte-o antes de adotar." | Link "Abrir o rascunho existente" (`meta.draftVersionId`) |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Outra pessoa alterou este fluxo. Recarregue para continuar." | Recarrega a oferta |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Mantém o estado e oferece recarregar |
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos enviados." | — |
| Workflow inexistente/outro tenant | 404 | `NOT_FOUND` | "Fluxo não encontrado." | Volta à lista de workflows |
| Sem permissão / sem MFA | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | "Você não tem permissão para adotar versões do fluxo." / "Confirme sua identidade (MFA) para continuar." | Oculta ações; abre o desafio de MFA |
| Semente inválida (execução do *seeder*) | — | `SEED_DEFINITION_INVALID` | (log técnico e alerta operacional) | Nenhuma oferta criada |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-042 (workflows semeados, `key`s, RN-WF-34 a RN-WF-42), US-045 (validação, publicação e versionamento), US-129 (`RuleContext` v2 e canonicalização do hash), **US-148, US-155, US-161 e US-168** (regras de saída de dotação, jurídico, controle interno e edital — únicas dependências "de volta"; ver RN-WF2-100). Habilita US-131 (continuação dos concluídos na v1), US-123 (ordem e paralelismo de Jurídico e Controle Interno no rascunho adotado) e as stories de migração (FT-064) para quem quiser levar processos.
- **Decisões/ADRs:** DEC-014, DEC-015, DEC-084, DEC-195, DEC-196, DEC-204; ADR-005, ADR-015, ADR-016.
- **Configurações:** `workflow.offerSeedUpdates` (boolean, padrão `true`).
- **Lacunas nas fontes canônicas:**
  1. A DEC-196 não define `slaDays`, política de atribuição nem as transições `RETURN` das etapas novas além de `JURIDICO`/`CONTROLE_INTERNO`. Proposta para o *seeder*: `slaDays` nulo nas cinco etapas (aviso `WF_STAGE_NO_SLA` até o administrador adotar o modelo `PADRAO_FASE_PREPARATORIA` de SLA — entities MVP 2 §9) e `AUTORIZACAO_LICITACAO` devolvendo para `DOTACAO`, `MINUTA_EDITAL`, `JURIDICO` e `CONTROLE_INTERNO`. A confirmar com a equipe de produto.
  2. `Workflow.seedKey` (entities §5.7) usa `PREPARATORY_PHASE`/`DIRECT_CONTRACTING`, enquanto a US-042 criou as `key` `DEFAULT_PREPARATORY`/`DIRECT_CONTRACTING_ART72`; assumido que o *seeder* faz a correspondência (RN-WF2-93). Falta registrar a tabela de correspondência em entities.md.
  3. O comportamento de `workflow.offerSeedUpdates = false` frente à publicação automática não está explícito (a DEC-196 só trata a oferta); assumido que desliga ambos (RN-WF2-95). Dúvida de produto.
  4. Não há tipo de notificação para "v2 publicada automaticamente" (events.md §6 só tem `WORKFLOW_VERSION_OFFERED`); proposta de `WORKFLOW_VERSION_PUBLISHED_AUTO` ou aviso na SCR-034. Dúvida de produto (surpresa para o administrador).
  5. O evento `WorkflowSeedVersionAdopted` na adoção refere o rascunho (ainda não publicado); `seedVersion` só é efetivado na publicação. Registrar a semântica em events.md.
  6. Contratação direta: a DEC-196 descreve só que `DOTACAO` e `JURIDICO` vêm antes de `AUTORIZACAO`; a ordem entre as duas foi assumida pela ordem do texto.

## Impacto técnico
- **Compatibilidade e riscos:** a publicação automática muda o fluxo dos **novos** processos do tenant (mais etapas e regras `BLOCKING` de dotação, jurídico etc.), embora não toque nos em andamento. Por isso só ocorre onde o padrão está intacto e com `offerSeedUpdates = true`; a faixa na SCR-034 e a trilha de auditoria explicam o que mudou.
- **Idempotência:** o passo do `TenantSeeder` é versionado (`TenantSeeder.version`) e idempotente por `(workflowId, seedVersion)`: nova execução com estado já resolvido é um *no-op*. Uma transação por tenant e workflow; falha de um tenant não interrompe os demais.
- **Hash:** a comparação depende da canonicalização (RN-WF2-89 da US-129) e de ordenar etapas e transições por `key`; qualquer campo de definição acrescentado pelo MVP 2 com valor padrão deve ser omitido do snapshot da v1 para manter o hash.
- **Imutabilidade:** versões publicadas pelo *seeder* são irreversíveis (M2-21 não reversível); desfazer = aposentar e publicar outra versão. A publicação automática usa a mesma rotina `WorkflowVersionPublisher` (RN-WF-20), que roda a validação completa.
- **Aplicabilidade:** `Workflow.currentPublishedVersionId` muda; o cache de resolução de aplicabilidade (WF-06) é invalidado pelo evento (consumidor `C`).
- **Performance:** a comparação do WF-62 é uma diferença entre dois grafos de até 50 etapas e 200 regras; sem índice novo.

## Backend
- **Módulo(s):** `workflow` (dono), `process` (somente consulta de contagens, se houver), `notification`, `access`, `audit`, `platform` (*seeder*, outbox, idempotência).
- **Casos de uso:** `SeedDefaultWorkflowsV2Step` (passo do `TenantSeeder`), `PublishSeedVersionCommand` (automático), `GetSeedOfferQuery` (WF-62), `AdoptSeedOfferCommand` (WF-63), `DismissSeedOfferCommand` (WF-64).
- **Domínio:** `SeedDefinition` (definição canônica versionada em código: `PREPARATORY_PHASE` v2, `DIRECT_CONTRACTING` v2), `SeedHashComparator`, `SeedOffer` (estado derivado), `WorkflowDiff` (comparação por `key`), `SeedRuleSource` (registro das definições de regra de saída publicadas por US-148/US-155/US-161/US-168).
- **Integrações internas:** `WorkflowVersionPublisher` (validação e publicação, US-045), `RuleContextBuilder` (US-129, para validar as regras semeadas), `NotificationFacade` (via evento), `SettingsFacade` (`workflow.offerSeedUpdates`).
- **Transação:** uma por tenant e workflow no *seeder* (versão + publicação + retirada da anterior + `currentPublishedVersionId` + `seedKey`/`seedVersion` + auditoria + outbox); WF-63 e WF-64 em transação curta com trava no `Workflow`.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`), ampliada: faixa de oferta, painel de comparação, selos "Padrão v2" e "Publicada automaticamente em {data}".
- **Componentes:** `SeedOfferBanner` ("Ver diferenças", "Adotar", "Dispensar"), `SeedComparisonDrawer` (etapas e regras incluídas, removidas e alteradas), `AdoptSeedDialog` (explica que cria um rascunho e que nenhum processo muda), `DismissSeedDialog`, `SeedVersionBadge`.
- **Estados:** loading (skeleton da faixa); sem oferta (faixa oculta); oferta ativa; oferta dispensada (aviso discreto); rascunho existente (link); erro com "Tentar novamente"; sucesso (toast "Rascunho da versão {N} criado a partir do fluxo padrão v2").
- **Acessibilidade e responsividade:** faixa com texto e ícone (não só cor); diálogos com foco preso e resultado anunciado por `aria-live`; comparação em lista única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflows` (`seed_key`, `offered_seed_version`, `offer_dismissed_at`), `workflow_versions` (`seed_version`, `definition_hash`, `rule_refs`), `workflow_stages`, `workflow_transitions`, `workflow_rules`, `outbox_events`, `audit_logs`, `notifications`.
- **Migrações:** nenhuma nova (M2-04 cria as colunas; M2-21 executa o *seeder* incremental, **não reversível** para workflows publicados).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, workflow_id) WHERE status = 'DRAFT'` (RN-WF-46); `seed_key` imutável (trigger); `UNIQUE (tenant_id, workflow_id, version_number)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-62` | GET | `/workflows/{id}/seed-offer` | — | `200 { data: { workflowId, seedKey, status, offeredSeedVersion, offerDismissedAt, customized, currentVersion { id, versionNumber, seedVersion }, seed { seedVersion, stagesCount }, comparison { stages[], rules[] } } }` · `ETag` do workflow | 200, 403, 404 |
| `WF-63` | POST | `/workflows/{id}/seed-offer/adopt` | `Idempotency-Key`, `If-Match`; corpo vazio | `201 { data: WorkflowVersion (DRAFT) }` · `Location` · `ETag` | 201, 403, 404, 409, 412, 422, 428, 503 |
| `WF-64` | POST | `/workflows/{id}/seed-offer/dismiss` | `Idempotency-Key`, `If-Match`; corpo vazio | `200 { data: { offeredSeedVersion, offerDismissedAt } }` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `workflow.seed_published` — `tenantId`, `workflowId`, `seedKey`, `seedVersion`, `versionNumber`, `durationMs`.
- `info` `workflow.seed_offered` / `workflow.seed_adopted` / `workflow.seed_dismissed` — `workflowId`, `seedVersion`, `automatic?`.
- `warn` `workflow.seed_skipped` — causa (`OFFER_DISABLED`, `GATE_NOT_READY`, `NO_PUBLISHED_VERSION`, `DRAFT_OPEN`).
- `error` `workflow.seed_definition_invalid` — `seedKey`, códigos de `errors[]`, `correlationId`.
- **Nunca logar:** conteúdo de regras com valores de processo, nomes de pessoas das unidades, dados de processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.seed_adopt` | `CONFIGURATION` | Adoção pelo administrador ou publicação automática (`actorType = SYSTEM`) | `metadata`: `workflowId`, `seedKey`, `seedVersion`, `workflowVersionId`, `automatic`, `previousVersionId?` |
| `workflow.seed_offer_dismiss` | `CONFIGURATION` | Dispensa (primeira vez) | `metadata`: `workflowId`, `offeredSeedVersion` |
| `workflow.version_publish` | `CONFIGURATION` | Só na publicação automática | `metadata`: `versionNumber`, `definitionHash`, `changeNotes` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_PUBLISH` |

## Testes necessários
- **Unitários:** `SeedHashComparator` (igual, diferente, ordem de etapas); `WorkflowDiff`; classificação do tenant (`seedVersion`, rascunho aberto, `offerSeedUpdates`); portão de prontidão; geração da definição das duas sementes (12 etapas na preparatória; sem `MINUTA_EDITAL` na direta).
- **Integração (Testcontainers PostgreSQL + Redis):** *seeder* idempotente em tenants "intacto", "customizado", "com rascunho" e "sem workflow ativo"; publicação automática atômica; WF-62/WF-63/WF-64; semente passa em WF-20 sem erros (teste de CI); `definitionHash` de versões do MVP 1 inalterado.
- **API/contrato:** WF-62 a WF-64 conforme a tabela; `Idempotency-Key`/`If-Match`; nenhuma mudança no contrato de WF-05, WF-08, WF-21.
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` × `WORKFLOW_PUBLISH`; MFA; workflow de outro tenant → 404 (suíte `test/tenant-leak`).
- **Concorrência:** duas adoções simultâneas; *seeder* concorrente com edição do rascunho.
- **E2E (Playwright):** oferta → comparação → adotar → editar → publicar; tenant intacto recebe a v2 publicada e abre um processo novo com as etapas novas.
- **Acessibilidade/performance:** axe na faixa e no painel de comparação; verificação de que nenhum processo em andamento é lido ou alterado pelo passo.

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
- [ ] Semente v2 das duas definições valida sem erros em CI
- [ ] Teste comprova que nenhum processo em andamento muda de versão, etapa ou prazo
- [ ] Lacunas 1 a 6 resolvidas ou aceitas pela coordenação antes da implementação

## Estimativa
**M** — o *seeder* incremental com classificação por hash, publicação automática atômica, oferta, adoção e dispensa são conhecidos; o esforço está na definição canônica das duas sementes, na comparação e na garantia de que nada em andamento é afetado.

## Prioridade
**P0** — fecha a fase preparatória no fluxo padrão e é pré-requisito da continuação dos concluídos (US-131); depende das regras de saída de quatro épicos e só é semeada quando elas estiverem prontas.
