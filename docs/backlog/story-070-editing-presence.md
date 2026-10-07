---
id: US-070
title: "Indicador de edição concorrente"
epic: EP-011
feature: FT-042
mvp: 1
priority: P2
estimate: M
status: Especificada
depends_on: [US-015]
modules: [document]
screens: [SCR-105]
endpoints: [DOC-24, DOC-25, DOC-05]
permissions: [DOCUMENT_UPDATE]
events: []
---

# US-070 — Indicador de edição concorrente

## Título
Indicador de edição concorrente

## Descrição
**Como** redator de um documento livre ou estruturado, **quero** ver quem mais está editando o mesmo documento (e em qual seção) enquanto eu trabalho nele, **para** evitar digitar em paralelo com um colega e perder tempo resolvendo um conflito de revisão que poderia ter sido evitado.

O editor de seções (US-015) já impede a perda silenciosa de conteúdo por meio da revisão por seção (`SECTION_REVISION_CONFLICT`, DEC-055). Esta story adiciona apenas o **aviso prévio**: um indicador de presença ("Fulano está editando esta seção") alimentado por heartbeats do navegador e armazenado de forma efêmera no Redis (chave com TTL — DEC-055).

## Contexto
Em documentos elaborados por várias pessoas (ex.: ETP com seções divididas entre a área técnica e o planejamento), é comum duas pessoas abrirem o mesmo documento ao mesmo tempo. O risco de conflito de autosave está registrado em RT-04 (risks-and-decisions.md) e mitigado, no MVP 1, apenas por revisão por seção + diálogo de conflito + este indicador de presença — a edição colaborativa em tempo real (fusão automática de edições simultâneas) está **explicitamente fora do MVP 1** (PEND-12, DT-11). Esta story é P2: entrega valor de UX, não é pré-requisito de nenhuma outra.

## Objetivo
Reduzir conflitos de revisão de seção percebidos pelo usuário como "surpresa": quando duas pessoas têm o editor do mesmo documento aberto, cada uma vê a outra em até 20 s (um ciclo de heartbeat), sem nenhuma chamada adicional além do próprio heartbeat.

## Persona
- **Principal:** redator de documento `FREE_TEXT`/`STRUCTURED` com o editor de seções aberto (US-015).
- **Secundárias:** nenhuma — quem só visualiza (sem permissão de edição) não participa do indicador.

## Pré-condições
- Documento do tipo `FREE_TEXT` ou `STRUCTURED` (com seções); documentos `UPLOADED` não se aplicam (sem seções).
- Usuário tem a permissão de edição do tipo (`DOCUMENT_UPDATE` para `FREE_TEXT`; permissão do módulo tipado para `STRUCTURED`) + POL-02 (documento `DRAFT`/`RETURNED`, tipo permitido na etapa atual).

## Fluxo principal
1. O usuário abre o editor de uma seção do documento (SCR-105).
2. O front envia um heartbeat (`PUT /documents/{id}/presence` com `sectionKey`) a cada 20 s enquanto o editor estiver em foco.
3. A API confirma a permissão de edição (igual à de `DOC-05`), grava/renova no Redis a presença do usuário para aquele documento com TTL de 60 s e devolve a lista de outros editores ativos (excluindo o próprio chamador).
4. O front exibe um indicador discreto (avatar + nome + seção) para cada editor retornado, destacando quando alguém está na **mesma** seção que o usuário atual.
5. Ao trocar de seção, o próximo heartbeat já envia o novo `sectionKey`, atualizando a presença.
6. Ao fechar o editor ou sair da tela, o front envia `DELETE /documents/{id}/presence` (melhor esforço); se isso não ocorrer (aba fechada abruptamente), a presença expira sozinha em até 60 s por falta de heartbeat.

## Fluxos alternativos
- **FA-01 — Vários editores na mesma seção:** o indicador reforça o aviso (ex.: "2 pessoas editando esta seção agora") para destacar o maior risco de conflito.
- **FA-02 — Usuário só visualizando:** sem permissão de edição, o front não envia heartbeat e não aparece no indicador dos demais; ainda assim pode ver quem está editando, pois a resposta do heartbeat de quem edita inclui todos os editores ativos.
- **FA-03 — Redis indisponível:** o indicador simplesmente não aparece; a edição (autosave, submissão, finalização) continua funcionando normalmente (RN-DOC-92).

## Regras de negócio
- **RN-DOC-87** — Aplica-se a documentos com seções editáveis por autosave (`FREE_TEXT` e `STRUCTURED`, mecanismo de `DOC-05`/US-015); documentos `UPLOADED` não participam (sem seções).
- **RN-DOC-88** — Heartbeat (`PUT .../presence`): o cliente envia a cada 20 s enquanto o editor estiver em foco; a API exige a mesma permissão de edição do tipo + POL-02 de `DOC-05` (sem `If-Match`, pois não altera o recurso); grava a presença em chave Redis `presence:{tenantId}:document:{documentId}:{userId}` com TTL de 60 s e o `sectionKey` informado.
- **RN-DOC-89** — Expiração: sem heartbeat por 60 s (três ciclos perdidos), a presença expira automaticamente pelo TTL do Redis; não há obrigatoriedade de uma saída explícita, mas o front envia `DELETE` ao fechar o editor para expirar mais rápido (FA de melhor esforço, ex.: `navigator.sendBeacon`).
- **RN-DOC-90** — A resposta do heartbeat (e nenhuma outra chamada) devolve os demais usuários com presença ativa no documento (`userId`, nome, `sectionKey`, `since`), sempre excluindo o próprio chamador; usuário sem heartbeat nos últimos 60 s nunca aparece.
- **RN-DOC-91** — Isolamento por tenant: a chave Redis é prefixada por `tenantId`; documento não visível ao usuário (DEC-024) responde 404 e nunca aceita heartbeat.
- **RN-DOC-92** — Falha aberta (*fail-open*): indisponibilidade do Redis não bloqueia a leitura, a edição, o autosave, a submissão ou a finalização do documento; o heartbeat responde 200 com `editors: []` e grava log `warn` (consistente com architecture.md: Redis principal "não crítico para leitura/escrita síncrona").
- **RN-DOC-93** — Presença é efêmera: não cria `DocumentVersion`, não gera evento de domínio e não grava registro de auditoria (heartbeats a cada 20 s tornariam a trilha de auditoria ruidosa sem valor de rastreabilidade).
- **RN-DOC-94** — O indicador é apenas informativo: a prevenção real de conflito continua sendo a revisão por seção (`SECTION_REVISION_CONFLICT`, DEC-055/US-015) — ver outro editor na mesma seção não impede salvar, podendo ainda colidir na revisão.

## Campos
| Campo (UI/API) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Seção em edição | `sectionKey` | string | Não | deve existir no template da versão atual | seção em foco no editor |
| *(sistema)* Lista de editores | `editors[].userId/name/sectionKey/since` | array | — | exclui o próprio chamador | calculado (Redis) |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `sectionKey` informado não existe no template da versão | API | (silenciosa — heartbeat ignora o campo e mantém o anterior) | `SECTION_NOT_IN_TEMPLATE` |
| V-02 | Documento `UPLOADED` ou sem seções | API | — (botão/indicador nem aparece na UI) | `NOT_ALLOWED` |

## Permissões
- **Permissão:** a mesma exigida para editar o tipo do documento (`DOCUMENT_UPDATE` para `FREE_TEXT`; permissão do módulo tipado para `STRUCTURED`) + POL-02.
- **Políticas:** POL-02 (edição de documento) — sem custódia/participação ou fora de `DRAFT`/`RETURNED`, o heartbeat responde `409 DOCUMENT_NOT_EDITABLE`.
- **MFA:** não exigido.
- **Sem permissão:** o front não envia heartbeat; quem só visualiza não aparece como editor, mas continua recebendo a lista de quem edita (via heartbeat de terceiros) quando ele próprio tiver permissão de leitura do documento.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio nem auditoria (RN-DOC-93); dado puramente efêmero em Redis |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma |

## Critérios de aceite em Gherkin
```gherkin
Feature: Indicador de edição concorrente

  Background:
    Given que o documento "ETP 0003/2026" está em "DRAFT" com seções editáveis
    And "Ana" e "Bruno" têm permissão de edição sobre esse documento

  Scenario: [Sucesso] Ver outro editor na mesma seção
    Given que "Ana" está editando a seção "JUSTIFICATIVA" e envia heartbeat
    When "Bruno" abrir a mesma seção "JUSTIFICATIVA" e enviar heartbeat
    Then a resposta do heartbeat de "Bruno" deve incluir "Ana" com `sectionKey` "JUSTIFICATIVA"
    And a resposta do heartbeat de "Ana", no próximo ciclo, deve incluir "Bruno"

  Scenario: [Validação] `sectionKey` inexistente no template
    When "Ana" enviar heartbeat com `sectionKey` "SECAO_INEXISTENTE"
    Then a API deve responder 422 com código "SECTION_NOT_IN_TEMPLATE"
    And a presença de "Ana" deve manter o `sectionKey` anterior válido

  Scenario: [Permissão] Usuário sem permissão de edição
    Given que "Carla" só tem "PROCESS_VIEW" sobre o processo
    When "Carla" tentar enviar um heartbeat de presença
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    And "Carla" não deve aparecer na lista de editores de ninguém

  Scenario: [Tenant incorreto] Documento de outro tenant
    Given que o documento "ETP 0009/2025" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" enviar heartbeat para esse documento
    Then a API deve responder 404
    And nenhuma chave de presença deve ser criada para esse documento

  Scenario: [Duplicidade] Heartbeats repetidos do mesmo usuário
    Given que "Ana" já enviou um heartbeat para a seção "JUSTIFICATIVA" há 5 segundos
    When "Ana" enviar outro heartbeat para a mesma seção
    Then deve existir apenas uma entrada de presença para "Ana" no documento
    And o TTL da chave deve ser renovado para 60 segundos, sem erro

  Scenario: [Concorrência] Dois editores na mesma seção ao mesmo tempo
    Given que "Ana" e "Bruno" enviam heartbeat para a seção "JUSTIFICATIVA" no mesmo segundo
    When qualquer um dos dois consultar a presença
    Then ambos devem aparecer na lista um do outro
    And nenhuma race condition deve apagar a entrada do outro usuário

  Scenario: [Falha de banco] Redis indisponível
    Given que o Redis principal está indisponível
    When "Ana" enviar um heartbeat de presença
    Then a API deve responder 200 com `editors` vazio
    And deve ser registrado log "warn" "presence.store_unavailable"
    And o autosave da seção (US-015) deve continuar funcionando normalmente

  Scenario: [Falha de integração] Cliente perde conexão sem avisar
    Given que "Bruno" estava editando e a aba do navegador travou sem enviar o "DELETE" de saída
    When 60 segundos se passarem sem novo heartbeat de "Bruno"
    Then "Bruno" deve deixar de aparecer na lista de editores de "Ana"
    And nenhuma intervenção manual deve ser necessária
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `sectionKey` fora do template | 422 | `SECTION_NOT_IN_TEMPLATE` | (sem mensagem visível; heartbeat silencioso) | Mantém o `sectionKey` válido anterior |
| Documento não editável pelo usuário | 409 | `DOCUMENT_NOT_EDITABLE` | — (indicador simplesmente não é exibido/enviado) | Não envia heartbeat |
| Documento não visível/outro tenant | 404 | `NOT_FOUND` | — | Para o heartbeat silenciosamente |
| Redis indisponível | 200 (degradado) | — | — (indicador não aparece) | Oculta o indicador sem bloquear a edição |

## Dependências
- **Stories:** US-015 (mecanismo de autosave de seção e revisão por seção que este indicador complementa, sem substituir). Relacionada, não bloqueante: US-063 (documentos `FREE_TEXT` que usam `DOC-05`).
- **Decisões/ADRs:** DEC-024, DEC-055 (presença com chave Redis + TTL/heartbeat, já prevista nesta decisão), DEC-056; PEND-12 (edição colaborativa em tempo real — explicitamente fora de escopo), DT-11.
- **Configurações:** TTL (60 s) e intervalo de heartbeat (20 s) fixos por decisão (DEC-055), sem chave de tenant.
- **Lacunas nas fontes canônicas:** nenhuma (`DOC-24`/`DOC-25` registrados em api.md §3).

## Impacto técnico
Estrutura de dados sugerida em Redis: um `ZSET` por documento (`presence:{tenantId}:document:{documentId}`, score = epoch do último heartbeat) + um `HASH` auxiliar com `sectionKey` por usuário; leitura faz `ZREMRANGEBYSCORE` (poda quem passou de 60 s) antes de `ZRANGE`. Sem impacto em Postgres (nenhuma tabela nova) nem em `entities.md`. Reaproveita o Redis principal já usado para idempotência/filas/rate limit (architecture.md) — por decisão (RN-DOC-92), uma falha desse Redis nunca pode se propagar para a edição de documentos.

## Backend
- **Módulo(s):** `document` (dono, mesmo módulo de `DOC-05`); usa `access` (mesma checagem de POL-02 de `DOC-05`).
- **Casos de uso:** `RegisterDocumentPresenceCommand` (heartbeat), `RemoveDocumentPresenceCommand` (saída).
- **Domínio:** nenhuma entidade persistente; estado vive inteiramente no Redis, fora dos agregados do Prisma.
- **Integrações internas:** cliente Redis compartilhado (mesma conexão de idempotência/rate limit).
- **Transação:** nenhuma transação de banco; operação é uma chamada Redis best-effort, nunca bloqueante.

## Frontend
- **Tela(s):** SCR-105 (editor de documento livre/estruturado).
- **Componentes:** `PresenceIndicator` (lista de avatares por seção), hook `useDocumentPresence` (heartbeat a cada 20 s via `setInterval`, `sendBeacon` no `beforeunload`).
- **Estados:** indicador ausente (sem outros editores ou Redis indisponível); indicador com 1+ editores, destacando a seção atual do usuário.
- **Acessibilidade e responsividade:** indicador não bloqueia o teclado do editor; texto alternativo "Fulano está editando a seção X"; em telas pequenas, resume para um contador com tooltip.

## Banco de dados
- **Tabelas:** nenhuma (estado efêmero em Redis, fora do Postgres).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** não aplicável.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-24 | PUT | `/documents/{id}/presence` | `{ sectionKey? }` | `200 { data: { editors: [{ userId, name, sectionKey, since }] } }` | 200, 403, 404, 409, 422 |
| DOC-25 | DELETE | `/documents/{id}/presence` | — | `204` | 204, 404 |

## Logs
- `info` `presence.heartbeat` — amostragem baixa (não a cada heartbeat); `documentId`, `sectionKey`, `tenantId`.
- `warn` `presence.store_unavailable` — quando o Redis falhar (RN-DOC-92).
- **Nunca logar:** a cada heartbeat individual em nível `info` (volume alto, 1 a cada 20 s por editor ativo).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Nenhuma (RN-DOC-93) — presença é efêmera e não gera trilha de auditoria |

## Testes necessários
- **Unitários:** poda de presenças expiradas (`ZREMRANGEBYSCORE`); exclusão do próprio chamador da lista retornada.
- **Integração (Testcontainers Redis):** heartbeat renova TTL; expiração após 60 s sem heartbeat; Redis indisponível não derruba o autosave (US-015).
- **API/contrato:** respostas conforme proposta registrada nesta story (ver Lacunas).
- **RBAC e multi-tenant:** documento de outro tenant → 404; sem permissão de edição → 409.
- **Concorrência:** dois heartbeats simultâneos de usuários diferentes não se sobrescrevem.
- **E2E (Playwright):** duas sessões abrindo o mesmo documento veem uma à outra em até 20 s; ao fechar uma aba, a outra deixa de ver o editor em até 60 s.
- **Acessibilidade/performance:** heartbeat não degrada a digitação (chamada assíncrona, sem bloquear a UI); custo em Redis desprezível (chaves pequenas, TTL curto).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Permissão de edição do tipo + POL-02 aplicadas no heartbeat
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] Falha do Redis comprovadamente não bloqueia autosave/submissão/finalização (RN-DOC-92)
- [ ] Contrato de heartbeat/saída de presença (`DOC-24`/`DOC-25`) compatível com api.md
- [ ] Logs sem heartbeats individuais em volume; métricas de uso do indicador
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — não envolve Postgres, mas exige um mecanismo novo (Redis efêmero, heartbeat, expiração), integração no editor de seções existente (US-015) e garantias de *fail-open* cuidadosamente testadas.

## Prioridade
**P2** — melhoria de UX que reduz conflitos de edição; não bloqueia nenhuma outra story do MVP 1 (PEND-12/DT-11 confirmam que a edição colaborativa plena fica para depois).
