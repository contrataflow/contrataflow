---
id: US-187
title: "Atualizar a biblioteca padrão de templates com adoção assistida (DT-15)"
epic: EP-029
feature: FT-085
mvp: 2
priority: P2
estimate: M
status: Especificada
depends_on: [US-108, US-110]
modules: [document, notification, access, platform, audit]
screens: [SCR-033, SCR-114]
endpoints: [TPL-14, TPL-15, TPL-16, TPL-17]
permissions: [TEMPLATE_VIEW, TEMPLATE_MANAGE, TEMPLATE_PUBLISH]
events: [TemplateLibraryUpdateAvailable, TemplateLibraryUpdateAdopted]
---

# US-187 — Atualizar a biblioteca padrão de templates com adoção assistida (DT-15)

## Título
Atualizar a biblioteca padrão de templates com adoção assistida

## Descrição
**Como** administrador de configurações documentais do órgão (`ADMIN_ORGAO`, com `TEMPLATE_VIEW`, `TEMPLATE_MANAGE` e `TEMPLATE_PUBLISH`), **quero** ser avisado quando a biblioteca padrão de templates da plataforma evolui, ver a diferença entre o meu modelo publicado e o modelo novo, seção a seção, e adotar a atualização escolhendo o que manter do meu texto, **para** aproveitar as melhorias de redação e de base legal sem sobrescrever o que o órgão personalizou e sem refazer o modelo à mão.

A biblioteca padrão (US-110) é definida em código e versionada com o release da plataforma. No MVP 1 a adoção de uma atualização era manual e sem comparação (RN-TPL-35). Esta story entrega: (1) a **detecção** por `libraryContentHash` após cada deploy, com o evento `TemplateLibraryUpdateAvailable` e a notificação `TEMPLATE_LIBRARY_UPDATE`; (2) a **diferença** seção a seção entre a versão publicada do tenant e a da biblioteca; (3) a **adoção assistida**, que cria uma **nova versão em rascunho** com o que a pessoa escolheu, sem tocar na versão publicada e sem publicar; (4) a **dispensa** explícita da oferta.

## Contexto
- DT-15 (DEC-209): "atualização da biblioteca padrão de templates com diferença por `contentHash` e adoção assistida". A US-110 declarou a lacuna (sem detecção automática, sem endpoint dedicado, adoção por `TPL-06` + edição manual) e a feature-058 reservou, sem detalhar, `TPL-14` (verificar atualização) e `TPL-15`.
- RN-PLAT-17 (FT-085): há atualização quando `libraryContentHash` da biblioteca nova difere do da versão publicada do tenant; a adoção cria **nova versão** (nunca altera a publicada) e mostra a diferença antes de confirmar. RN-PLAT-18: template sem origem na biblioteca (`libraryKey` nulo) não recebe oferta.
- entities.md §5.10 (MVP 2): `DocumentTemplate.libraryKey` (varchar(60)); `DocumentTemplateVersion.libraryVersion` (varchar(20)) e `libraryContentHash` (varchar(64)). O `contentHash` de uma versão é o SHA-256 do JSON canônico (RFC 8785) de `{ sections, layout, fieldConfig, importMappings }` (RN-TPL-15); o `libraryContentHash` é o mesmo cálculo aplicado à **definição da biblioteca** de que a versão nasceu.
- Analogia com a US-130 (workflow padrão v2): a oferta é derivada, a adoção cria um `DRAFT`, a dispensa não impede adotar depois e a oferta nunca é imposta. Diferente do workflow, **não há publicação automática** de template (DEC-196 não se estende a templates) e a atualização de templates é independente de `workflow.offerSeedUpdates`.
- Regras herdadas da US-107/US-108/US-110: um só rascunho por template (`TEMPLATE_DRAFT_EXISTS`, RN-TPL-13/RN-TPL-36), validação integral ao publicar (RN-TPL-14), sem efeito retroativo sobre documentos já criados (RN-TPL-16), `TEMPLATE_PUBLISH` é risco `H` (POL-14).
- Evento e notificação já registrados: `TemplateLibraryUpdateAvailable` (`template.library_update_available`, produtor "seeder da biblioteca"), `TemplateLibraryUpdateAdopted` (`template.library_update_adopted`), `TEMPLATE_LIBRARY_UPDATE` (vínculos com `TEMPLATE_PUBLISH`, máx. 50, sem e-mail por padrão, não obrigatória) e a ação de auditoria `template.library_adopt`.

## Objetivo
Levar 100% das atualizações da biblioteca aos tenants que têm o template correspondente, com diferença correta seção a seção e adoção que nunca altera a versão publicada; meta de negócio: ≥ 70% das atualizações adotadas ou dispensadas explicitamente em 30 dias (KPI da FT-085).

## Persona
- **Principal:** Administrador de configurações documentais do órgão (`ADMIN_ORGAO`; também quem tiver `TEMPLATE_MANAGE` e `TEMPLATE_PUBLISH`).
- **Secundárias:** Procuradoria/assessoria jurídica do tenant (revisa o rascunho antes de publicar); qualquer detentor de `TEMPLATE_VIEW` (vê o selo e a diferença, sem adotar); operador de plataforma (publica a biblioteca nova no release).

## Pré-condições
- Tenant `ACTIVE`; template `isActive = true` com `libraryKey` e versão `PUBLISHED` (RN-PLAT-18).
- Biblioteca vigente do release com `libraryVersion` e `libraryContentHash` por `libraryKey` (fixture versionado, validado no build — RN-TPL-34).
- Para adotar: `TEMPLATE_MANAGE` e `TEMPLATE_PUBLISH`; para dispensar: `TEMPLATE_PUBLISH`; para ver: `TEMPLATE_VIEW`. Com `security.mfaPolicy` `ADMINS` ou `ALL`, sessão com MFA (POL-14) nas ações de risco `H`.

## Fluxo principal
1. A plataforma publica um release com biblioteca nova (`libraryVersion` 1.1.0). Depois do deploy, o `tenant:seed` executa o seeder `document.templateLibrary` (versão 2 do contrato, `applyToExistingTenants = true`) em cada tenant.
2. O seeder compara, por `libraryKey`, o `libraryContentHash` da versão publicada do template do tenant com o hash da biblioteca vigente. Para cada template com hash diferente (e não dispensado para esse hash, RN-PLAT-282), monta a lista `templatesChanged`.
3. Havendo ao menos um, o seeder publica **um** `TemplateLibraryUpdateAvailable` por tenant e por `libraryVersion` (`eventId` determinístico) e o motor de notificações cria `TEMPLATE_LIBRARY_UPDATE` para os vínculos ativos com `TEMPLATE_PUBLISH` (máx. 50), com o texto "A biblioteca padrão de modelos foi atualizada: {tipos}. Veja as diferenças."
4. Em **Administração › Templates** (SCR-033, `/admin/templates`), o administrador vê a faixa "{n} modelos têm atualização disponível" e, na lista, o selo "Atualização disponível" nos templates afetados (dados de TPL-16).
5. Ele abre o template (SCR-033, `/admin/templates/{id}`) e aciona **"Ver diferenças"**; o front chama TPL-14 e mostra, em `/admin/templates/{id}/atualizacao`, a lista de mudanças por seção (Igual, Alterada, Nova na biblioteca, Só no seu modelo) e os blocos "Layout", "Campos" e "Importação"; ao selecionar uma seção, abre a comparação lado a lado (texto, orientação ao redator, base legal, obrigatoriedade).
6. Para cada diferença, a pessoa escolhe **"Manter o meu"** ou **"Usar o da biblioteca"** (padrões da RN-PLAT-289) e confirma em **"Criar rascunho com a atualização"**, com o aviso "Nada será publicado. Um rascunho será criado para você revisar e publicar."
7. O front envia TPL-15 (`Idempotency-Key`, `If-Match` e as escolhas). A API monta o conteúdo, valida com o `TemplateContentValidator`, cria a versão `DRAFT` (`versionNumber = máx + 1`, `libraryVersion` e `libraryContentHash` da biblioteca vigente), audita `template.library_adopt`, publica `TemplateLibraryUpdateAdopted` e responde **201** com a versão.
8. O front leva a pessoa ao editor (SCR-114, US-107), onde ela revisa, usa a prévia (US-109) e publica pelo fluxo normal (`TPL-10`, `TEMPLATE_PUBLISH`, US-108). Ao publicar, a versão passa a ser a corrente e a oferta desaparece.
9. Se não quiser adotar, **"Dispensar esta atualização"** (TPL-17) grava a dispensa para aquele hash; a faixa vira "Atualização dispensada em {data}. Adotar mesmo assim" e a oferta só volta quando uma biblioteca com hash diferente for publicada.

## Fluxos alternativos
- **FA-01 — Modelo sem personalização:** se `contentHash = libraryContentHash` da versão publicada, a diferença mostra tudo como "Alterada" ou "Nova" em relação à biblioteca, o aviso "Seu modelo está igual ao padrão anterior" e todos os padrões são "Usar o da biblioteca".
- **FA-02 — Modelo personalizado:** com `contentHash ≠ libraryContentHash`, aparece o aviso "Você personalizou este modelo. Revise cada diferença"; os padrões preservam o que é do órgão (RN-PLAT-289).
- **FA-03 — Rascunho já existente:** `409 TEMPLATE_DRAFT_EXISTS` com `meta.draftVersionId`; a UI oferece "Abrir o rascunho existente" e a oferta fica intacta (se o rascunho já nasceu de uma adoção, a situação é `IN_PROGRESS`).
- **FA-04 — Biblioteca mudou entre ver e adotar:** o corpo traz a `libraryVersion` que a pessoa viu; se a vigente for outra, `409 LIBRARY_UPDATE_STALE` e a UI recarrega a diferença.
- **FA-05 — Template sem `libraryKey`:** criado pelo órgão (US-107) ou sem origem: TPL-14 responde `status = NONE` e não há selo nem oferta (RN-PLAT-18); adotar → `409 LIBRARY_UPDATE_NOT_AVAILABLE`.
- **FA-06 — Dispensa e nova biblioteca:** dispensar não bloqueia adotar depois; uma biblioteca nova com outro hash volta a `AVAILABLE` e zera o efeito da dispensa anterior.
- **FA-07 — Seção nova da biblioteca que viola o tipo:** a validação falha (`422 TEMPLATE_INVALID` com `violations[]`); nenhum rascunho é criado e a UI aponta a seção.
- **FA-08 — Rascunho adotado abandonado:** continua sendo um `DRAFT` comum (US-110 FA-05); a situação do template fica `IN_PROGRESS` até o rascunho ser publicado, e a pessoa pode editá-lo ou publicá-lo; descartar rascunho está fora do escopo (lacuna 8).
- **FA-09 — Template inativo ou sem versão publicada:** não há oferta (`NONE`).
- **FA-10 — Rótulo de versão diferente, conteúdo igual:** `libraryVersion` mudou, mas o hash do template é o mesmo: sem oferta (o hash decide, RN-PLAT-294).
- **FA-11 — Tenant criado depois do release:** o seeder de provisionamento (US-110) grava `libraryKey`, `libraryVersion` e `libraryContentHash` já na versão 1 e não há oferta.

## Regras de negócio
- **RN-PLAT-280** — Origem: só templates `isActive` com `libraryKey` preenchido participam. O `libraryKey` é o código do tipo de documento da biblioteca (`DFD`, `ETP`, `TR`, `RISK_MAP`, `PRICE_RESEARCH`, `DESPACHO`, `OFICIO`, `NOTA_TECNICA`, `AUTORIZACAO`, `DECLARACAO`); no máximo um template por `(tenant, libraryKey)`. Template do órgão sem origem não recebe oferta (RN-PLAT-18). `libraryKey` que deixou de existir na biblioteca vigente → sem oferta.
- **RN-PLAT-281** — Oferta (RN-PLAT-17): existe quando o template tem versão `PUBLISHED` (`currentPublishedVersionId`) e o `libraryContentHash` dessa versão difere do `contentHash` da definição vigente da biblioteca para o `libraryKey`, calculado como na RN-TPL-15, e a oferta não foi dispensada para esse hash. O rótulo `libraryVersion` é informativo; quem decide é o hash.
- **RN-PLAT-282** — Situação derivada (`status` em TPL-14 e TPL-16): `NONE` (sem origem, inativo, sem versão publicada ou em dia); `AVAILABLE` (oferta existe); `DISMISSED` (hash vigente igual a `libraryUpdateDismissedHash`); `IN_PROGRESS` (há versão `DRAFT` com `libraryContentHash` igual ao hash vigente). A situação nunca depende de a notificação ter sido entregue.
- **RN-PLAT-283** — Detecção após o deploy: o seeder `document.templateLibrary` (versão 2, `applyToExistingTenants = true`) roda no `tenant:seed` e, por tenant, aplica a RN-PLAT-281 a todos os templates com origem. Publica `TemplateLibraryUpdateAvailable` (`libraryVersion`, `templatesChanged[]` de `{ libraryKey, documentTypeCode }`) só se houver ao menos um template em `AVAILABLE`; o `eventId` é determinístico (UUID v5 sobre `tenantId:libraryVersion`), então reexecutar o seeder não duplica evento nem notificação. Falha em um tenant não interrompe os demais (cada tenant em sua `TenantTransaction`).
- **RN-PLAT-284** — Preenchimento da origem em tenants existentes: o mesmo seeder preenche `libraryKey` nos templates `isSystem = true` (pelo código do tipo) e, em **todas** as versões deles, `libraryVersion = "1.0.0"` e `libraryContentHash` = `contentHash` da versão 1 semeada (conteúdo imutável desde a publicação). Templates `isSystem = false` ficam sem origem. O seeder de provisionamento da US-110 passa a gravar os três campos na versão 1 dos tenants novos.
- **RN-PLAT-285** — Notificação `TEMPLATE_LIBRARY_UPDATE`: destinatários = vínculos `ACTIVE` com `TEMPLATE_PUBLISH` (máx. 50, como nos demais tipos de oferta); canal in-app, e-mail desligado por padrão, não obrigatória (preferência editável na US-113); uma por `(tenant, libraryVersion)`; sem agrupamento; texto com os nomes dos tipos de documento, nunca o conteúdo; `link` relativo `/admin/templates?atualizacoes=1`.
- **RN-PLAT-286** — Diferença (TPL-14): comparação **de duas vias** entre a versão publicada do tenant e a definição vigente da biblioteca. Por seção (chave `key`): `UNCHANGED`, `CHANGED` (com `changedFields[]` entre `title`, `requirement`, `helpText`, `legalBasis`, `defaultContent`, `render`, `minChars`, `maxChars`, `allowNarrative`, `order`), `ADDED_IN_LIBRARY` (só na biblioteca) e `ONLY_IN_TENANT` (só no tenant). Por bloco: `layout`, `fieldConfig` e `importMappings` (`UNCHANGED` ou `CHANGED`). `customized = (contentHash ≠ libraryContentHash)` da versão publicada. Como a biblioteca anterior não é guardada, uma diferença `CHANGED` não distingue o que foi melhoria da plataforma do que foi personalização do órgão (lacuna 3).
- **RN-PLAT-287** — Detalhe sob demanda: TPL-14 devolve o resumo por seção; com `?sectionKey=` devolve `mine` e `library` completos daquela seção (`helpText`, `legalBasis` e `defaultContent` em TipTap), para a comparação lado a lado; o conteúdo vem só de versões do próprio tenant e da biblioteca da plataforma, sem dados de processo.
- **RN-PLAT-288** — Adoção (TPL-15): cria **uma nova versão** `DRAFT` do mesmo template com `versionNumber = máx + 1`, montada das escolhas (RN-PLAT-289); `libraryVersion` e `libraryContentHash` = os da biblioteca vigente; `changeNotes` = "Atualização da biblioteca padrão {libraryVersion} (adoção assistida)". **Nunca** altera a versão publicada, `currentPublishedVersionId`, o padrão do tipo ou documentos existentes (RN-TPL-16/RN-TPL-36), e **nunca publica**: a publicação é um passo à parte (`TPL-10`). O conteúdo montado passa por inteiro no `TemplateContentValidator` (RN-TPL-04..09, RN-TPL-34); qualquer violação → `422 TEMPLATE_INVALID` com `violations[]` e nada é criado.
- **RN-PLAT-289** — Escolhas e padrões: o corpo pode trazer `choices.sections[chave] = LIBRARY | MINE` e `choices.layout`, `choices.fieldConfig`, `choices.importMappings` (`LIBRARY | MINE`). Padrões: se `customized = false`, tudo `LIBRARY`; se `customized = true`, seções `CHANGED` e blocos `CHANGED` ficam `MINE`, `ADDED_IN_LIBRARY` entra (`LIBRARY`) e `ONLY_IN_TENANT` é mantida (`MINE`). Chave inexistente na diferença → `422 VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`); valor fora do enum → `INVALID_ENUM`. A ordem do rascunho segue a da biblioteca, com as seções só do tenant mantidas após a seção anterior mais próxima.
- **RN-PLAT-290** — Rascunho existente: se o template já tem versão `DRAFT` (inclusive de adoção anterior), `409 TEMPLATE_DRAFT_EXISTS` com `meta.draftVersionId` (mesma resposta da TPL-06); a corrida entre duas adoções é decidida pelo índice parcial `UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'`.
- **RN-PLAT-291** — Defasagem: o corpo traz `libraryVersion` (a vista pela pessoa); se diferir da vigente → `409 LIBRARY_UPDATE_STALE` com `meta.currentLibraryVersion`. Concorrência otimista sobre o template: `If-Match` obrigatório (`428 PRECONDITION_REQUIRED`, `412 VERSION_CONFLICT`); `Idempotency-Key` obrigatória na adoção (mesma chave e corpo devolvem o mesmo resultado, `Idempotent-Replayed: true`; corpo diferente → `422 IDEMPOTENCY_KEY_REUSED`).
- **RN-PLAT-292** — Dispensa (TPL-17): grava `libraryUpdateDismissedHash` (hash vigente), `libraryUpdateDismissedAt` e `libraryUpdateDismissedById` no template, com `If-Match`; é idempotente (repetir com o mesmo hash não regrava nem audita de novo); só vale com `status = AVAILABLE` (senão `409 LIBRARY_UPDATE_NOT_AVAILABLE`). Dispensar não impede adotar depois e nunca apaga a oferta; uma biblioteca com hash diferente volta a `AVAILABLE`. A dispensa gera auditoria `template.library_dismiss`, sem evento de domínio.
- **RN-PLAT-293** — Permissões: TPL-14 e TPL-16 exigem `TEMPLATE_VIEW`; TPL-15 exige `TEMPLATE_MANAGE` **e** `TEMPLATE_PUBLISH` (cria rascunho e consome a oferta); TPL-17 exige `TEMPLATE_PUBLISH`. MFA conforme POL-14 nas de risco `H`. O seeder e a detecção atuam como `SYSTEM`.
- **RN-PLAT-294** — O que não é oferta: mudança só do rótulo `libraryVersion` sem mudança de hash; template inativo; sem versão publicada; versão aposentada (`RETIRED`) sem outra publicada; biblioteca com tipo novo que o tenant não tem (criar templates novos não é escopo desta story).
- **RN-PLAT-295** — Publicação do rascunho adotado: segue a US-108 sem exceção (`TEMPLATE_PUBLISH`, MFA, `TEMPLATE_INVALID` na validação integral); a versão publicada mantém `libraryVersion` e `libraryContentHash` da adoção, o que encerra a oferta. Novas versões criadas por TPL-06 clonam também esses dois campos da versão de origem (ajuste aditivo da US-108).
- **RN-PLAT-296** — Eventos e auditoria: a adoção publica `TemplateLibraryUpdateAdopted` (`templateId`, `templateVersionId`, `libraryKey`, `libraryVersion`) e audita `template.library_adopt` (`CONFIGURATION`, no lugar de `template.version_create`); a publicação posterior gera `template.version_publish` e `TemplateVersionPublished` normalmente.
- **RN-PLAT-297** — Listagem (TPL-16): devolve, para o tenant, os templates com origem e `status` diferente de `NONE`, com `documentTypeCode`, `libraryKey`, `libraryVersion` do tenant e a vigente, `customized`, `draftVersionId?` e `dismissedAt?`; é a fonte do selo e da faixa em SCR-033. A rota literal `/templates/library-updates` tem precedência sobre `/templates/{id}`.
- **RN-PLAT-298** — KPI: a taxa "adotadas ou dispensadas em 30 dias" = (`TemplateLibraryUpdateAdopted` + `template.library_dismiss`) ÷ templates listados em `TemplateLibraryUpdateAvailable`, por `libraryVersion`; métrica `cf_template_library_update_resolved_ratio`.
- **RN-PLAT-299** — Nada nesta story altera documento já criado, `Document.templateVersionId`, o `defaultTemplateId` do tipo ou versões publicadas; a atualização só tem efeito sobre documentos criados depois que a versão adotada for publicada e for a corrente do template.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Versão da biblioteca vista | `libraryVersion` | texto (≤ 20) | Sim (adotar) | deve ser a vigente (RN-PLAT-291) | TPL-14 |
| Escolha por seção | `choices.sections[chave]` | `LIBRARY`, `MINE` | Não | RN-PLAT-289 | padrão calculado |
| Escolha de layout | `choices.layout` | `LIBRARY`, `MINE` | Não | RN-PLAT-289 | padrão calculado |
| Escolha de campos | `choices.fieldConfig` | `LIBRARY`, `MINE` | Não | RN-PLAT-289 | padrão calculado |
| Escolha de importação | `choices.importMappings` | `LIBRARY`, `MINE` | Não | só no tipo `TR` | padrão calculado |
| Seção a detalhar | `sectionKey` (query de TPL-14) | texto | Não | chave existente na diferença | — |
| Situação da oferta | `status` | `NONE`, `AVAILABLE`, `DISMISSED`, `IN_PROGRESS` | — | RN-PLAT-282 | derivado |
| Modelo personalizado | `customized` | booleano | — | RN-PLAT-286 | derivado |
| Dispensada em / por | `libraryUpdateDismissedAt`, `libraryUpdateDismissedById` | timestamptz / uuid | — | RN-PLAT-292 | ação de dispensar |
| *(sistema)* Origem | `libraryKey`, `libraryVersion`, `libraryContentHash` | texto | — | RN-PLAT-280/284 | seeder |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Template sem origem, inativo, em dia ou sem versão publicada | API | "Este modelo não tem atualização disponível." | `LIBRARY_UPDATE_NOT_AVAILABLE` |
| V-02 | `libraryVersion` informada diferente da vigente | API | "A biblioteca foi atualizada de novo. Revise as diferenças." | `LIBRARY_UPDATE_STALE` |
| V-03 | Já existe rascunho para o template | API | "Já existe um rascunho em edição para este modelo." | `TEMPLATE_DRAFT_EXISTS` |
| V-04 | Conteúdo montado reprova a validação de publicação | API | "O modelo resultante tem pendências. Ajuste as escolhas." | `TEMPLATE_INVALID` (`violations[]`) |
| V-05 | Escolha com seção inexistente ou valor fora do enum | Front + API (Zod) | "Escolha inválida para a seção {chave}." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`INVALID_ENUM`) |
| V-06 | `If-Match` ausente | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-07 | `If-Match` divergente | API | "Este modelo foi alterado por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-08 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |
| V-09 | Sem permissão para a ação | API | "Você não tem permissão para esta ação." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `TEMPLATE_VIEW` (TPL-14, TPL-16); `TEMPLATE_MANAGE` + `TEMPLATE_PUBLISH` (TPL-15); `TEMPLATE_PUBLISH` (TPL-17). Permissões de configuração do tenant, sem escopo. Hoje as duas últimas estão nos perfis `ADMIN_ORGAO` e no perfil de configuração documental (matriz de permissions.md).
- **Políticas:** POL-14 (MFA) em `TEMPLATE_PUBLISH` (risco `H`); DEC-024 e POL-09 não se aplicam (nada de processo); o conteúdo comparado é só de modelos.
- **MFA:** exigido em TPL-15 e TPL-17 conforme `security.mfaPolicy`; `403 MFA_REQUIRED` dispara o *step-up*; leitura (TPL-14, TPL-16) não exige.
- **Sem permissão:** com só `TEMPLATE_VIEW`, a pessoa vê o selo e a diferença, com "Criar rascunho" e "Dispensar" ocultos; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = permissão faltante). Template de outro tenant: `404 NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TemplateLibraryUpdateAvailable` | `template.library_update_available` | Seeder detecta ao menos um template em `AVAILABLE` (RN-PLAT-283) | Payload: `libraryVersion`, `templatesChanged[]` (`{ libraryKey, documentTypeCode }`); consumidor `N`; `eventId` determinístico; `actorType = SYSTEM` |
| `TemplateLibraryUpdateAdopted` | `template.library_update_adopted` | Commit de TPL-15 | Payload: `templateId`, `templateVersionId`, `libraryKey`, `libraryVersion`; consumidor `C` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `TEMPLATE_LIBRARY_UPDATE` | Vínculos ativos com `TEMPLATE_PUBLISH` (máx. 50) | In-app (e-mail desligado por padrão, preferência do usuário); não obrigatória | `TemplateLibraryUpdateAvailable`; uma vez por `(tenant, libraryVersion)` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Atualizar a biblioteca padrão de templates com adoção assistida

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o template "ETP — Modelo padrão" tem "libraryKey" "ETP" e a versão 1 publicada com "libraryVersion" "1.0.0"
    And o template "Ofício da Secretaria" foi criado pelo órgão e não tem "libraryKey"
    And a biblioteca do release traz "libraryVersion" "1.1.0" com a seção "RISKS" do ETP alterada e uma seção nova "LEGAL_BASIS_NOTE"
    And "Marta" é "ADMIN_ORGAO" com "TEMPLATE_VIEW", "TEMPLATE_MANAGE" e "TEMPLATE_PUBLISH"
    And "Bruno" possui apenas "TEMPLATE_VIEW"

  Scenario: [Sucesso] O deploy da biblioteca nova gera a oferta e o aviso
    When o seeder "document.templateLibrary" for executado no tenant depois do deploy
    Then deve ser gerado o evento "TemplateLibraryUpdateAvailable" com "libraryVersion" "1.1.0" e "templatesChanged" contendo "ETP"
    And "Marta" deve receber a notificação "TEMPLATE_LIBRARY_UPDATE"
    And "Bruno" não deve recebê-la
    And o template "ETP — Modelo padrão" deve estar com "status" "AVAILABLE" em "TPL-16"

  Scenario: [Sucesso] Ver a diferença seção a seção
    When "Marta" consultar "TPL-14" do template "ETP — Modelo padrão"
    Then a seção "RISKS" deve vir "CHANGED" com "changedFields" contendo "helpText"
    And a seção "LEGAL_BASIS_NOTE" deve vir "ADDED_IN_LIBRARY"
    And as demais seções devem vir "UNCHANGED"
    And "customized" deve ser falso

  Scenario: [Sucesso] Adotar cria uma nova versão em rascunho sem alterar a publicada
    When "Marta" adotar a atualização com "libraryVersion" "1.1.0", "Idempotency-Key" e "If-Match" atual
    Then a API deve responder 201 com uma versão "DRAFT" de "versionNumber" 2 e "libraryContentHash" da biblioteca 1.1.0
    And a versão 1 deve continuar "PUBLISHED" e "currentPublishedVersionId" não deve mudar
    And deve gerar o evento "TemplateLibraryUpdateAdopted" e a auditoria "template.library_adopt"
    And o "status" do template deve passar a "IN_PROGRESS"

  Scenario: [Sucesso] Modelo personalizado preserva o texto do órgão por padrão
    Given que a versão publicada do ETP foi personalizada pelo órgão na seção "RISKS" e "contentHash" difere de "libraryContentHash"
    When "Marta" adotar a atualização sem informar escolhas
    Then o rascunho deve manter a seção "RISKS" do órgão
    And deve incluir a seção nova "LEGAL_BASIS_NOTE" da biblioteca

  Scenario: [Sucesso] Escolher o texto da biblioteca para uma seção
    Given que o modelo foi personalizado
    When "Marta" adotar com "choices.sections.RISKS" igual a "LIBRARY"
    Then a seção "RISKS" do rascunho deve ter o texto da biblioteca 1.1.0

  Scenario: [Sucesso] Publicar o rascunho encerra a oferta
    Given que existe o rascunho adotado da versão 2
    When "Marta" publicar a versão 2 pelo fluxo normal
    Then "currentPublishedVersionId" deve apontar para a versão 2
    And o "status" do template deve passar a "NONE"

  Scenario: [Sucesso] Dispensar a oferta e receber a seguinte
    When "Marta" dispensar a atualização do ETP
    Then o "status" deve passar a "DISMISSED" e deve gerar a auditoria "template.library_dismiss"
    When a biblioteca "1.2.0" for publicada com outro hash para o ETP
    Then o "status" deve voltar a "AVAILABLE"

  Scenario: [Sucesso] Template do órgão sem origem não recebe oferta
    When o seeder for executado
    Then o template "Ofício da Secretaria" deve ter "status" "NONE" em "TPL-14"
    And não deve constar em "templatesChanged"

  Scenario: [Validação] Adotar um template sem atualização
    When "Marta" tentar adotar a atualização do template "Ofício da Secretaria"
    Then a API deve responder 409 com código "LIBRARY_UPDATE_NOT_AVAILABLE"
    And nenhuma versão deve ser criada

  Scenario: [Validação] Biblioteca mudou entre ver e adotar
    Given que "Marta" viu a diferença da biblioteca "1.1.0"
    And a biblioteca "1.2.0" foi publicada
    When "Marta" adotar informando "libraryVersion" "1.1.0"
    Then a API deve responder 409 com código "LIBRARY_UPDATE_STALE" e "meta.currentLibraryVersion" igual a "1.2.0"

  Scenario: [Validação] Escolha para seção inexistente
    When "Marta" adotar com "choices.sections.INEXISTENTE" igual a "LIBRARY"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"

  Scenario: [Validação] Conteúdo resultante inválido
    Given que a escolha mantém uma seção do órgão com variável desconhecida
    When "Marta" adotar a atualização
    Then a API deve responder 422 com código "TEMPLATE_INVALID" e "violations" apontando a seção
    And nenhum rascunho deve ser criado

  Scenario: [Permissão] Quem só pode ver não adota nem dispensa
    When "Bruno" tentar adotar a atualização do ETP
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    But "Bruno" deve conseguir ver a diferença em "TPL-14"

  Scenario: [Permissão] Adotar exige MFA conforme a política
    Given que "security.mfaPolicy" é "ADMINS" e a sessão de "Marta" não tem MFA
    When "Marta" tentar adotar a atualização
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Template de outro tenant
    Given que o template "ETP — Modelo padrão" de "Prefeitura B" tem atualização disponível
    When "Marta", no tenant "Prefeitura de São José", consultar "TPL-14" com o id desse template
    Then a API deve responder 404 com código "NOT_FOUND"
    And o aviso "TEMPLATE_LIBRARY_UPDATE" de "Prefeitura B" não deve chegar a "Marta"

  Scenario: [Duplicidade] Seeder reexecutado não duplica o aviso
    Given que o seeder já gerou o evento "TemplateLibraryUpdateAvailable" da biblioteca "1.1.0"
    When o seeder for executado novamente
    Then nenhum novo evento nem notificação deve ser criado

  Scenario: [Duplicidade] Reenvio da adoção com a mesma chave de idempotência
    Given que "Marta" adotou a atualização com a chave "K1"
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo resultado e "Idempotent-Replayed" verdadeiro
    And deve existir um único rascunho

  Scenario: [Duplicidade] Segunda adoção com rascunho existente
    Given que já existe o rascunho adotado da versão 2
    When "Marta" adotar de novo com outra chave de idempotência
    Then a API deve responder 409 com código "TEMPLATE_DRAFT_EXISTS" e "meta.draftVersionId" do rascunho

  Scenario: [Concorrência] Duas pessoas adotam ao mesmo tempo
    Given que "Marta" e "Diego" têm "TEMPLATE_MANAGE" e "TEMPLATE_PUBLISH"
    When os dois adotarem a atualização do ETP quase simultaneamente
    Then apenas um rascunho deve ser criado
    And o outro deve receber 409 com código "TEMPLATE_DRAFT_EXISTS"

  Scenario: [Concorrência] Template alterado durante a análise
    Given que "Marta" abriu a diferença com o template na versão 5
    And "Diego" alterou o template, avançando para a versão 6
    When "Marta" adotar com "If-Match: \"5\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao adotar
    Given que o banco de dados fica indisponível durante a adoção
    When "Marta" adotar a atualização
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum rascunho nem evento deve ficar persistido

  Scenario: [Falha de banco] Falha do seeder em um tenant não afeta os demais
    Given que o banco falha durante o seeder do tenant "Prefeitura de São José"
    When o seeder for executado para todos os tenants
    Then os demais tenants devem receber a oferta
    And o tenant com falha deve ser reprocessado na próxima execução do "tenant:seed"

  Scenario: [Falha de integração] Fila de notificações indisponível
    Given que a fila "notifications" está indisponível
    When o seeder gerar o evento "TemplateLibraryUpdateAvailable"
    Then o evento deve permanecer "PENDING" no outbox e ser processado quando a fila voltar
    And a oferta deve continuar visível em "TPL-16" mesmo sem a notificação
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem atualização para o modelo | 409 | `LIBRARY_UPDATE_NOT_AVAILABLE` | "Este modelo não tem atualização disponível." | Oculta a faixa e recarrega |
| Biblioteca mudou | 409 | `LIBRARY_UPDATE_STALE` | "A biblioteca foi atualizada de novo. Revise as diferenças." | Recarrega a diferença |
| Rascunho existente | 409 | `TEMPLATE_DRAFT_EXISTS` | "Já existe um rascunho em edição para este modelo." | "Abrir o rascunho existente" |
| Conteúdo resultante inválido | 422 | `TEMPLATE_INVALID` | "O modelo resultante tem pendências. Ajuste as escolhas." | Aponta as seções |
| Escolha inválida | 422 | `VALIDATION_ERROR` | "Escolha inválida para a seção {chave}." | Erro na seção |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta as ações |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara o *step-up* |
| Template inexistente/outro tenant | 404 | `NOT_FOUND` | "Modelo não encontrado." | Volta à lista |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "Recarregue a página e tente novamente." / "Este modelo foi alterado por outra pessoa. Recarregue." | Recarrega o modelo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas tentativas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | "Tentar novamente"; mantém as escolhas |

## Dependências
- **Stories:** US-108 (versões, `TPL-06`, publicação `TPL-10`, rascunho único), US-110 (biblioteca padrão, seeder `document.templateLibrary`; esta story substitui a RN-TPL-35 e a lacuna que ela registrou). Indiretas: US-107 (editor, `TemplateContentValidator`), US-109 (prévia), US-099 (provisionamento e `tenant:seed`), US-111/US-113 (notificações e preferências), US-097 (autorização), US-130 (padrão de oferta, dispensa e adoção).
- **Decisões/ADRs:** DEC-209 (DT-15), DEC-017 e ADR-006 (modelo documental), DEC-084 (hash canônico), DEC-196 (oferta, não imposição), DEC-104/DEC-105 (`If-Match`, idempotência), DEC-161 (outbox), DEC-108; POL-14.
- **Configurações:** nenhuma chave nova do tenant (a atualização de templates não depende de `workflow.offerSeedUpdates`); o conteúdo vigente da biblioteca vem do release (`libraryVersion`).
- **Lacunas nas fontes canônicas:**
  1. IDs de endpoint: a feature-058 reserva `TPL-14` (`GET /templates/{id}/library-update`) e `TPL-15` como `POST /templates/{id}/versions/from-library-update`; a FT-085 define `POST /templates/{id}/library-update/adopt`. Vale a FT-085. Acrescentados `TPL-16` (`GET /templates/library-updates`) e `TPL-17` (`POST /templates/{id}/library-update/dismiss`); ajustar a feature-058 e o `api.md` do MVP 2.
  2. As fontes não dizem se a adoção publica ou só cria rascunho: decidido **rascunho** (RN-PLAT-288), coerente com RN-PLAT-17 ("nova versão"), com a US-130 (adotar cria `DRAFT`) e com `TEMPLATE_PUBLISH` ser risco `H` com validação integral e MFA; a FT-085 lista só `TEMPLATE_PUBLISH` para adotar, e exigimos também `TEMPLATE_MANAGE` por criar a versão (ambos nos mesmos perfis).
  3. A biblioteca anterior não é guardada, então a comparação é de **duas vias** (publicada do tenant × biblioteca nova), sem separar personalização de melhoria. Alternativa: guardar as definições históricas (`libraryVersion` → fixture) para uma comparação de três vias; fica como evolução.
  4. O preenchimento de origem em tenants existentes (RN-PLAT-284) assume que a versão 1 semeada permanece com o conteúdo original; tenants cujo seeder rodou com fixture ajustada precisam de verificação de dados antes da migração.
  5. Não há evento de dispensa nem ação `template.library_dismiss` no catálogo de auditoria (events.md §7): proposta de incluir a ação em `CONFIGURATION`; o KPI usa a auditoria para contar dispensas.
  6. Colunas novas não previstas em entities.md §5.10: `DocumentTemplate.libraryUpdateDismissedHash` (varchar(64)), `libraryUpdateDismissedAt` e `libraryUpdateDismissedById`; e índice único parcial `(tenant_id, library_key) WHERE library_key IS NOT NULL`.
  7. Códigos de erro novos (`LIBRARY_UPDATE_NOT_AVAILABLE`, `LIBRARY_UPDATE_STALE`) a registrar em `api.md` §2.2.
  8. Não há endpoint para descartar um rascunho no MVP 1; um rascunho de adoção abandonado bloqueia novas adoções até ser publicado ou editado. **Dúvida de produto:** oferecer "descartar rascunho" (nova operação em `TPL-*`).
  9. O texto da biblioteca nova pode trazer seção que o tipo do tenant não aceita (`render`): coberto pela validação (RN-PLAT-288), mas a fixture da biblioteca já é validada no build (RN-TPL-34), logo o caso é raro.

## Impacto técnico
- **Performance:** a diferença compara no máximo 16 seções por template (ETP) e blocos pequenos; meta p95 ≤ 800 ms para TPL-14 (sem detalhe) e ≤ 1,5 s para TPL-15 na suíte de performance (endurecimento). O seeder processa por tenant em transação própria, com o hash da biblioteca em memória.
- **Segurança:** só conteúdo de modelos trafega; `defaultContent` segue o schema permitido de nós e marcas (DEC-056); a adoção é auditada e nunca publica.
- **Consistência:** rascunho único por índice parcial; `If-Match` no template e idempotência na adoção; a situação é derivada, sem estado duplicado a reconciliar.
- **Compatibilidade:** TPL-01..13 continuam iguais; campos novos de origem são aditivos; TPL-06 passa a clonar `libraryVersion`/`libraryContentHash`.
- **Risco de interpretação:** diferença de duas vias pode mostrar como "Alterada" o que é personalização do órgão; mitigado pelos padrões conservadores (`MINE`) e pelo aviso "Você personalizou este modelo".

## Backend
- **Módulo(s):** `document` (dono: `DocumentTemplate`, `DocumentTemplateVersion`, biblioteca, seeder), `notification` (tipo e texto), `access` (destinatários por `TEMPLATE_PUBLISH`), `platform` (outbox, `tenant:seed`), `audit`.
- **Casos de uso:** `GetLibraryUpdateQuery` (TPL-14), `ListLibraryUpdatesQuery` (TPL-16), `AdoptLibraryUpdateCommand` (TPL-15), `DismissLibraryUpdateCommand` (TPL-17), `TemplateLibrarySeeder` v2 (`document.templateLibrary`).
- **Domínio:** `TemplateLibraryCatalog` (fixture vigente, `libraryVersion`, hash por chave), `TemplateLibraryDiffer` (duas vias, por seção e bloco), `TemplateLibraryUpdate.status(template, catalog)`, `LibraryAdoptionAssembler` (aplica as escolhas e a ordem), `TemplateContentValidator` (da US-107).
- **Integrações internas:** `ContentHasher.hashCanonical` (RN-TPL-15), `RecipientResolver` (`TEMPLATE_PUBLISH`), `IdempotencyService`.
- **Transação:** TPL-15 cria a versão `DRAFT`, audita e grava o outbox em uma transação; TPL-17 atualiza o template e audita; o seeder abre uma `TenantTransaction` por tenant como `SYSTEM`.

## Frontend
- **Tela(s):** SCR-033 (`/admin/templates`: faixa e selo; `/admin/templates/{id}`: painel "Atualização do modelo padrão"; `/admin/templates/{id}/atualizacao`: diferença e escolhas) e SCR-114 (editor do rascunho criado).
- **Componentes:** `LibraryUpdateBanner`, `LibraryUpdateBadge`, `LibraryDiffList` (por seção, com situação em texto e ícone), `SectionCompare` (lado a lado, com marcação de trechos adicionados e removidos), `ChoiceRadioGroup` ("Manter o meu" / "Usar o da biblioteca"), `AdoptConfirmDialog`, `DismissButton`.
- **Dados:** TanStack Query — `['t', tenantId, 'templates', 'library-updates']`, `['t', tenantId, 'templates', id, 'library-update']`; a adoção invalida a lista e leva ao editor.
- **Estados:** skeleton na diferença; "Sem atualização" (`NONE`); `AVAILABLE`, `IN_PROGRESS` (com "Abrir o rascunho") e `DISMISSED` (com "Adotar mesmo assim"); erro com "Tentar novamente"; escolhas preservadas em erro.
- **Acessibilidade e responsividade:** mudanças comunicadas por texto ("Adicionado", "Removido") e não só por cor; comparação navegável por teclado, em coluna única abaixo de 768 px; rádios com rótulos associados; resumo anunciado por `aria-live` depois de criar o rascunho.

## Banco de dados
- **Tabelas:** `document_templates` (colunas de origem e dispensa), `document_template_versions` (origem), `audit_logs`, `outbox_events`, `notifications`.
- **Migrações:** `document_templates` ganha `library_key varchar(60) null`, `library_update_dismissed_hash varchar(64) null`, `library_update_dismissed_at timestamptz null`, `library_update_dismissed_by_id uuid null`; `document_template_versions` ganha `library_version varchar(20) null` e `library_content_hash varchar(64) null`; o preenchimento dos tenants existentes é feito pelo seeder (RN-PLAT-284).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, library_key) WHERE library_key IS NOT NULL`; reaproveita `UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'` e `UNIQUE (tenant_id, template_id, version_number)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TPL-14` | GET | `/api/v1/templates/{id}/library-update` | `sectionKey?` | `200 { data: { status, libraryKey, tenantLibraryVersion, currentLibraryVersion, customized, sections[] { key, status, changedFields[] }, blocks { layout, fieldConfig, importMappings }, draftVersionId?, dismissedAt?, section? { mine, library } }, meta }` | 200, 401, 403, 404 |
| `TPL-15` | POST | `/api/v1/templates/{id}/library-update/adopt` | `{ libraryVersion, choices? }` + `Idempotency-Key` + `If-Match` | `201 { data: TemplateVersion }` (`status = DRAFT`) com `Location` e `ETag` | 201, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `TPL-16` | GET | `/api/v1/templates/library-updates` | — | `200 { data: [{ templateId, name, documentTypeCode, libraryKey, status, tenantLibraryVersion, currentLibraryVersion, customized, draftVersionId?, dismissedAt? }] }` | 200, 401, 403 |
| `TPL-17` | POST | `/api/v1/templates/{id}/library-update/dismiss` | `{}` + `If-Match` | `200 { data: { status: "DISMISSED", dismissedAt } }` | 200, 401, 403, 404, 409, 412, 428, 503 |

## Logs
- `info` `template_library.update_offered` — `tenantId`, `libraryVersion`, `templatesChangedCount`, `durationMs`.
- `info` `template_library.update_adopted` — `templateId`, `templateVersionId`, `libraryKey`, `libraryVersion`, `sectionsFromLibrary`, `sectionsKept`.
- `info` `template_library.update_dismissed` — `templateId`, `libraryKey`.
- `warn` `template_library.update_check_failed` — falha ao calcular ou comparar `contentHash` (reaproveitado da US-110).
- `error` `template_library.seed_failed` — `documentTypeCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções (`defaultContent`, `helpText`), apenas chaves e contagens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `template.library_adopt` | `CONFIGURATION` | Commit de TPL-15 | `metadata`: `templateId`, `templateVersionId`, `libraryKey`, `libraryVersion`, `clonedFromVersionId`, `sectionsFromLibrary[]`, `sectionsKept[]`, `idempotencyKey` (sem conteúdo) |
| `template.library_dismiss` | `CONFIGURATION` | Commit de TPL-17 | `metadata`: `templateId`, `libraryKey`, `libraryVersion`, `libraryContentHash` |
| `template.version_publish` | `CONFIGURATION` | Publicação do rascunho adotado (TPL-10) | Reaproveitado da US-108 |
| `access.denied` | `ACCESS` | Sem a permissão da ação | `reasonCode` = permissão faltante |

## Testes necessários
- **Unitários:** `TemplateLibraryDiffer` (igual, alterada, nova, só no tenant; blocos); `TemplateLibraryUpdate.status` (`NONE`, `AVAILABLE`, `DISMISSED`, `IN_PROGRESS`); `LibraryAdoptionAssembler` (padrões com e sem personalização, ordem); cálculo do hash igual ao da RN-TPL-15.
- **Integração (Testcontainers PostgreSQL):** seeder com preenchimento de origem e detecção; idempotência do seeder; adoção cria `DRAFT` sem tocar na publicada; rascunho único sob concorrência; dispensa e nova biblioteca; RLS.
- **API/contrato:** TPL-14..17 conforme o `api.md`; códigos de erro; cabeçalhos `Idempotency-Key`, `If-Match`, `Location`, `ETag`.
- **RBAC e multi-tenant:** `TEMPLATE_VIEW` × `TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH`; MFA; template e aviso de outro tenant nunca visíveis (suíte `test/tenant-leak`).
- **Concorrência:** duas adoções simultâneas; `If-Match` divergente; biblioteca trocada entre a diferença e a adoção.
- **E2E (Playwright):** deploy simulado → aviso → ver diferença → escolher → criar rascunho → editar → publicar → oferta some; dispensar e adotar depois.
- **Acessibilidade/performance:** axe na comparação; p95 de TPL-14 e TPL-15 na suíte de performance (endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de TPL-14..17 compatível com o `api.md`
- [ ] Logs sem conteúdo de seções; métricas (`cf_template_library_update_resolved_ratio`) e traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card, US-110 e fontes canônicas) atualizada
- [ ] Teste de que a adoção nunca altera a versão publicada, o padrão do tipo nem documentos existentes
- [ ] Teste do preenchimento de origem em tenants existentes e da detecção idempotente após o deploy

## Estimativa
**M** — reaproveita o editor, a publicação, as notificações e o padrão de oferta da US-130; o esforço está na diferença por seção, na montagem do rascunho a partir das escolhas, no seeder de detecção e preenchimento de origem e na tela de comparação.

## Prioridade
**P2** — débito do MVP 1 (DT-15) com contorno manual disponível (RN-TPL-35); melhora a manutenção dos modelos padrão e não bloqueia outras stories.
