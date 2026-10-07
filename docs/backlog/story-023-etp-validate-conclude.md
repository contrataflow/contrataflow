---
id: US-023
title: "Validar completude do ETP e concluí-lo"
epic: EP-003
feature: FT-014
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-020, US-021, US-022]
modules: [etp, document]
screens: [SCR-008]
endpoints: [ETP-03, ETP-04, DOC-08, DOC-10]
permissions: [ETP_UPDATE, ETP_SUBMIT]
events: [DocumentFinalized, DocumentVersionCreated]
---

# US-023 — Validar completude do ETP e concluí-lo

## Título
Validar completude do ETP e concluí-lo

## Descrição
**Como** redator do ETP com custódia do processo, **quero** ver quais pendências impedem a conclusão do ETP e finalizá-lo quando estiver completo, **para** avançar a fase preparatória com segurança de que o documento atende ao art. 18 da Lei 14.133/2021 antes de seguir para aprovação.

O sistema valida a completude do ETP conforme a configuração semeada do template (DEC-016) e as regras próprias do tipo (conclusão, parcelamento, alternativa recomendada, itens e valor), listando pendências bloqueantes e avisos. Sem pendência bloqueante, o usuário finaliza o ETP (`FINALIZED`), criando uma versão imutável; a aprovação formal ocorre depois, na etapa do workflow sob responsabilidade da autoridade (US-052).

## Contexto
- Art. 18, §§1º e 2º, da Lei 14.133/2021 e a IN SEGES/ME 58/2022 definem os elementos do ETP; a obrigatoriedade de cada seção é configuração semeada por `SectionDefinition.requirement` (DEC-016), não código.
- DEC-018: tipos semeados (ETP incluso) têm `requiresApproval = false` — finalizar é concluir o documento; a aprovação formal acontece em etapa `APPROVAL` do workflow que cobre o tipo (US-051 solicita, US-052 decide), fora deste card.
- `EtpConclusion` (`PENDING`\|`VIABLE`\|`NOT_VIABLE`) e `ParcelingDecision` são campos do cabeçalho tipado (DEC-017) que condicionam a completude, definidos pelo mesmo `PATCH /etps/{id}` (`ETP-04`) usado em US-022.
- Esta story é a "dona" das regras de completude específicas do ETP (prefixo `ETP_*`), conforme delegado em api.md §2.1.2.
- Depende do conteúdo preenchido pelas demais stories do épico: seções (US-020), alternativas (US-021) e estimativas (US-022).

## Objetivo
100% dos ETPs finalizados têm todas as pendências bloqueantes resolvidas e, quando concluídos como "não viável", o aviso correspondente foi explicitamente reconhecido — nenhum ETP incompleto avança para aprovação.

## Persona
- **Principal:** Redator do ETP com custódia do processo (perfil `REQUISITANTE` ou `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha pendências antes de cobrar a conclusão.

## Pré-condições
- ETP em `DRAFT`/`RETURNED`, com seções (US-020), alternativas (US-021) e estimativas (US-022) preenchidas conforme o estágio do trabalho.
- Usuário com `ETP_UPDATE`/`ETP_SUBMIT` e custódia/participação (POL-02).

## Fluxo principal
1. O usuário abre o ETP (SCR-008); a navegação lateral mostra a completude por seção (US-020) e um resumo "Pendências para concluir".
2. O sistema consulta `GET /documents/{id}/validation` (`DOC-08`), que roda a validação genérica de seções (template) e a validação específica do ETP, retornando `violations[]` com severidade.
3. O usuário define **Conclusão** (viável/não viável) e **Decisão sobre parcelamento**, se ainda não definidos, enviados via `PATCH /etps/{id}` (`ETP-04`) com `If-Match`.
4. O usuário resolve as pendências `BLOCKING` restantes navegando pelos links do resumo (seções, alternativas, estimativas).
5. Com `conclusion = NOT_VIABLE`, o painel exibe o aviso "Este ETP conclui pela não viabilidade da contratação" e exige reconhecimento explícito.
6. Sem pendências `BLOCKING` (e com avisos reconhecidos), o botão "Concluir ETP" é habilitado; o usuário clica e confirma.
7. O front envia `POST /documents/{id}/finalize` (`DOC-10`) com `Idempotency-Key`, `If-Match` e `acknowledgedWarnings[]` quando houver aviso. A API revalida tudo na mesma transação; persiste `status = FINALIZED`, `finalizedAt/finalizedById`; cria `DocumentVersion` (`reason = FINALIZATION`); grava auditoria `document.finalize`; publica `DocumentFinalized` e `DocumentVersionCreated`; projeta timeline `DOCUMENT_FINALIZED`.
8. A API responde 200; o front exibe "ETP concluído" e o próximo passo ("Aguardando a etapa de aprovação" ou "Encaminhe o processo").

## Fluxos alternativos
- **FA-01 — Pendência resolvida fora de ordem:** o resumo de pendências se atualiza a cada seção salva, sem precisar reabrir a tela de validação.
- **FA-02 — Concluir diretamente sem revisar o painel:** clicar em "Concluir ETP" sem antes abrir o resumo dispara a mesma validação no servidor; as pendências aparecem no mesmo formato.
- **FA-03 — Nova pendência surge entre a consulta e o clique:** se outra pessoa alterar o ETP entre os passos 2 e 6 (ex.: remover a alternativa recomendada), a finalização é bloqueada com as pendências atuais, não as da última consulta (RN-ETP-37).
- **FA-04 — Processo fora de status editável:** se o processo não estiver em `DRAFT`/`IN_PROGRESS`/`RETURNED`, a conclusão é bloqueada por POL-02 mesmo com o ETP em `DRAFT`.

## Regras de negócio
- **RN-ETP-33** — Completude de seções segue a configuração semeada do template (DEC-016): `REQUIRED` deve estar `FILLED`; `REQUIRED_OR_JUSTIFY` deve estar `FILLED` ou `NOT_APPLICABLE` com `justification` ≥ 20 caracteres; `OPTIONAL` sem exigência — violações `SECTION_REQUIRED`/`SECTION_JUSTIFICATION_REQUIRED`.
- **RN-ETP-34** — Bloqueante, independente da conclusão: `conclusion` ≠ `PENDING` (`FIELD_REQUIRED`, campo `conclusion`); `parcelingDecision` informado (`FIELD_REQUIRED`, campo `parcelingDecision`); ao menos 1 item com quantidade (`ITEMS_REQUIRED`).
- **RN-ETP-35** — Se `conclusion = VIABLE`: deve existir exatamente uma `EtpAlternative` com `decision = RECOMMENDED` (`ETP_RECOMMENDED_ALTERNATIVE_REQUIRED`) e `estimatedTotalValue` deve estar presente (`ETP_ESTIMATED_VALUE_REQUIRED`).
- **RN-ETP-36** — Se `conclusion = NOT_VIABLE`: gera aviso `ETP_NOT_VIABLE_CONCLUSION` (severidade `WARNING`), que não bloqueia, mas exige constar em `acknowledgedWarnings[]` no comando de finalizar (DEC-016).
- **RN-ETP-37** — Finalizar (`DOC-10`) revalida tudo na mesma transação; violação `BLOCKING` → `DOCUMENT_INCOMPLETE` (422, `violations[]`); `WARNING` não reconhecido → `WARNINGS_NOT_ACKNOWLEDGED` (422).
- **RN-ETP-38** — Ao finalizar: cria `DocumentVersion` (`reason = FINALIZATION`) e bloqueia edição (`DOCUMENT_NOT_EDITABLE`) até reabertura (`DOCUMENT_REOPEN`, POL-11 — fora deste card) ou até a etapa de aprovação ser concluída.
- **RN-ETP-39** — A aprovação formal do ETP ocorre na etapa `APPROVAL` do workflow que cobrir o tipo (US-051/US-052); este card não solicita aprovação.
- **RN-ETP-40** — Valores exibidos no resumo de pendências e na confirmação seguem o mascaramento da POL-09.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Conclusão do ETP | `conclusion` | seleção (`VIABLE`\|`NOT_VIABLE`) | Sim, para concluir | RN-ETP-34/35 | `PENDING` |
| Decisão sobre parcelamento | `parcelingDecision` | seleção (`ParcelingDecision`) | Sim, para concluir | RN-ETP-34 | — |
| Avisos reconhecidos | `acknowledgedWarnings[]` | lista de ids | Condicional (há `WARNING`) | RN-ETP-36 | vazio |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Seção `REQUIRED` vazia | Front + API | "Preencha a seção \"{seção}\" para concluir." | `SECTION_REQUIRED` |
| V-02 | Seção `REQUIRED_OR_JUSTIFY` sem justificativa ≥ 20 caracteres | Front + API | "Justifique por que a seção \"{seção}\" não se aplica (mín. 20 caracteres)." | `SECTION_JUSTIFICATION_REQUIRED` |
| V-03 | `conclusion = PENDING` | Front + API | "Defina a conclusão do ETP (viável ou não viável)." | `FIELD_REQUIRED` |
| V-04 | `parcelingDecision` ausente | Front + API | "Informe a decisão sobre o parcelamento." | `FIELD_REQUIRED` |
| V-05 | Nenhum item com quantidade | Front + API | "Informe ao menos um item com quantidade." | `ITEMS_REQUIRED` |
| V-06 | `VIABLE` sem alternativa recomendada | Front + API | "Defina a alternativa recomendada antes de concluir." | `ETP_RECOMMENDED_ALTERNATIVE_REQUIRED` |
| V-07 | `VIABLE` sem valor estimado | Front + API | "Informe o valor estimado (manual ou pesquisa de preços)." | `ETP_ESTIMATED_VALUE_REQUIRED` |
| V-08 | `NOT_VIABLE` sem reconhecimento do aviso | API | "Confirme que está ciente da conclusão pela não viabilidade." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-09 | Documento fora de `DRAFT`/`RETURNED` | API | "Este ETP já foi concluído ou não pode ser concluído agora." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `ETP_UPDATE` para definir conclusão/parcelamento; `ETP_SUBMIT` para concluir (finalizar) — ambas com custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02).
- **Políticas:** POL-02 (edição/conclusão); POL-09 (mascaramento).
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão "Concluir ETP" oculto; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentFinalized` | `document.finalized.etp` | Commit da finalização | Sem `typedSummary` (não definido para ETP no catálogo) |
| `DocumentVersionCreated` | `document.version_created.etp` | Mesma transação | `reason = FINALIZATION` |

Projeção síncrona: timeline `DOCUMENT_FINALIZED`. Não há `ApprovalRequested` neste card (RN-ETP-39) — ocorre somente quando o processo entrar na etapa de aprovação (US-051).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a finalização gera timeline/auditoria/evento; a notificação ao aprovador ocorre na entrada da etapa de aprovação (US-051), fora deste card. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Validar completude do ETP e concluí-lo

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o ETP "0007/2026" do processo "0012/2026" em status "DRAFT"

  Scenario: [Sucesso] Concluir ETP viável com todas as pendências resolvidas
    Given que o ETP tem todas as seções obrigatórias preenchidas, parcelamento definido, uma alternativa recomendada, 2 itens com quantidade e valor estimado "R$ 125.000,00"
    And a conclusão é "VIABLE"
    When "Ana" clicar em "Concluir ETP"
    Then o ETP deve mudar para o status "FINALIZED"
    And deve ser criada a versão 1 do documento
    And deve gerar o evento "DocumentFinalized"
    And deve gerar registro de auditoria "document.finalize"

  Scenario: [Sucesso] Concluir ETP não viável após reconhecer o aviso
    Given que o ETP tem conclusão "NOT_VIABLE" e as demais pendências bloqueantes resolvidas
    When "Ana" reconhecer o aviso "Este ETP conclui pela não viabilidade da contratação" e clicar em "Concluir ETP"
    Then o ETP deve mudar para o status "FINALIZED"
    And a auditoria "document.finalize" deve registrar o aviso reconhecido

  Scenario: [Validação] Tentar concluir sem alternativa recomendada
    Given que a conclusão é "VIABLE" e não existe alternativa com decisão "RECOMMENDED"
    When "Ana" clicar em "Concluir ETP"
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e violação "ETP_RECOMMENDED_ALTERNATIVE_REQUIRED"
    And o ETP deve permanecer em "DRAFT"

  Scenario: [Validação] Tentar concluir sem reconhecer o aviso de não viabilidade
    Given que a conclusão é "NOT_VIABLE" e as demais pendências estão resolvidas
    When "Ana" clicar em "Concluir ETP" sem reconhecer o aviso
    Then a API deve responder 422 com código "WARNINGS_NOT_ACKNOWLEDGED"

  Scenario: [Permissão] Usuário sem ETP_SUBMIT
    Given que "Bruno" possui apenas "PROCESS_VIEW"
    When "Bruno" abrir o ETP
    Then o botão "Concluir ETP" não deve ser exibido
    When "Bruno" enviar POST para finalizar o documento
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Finalizar documento de outro tenant
    Given que o ETP "0007/2026" pertence ao tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar POST para finalizar esse ETP
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Reenvio da finalização com a mesma chave de idempotência
    Given que "Ana" finalizou o ETP com a chave de idempotência "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo documento e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas uma versão criada

  Scenario: [Concorrência] Duas tentativas de concluir simultâneas
    Given que "Ana" e "Carlos" abriram o ETP na versão "4"
    When ambos enviarem a finalização com "If-Match" da versão "4" ao mesmo tempo
    Then apenas uma requisição deve responder 200
    And a outra deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante a finalização
    Given que o banco de dados fica indisponível durante a transação de finalização
    When "Ana" clicar em "Concluir ETP"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o ETP deve permanecer em "DRAFT" sem versão criada

  Scenario: [Falha de integração] Relay do outbox indisponível ao finalizar
    Given que o relay do outbox está indisponível
    When "Ana" concluir o ETP com sucesso
    Then a API deve responder 200 e o documento deve estar "FINALIZED"
    And o evento "DocumentFinalized" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Pendência bloqueante | 422 | `DOCUMENT_INCOMPLETE` | "Resolva as pendências destacadas para concluir." | Lista `violations[]` com links para as seções |
| Aviso não reconhecido | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que está ciente da conclusão pela não viabilidade." | Abre o diálogo de confirmação |
| Documento já concluído/cancelado | 409 | `DOCUMENT_NOT_EDITABLE` / `INVALID_STATE` | "Este ETP já foi concluído." | Mostra o status atual |
| `If-Match` ausente/divergente | 428/412 | `PRECONDITION_REQUIRED`/`VERSION_CONFLICT` | "Os dados foram alterados por outra pessoa." | Oferece "Recarregar" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir este ETP." | Botão oculto |
| Não visível/outro tenant | 404 | `NOT_FOUND` | — | Página 404 padrão |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o estado atual |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão para copiar o código |

## Dependências
- **Stories:** US-020 (seções e justificativas), US-021 (alternativa recomendada), US-022 (itens e valor estimado). Indiretas: US-065 (ciclo de vida e versionamento do documento), US-051/US-052 (aprovação formal posterior).
- **Decisões/ADRs:** DEC-016, DEC-017, DEC-018, DEC-056; POL-02, POL-09, POL-11.
- **Configurações:** nenhuma específica a este card — os requisitos de seção vêm da configuração semeada do template.
- **Lacunas nas fontes canônicas:** mesma lacuna de ação de auditoria da US-022 para as alterações de `conclusion`/`parcelingDecision` via `ETP-04`: não há ação específica no catálogo (events.md §7); usamos `document.draft_update` como conceito mais próximo. Os códigos `ETP_*` desta tabela são definidos por este card, conforme delegado em api.md §2.1.2 — não constituem lacuna.

## Impacto técnico
- Reaproveita a validação genérica de completude (`DocumentValidationService`, `DOC-08`) e o ciclo de finalização (`FinalizeDocumentHandler`, US-065), acrescentando um validador plugável específico do ETP.
- Nenhuma migração: usa campos já modelados (`conclusion`, `parcelingDecision`, `estimatedTotalValue`, alternativas, itens).
- A revalidação dentro da própria transação de finalização evita condição de corrida entre "consultar pendências" e "concluir" (FA-03).

## Backend
- **Módulo(s):** `etp` (validador específico); `document` (orquestração genérica de validação e finalização).
- **Casos de uso:** `UpdateEtpConclusionCommand` → `UpdateEtpConclusionHandler` (`ETP-04`); `ValidateDocumentCompletenessQuery` (genérico) + `EtpCompletenessValidator` (plugin); `FinalizeDocumentCommand` (genérico, US-065) → `FinalizeDocumentHandler`.
- **Domínio:** `Etp.assertCompletable()` aplicando RN-ETP-34..36; `Document.finalize()` (DEC-018).
- **Transação:** passo 7 do fluxo principal, transação única com `app.tenant_id`: revalidação, mudança de status, criação de versão, auditoria, outbox.

## Frontend
- **Tela(s):** SCR-008 (`/processos/[id]/etp/[etpId]`).
- **Componentes:** `CompletenessPanel` (lista de pendências com link para a seção), `ConclusionFieldset` (conclusão + parcelamento), `AcknowledgeWarningDialog`, `FinalizeButton` (com confirmação).
- **Estados:** botão desabilitado com contagem de pendências; carregando durante a finalização; sucesso com próximo passo; erro com pendências atualizadas.
- **Acessibilidade e responsividade:** lista de pendências navegável por teclado, cada item focável e com link; diálogo de aviso com foco preso (focus trap) e `aria-live`.

## Banco de dados
- **Tabelas:** `documents` (status, `finalizedAt/finalizedById`), `document_versions` (insert), `etps` (leitura/escrita de conclusão e parcelamento), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, version_number)` em `document_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ETP-03 | GET | `/etps/{id}` | — | `200 { data: Etp }` com `conclusion`, `parcelingDecision` | 200, 403, 404 |
| ETP-04 | PATCH | `/etps/{id}` | `{ conclusion?, parcelingDecision? }` + `If-Match` | `200 { data: Etp }` | 200, 403, 409, 412, 422 |
| DOC-08 | GET | `/documents/{id}/validation` | — | `200 { data: { violations: Violation[] } }` | 200, 403 |
| DOC-10 | POST | `/documents/{id}/finalize` | `{ acknowledgedWarnings?: string[] }` + `If-Match` + `Idempotency-Key` | `200 { data: Document }` com `status: "FINALIZED"`, `currentVersionId` | 200, 403, 409, 412, 422 |

## Logs
- `info` `document.finalized` — `documentId`, `documentVersionId`, `durationMs`.
- `warn` `document.finalize_warning_pending` — tentativa de concluir sem reconhecer aviso.
- `error` `document.finalize_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções, valores estimados, memórias de cálculo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.draft_update` | `DATA_CHANGE` | Definir `conclusion`/`parcelingDecision` | `metadata`: valores anteriores e novos |
| `document.finalize` | `DATA_CHANGE` | Commit da finalização | `metadata`: `fromStatus`, `versionNumber`, `acknowledgedWarnings` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = ETP_SUBMIT` |

## Testes necessários
- **Unitários:** `Etp.assertCompletable` (RN-ETP-34..36) cobrindo `VIABLE`/`NOT_VIABLE`/`PENDING`.
- **Integração (Testcontainers):** revalidação atômica (pendência surgida entre consulta e clique); criação de `DocumentVersion` com `contentHash` correto.
- **API/contrato:** `DOC-08`/`DOC-10`/`ETP-04` conforme api.md; formato de `violations[]`.
- **RBAC e multi-tenant:** `ETP_SUBMIT` com e sem custódia; processo de outro tenant → 404.
- **Concorrência:** duas tentativas de finalizar simultâneas com o mesmo `If-Match` → uma 200, outra `VERSION_CONFLICT`.
- **E2E (Playwright):** jornada completa de resolver pendências e concluir, incluindo `NOT_VIABLE` com reconhecimento do aviso.
- **Acessibilidade/performance:** axe no painel de pendências e no diálogo de aviso.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ETP_UPDATE`/`ETP_SUBMIT` e POL-02/POL-09 aplicados na API; UI oculta ação sem permissão
- [ ] Auditoria `document.finalize` e eventos `DocumentFinalized`/`DocumentVersionCreated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de DOC-08/DOC-10/ETP-04 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita os mecanismos genéricos de validação e finalização de documento (US-065); a complexidade está nas regras específicas do ETP e na revalidação atômica.

## Prioridade
**P0** — sem a conclusão do ETP a fase preparatória não avança para a aprovação formal nem para o TR (US-036/US-037).
