---
id: US-074
title: "Selagem de integridade da trilha de auditoria"
epic: EP-013
feature: FT-044
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-073, US-083]
modules: [audit]
screens: [SCR-037]
endpoints: [AUD-04, AUD-05]
permissions: [AUDIT_VIEW]
events: []
---

# US-074 — Selagem de integridade da trilha de auditoria

## Título
Selar a integridade da trilha de auditoria

## Descrição
**Como** responsável por conformidade e segurança do órgão (auditor ou administrador), **quero** que a trilha de auditoria seja periodicamente "selada" com um encadeamento criptográfico verificável, **para** ter certeza de que nenhum registro foi alterado, apagado ou inserido fora de ordem desde a selagem — mesmo que alguém obtivesse acesso direto ao banco de dados.

Um job agendado (horário) cria, por tenant, um `AuditSeal` que resume os `AuditLog` do período em um `digest` e encadeia esse `digest` ao selo anterior em um `chainHash` (estilo blockchain simplificado). A tela de Auditoria (SCR-037) lista os selos e permite verificar a integridade de um intervalo sob demanda.

## Contexto
- `AuditLog` é imutável por trigger de banco, mas isso não provaria, por si só, que nenhuma linha foi apagada ou inserida fora de ordem por alguém com acesso privilegiado ao banco. A selagem fecha essa lacuna: qualquer alteração após o selo quebra o `digest` recalculado; qualquer remoção de um selo inteiro quebra o `chainHash` do selo seguinte.
- `AuditSeal` (`audit_seals`, entities.md §4) é imutável e guarda `periodStart`/`periodEnd`, `firstAuditId`/`lastAuditId`, `recordCount`, `digest` (SHA-256 sobre os `rowHash` ordenados do período), `previousSealId`, `chainHash` (SHA-256 do `chainHash` anterior concatenado ao `digest`). DEC-084 define o padrão de snapshot/hash (JSON canonicalizado, SHA-256) reaproveitado aqui.
- Depende de US-073 (a trilha a selar já existe e tem `rowHash` por linha) e de US-083 (worker com filas, retries e dead letter — mecanismo que executa o job horário).

## Objetivo
100% dos períodos horários com atividade recebem exatamente um `AuditSeal` por tenant em até 5 minutos após o fechamento da hora, formando uma cadeia verificável desde o primeiro selo do tenant; qualquer adulteração de uma linha ou remoção de um selo é detectável por `AUD-05` em um único request.

## Persona
- **Principal:** Job agendado de selagem (`ActorType = SYSTEM`), executado pelo worker de filas (US-083).
- **Secundárias:** Auditor / administrador do órgão (perfil `AUDITOR` ou `ADMIN_ORGAO`), que consulta selos (`AUD-04`) e dispara verificações (`AUD-05`) na tela SCR-037.

## Pré-condições
- Existem `AuditLog` gravados pelo `AuditService` (US-073) no período a selar.
- O worker de filas e o agendador (US-083) estão operacionais.
- Para consulta/verificação: usuário autenticado com `AUDIT_VIEW` no tenant.

## Fluxo principal
1. A cada hora cheia, o agendador enfileira um job `audit-seal` por tenant ativo com atividade de auditoria na hora anterior.
2. O worker processa o job: define `periodStart`/`periodEnd` como a hora cheia anterior (ex.: `14:00:00`–`14:59:59.999` UTC) no tenant.
3. Busca o `AuditSeal` mais recente do tenant (`previousSealId`, `chainHash` anterior); se não existir nenhum, usa uma constante fixa (64 zeros) como "`chainHash` anterior".
4. Lê os `rowHash` de todos os `AuditLog` do tenant no período, ordenados por `(occurredAt, id)`.
5. Se não houver nenhum registro no período, o job termina sem criar `AuditSeal` (RN-AUD-12) — sem reagendar.
6. Caso haja registros: calcula `digest` = SHA-256 da concatenação ordenada dos `rowHash`; calcula `chainHash` = SHA-256(`chainHash` anterior ∥ `digest`); grava `AuditSeal` (`firstAuditId`, `lastAuditId`, `recordCount`, `digest`, `previousSealId`, `chainHash`, `sealedAt = now()`).
7. O próprio ato de selar é registrado como `AuditLog` `audit.seal` (`category = SYSTEM`, `actorType = SYSTEM`) — gravado no período **seguinte** ao selado (RN-AUD-14), nunca no período que acabou de ser selado.
8. Um auditor acessa SCR-037 e abre a aba "Selos"; o front chama `AUD-04` e lista os selos do tenant com período, quantidade de registros e status (íntegro/não verificado).
9. O auditor seleciona um intervalo de selos e clica em "Verificar integridade"; o front chama `AUD-05` com `periodStart`/`periodEnd`.
10. A API recalcula `digest` e `chainHash` de cada selo do intervalo a partir dos `AuditLog` atuais e compara com os valores armazenados; responde com o resultado por selo (`VALID`/`INVALID`) e, em caso de `INVALID`, o primeiro ponto de quebra.

## Fluxos alternativos
- **FA-01 — Job falha e é reprocessado:** falha transitória (ex.: banco momentaneamente indisponível) aciona retry do worker (US-083, backoff exponencial); após esgotar as tentativas, o job vai para a dead letter queue e é registrado `error` `audit.seal_failed` com alerta. Nenhum período se perde: cada execução sela, **em ordem**, toda hora fechada com atividade posterior ao último selo do tenant (até 168 por execução), então a hora que falhou é selada na execução seguinte, antes das mais novas.
- **FA-02 — Reexecução do mesmo período (idempotência):** se o job for reexecutado para um `periodStart` já selado (`unique (tenant_id, period_start)`), a tentativa de inserir é descartada sem erro visível ao operador (RN-AUD-13).
- **FA-03 — Lacuna de período sem atividade:** um tenant sem nenhum `AuditLog` por várias horas não gera selos vazios; quando a atividade retomar, o próximo selo referencia normalmente o `chainHash` do último selo existente, preservando a cadeia (RN-AUD-12).
- **FA-04 — Verificação de intervalo muito longo:** `AUD-05` limita o intervalo verificável por request (`audit.sealVerification.maxPeriods`, padrão 720 selos ≈ 30 dias); acima disso, a API responde `422` pedindo um intervalo menor.

## Regras de negócio
- **RN-AUD-11** — A cada hora, para cada tenant com ao menos um `AuditLog` não selado no período, o worker cria um `AuditSeal` com `periodStart`/`periodEnd` = hora cheia anterior, `firstAuditId`/`lastAuditId` = primeiro/último `AuditLog.id` do período (ordenados por `occurredAt, id`), `recordCount`, `digest` = SHA-256 dos `rowHash` ordenados concatenados, `chainHash` = SHA-256(`chainHash` do `AuditSeal` anterior do mesmo tenant ∥ `digest`); o primeiro selo do tenant usa uma constante (64 zeros) no lugar do `chainHash` anterior.
- **RN-AUD-12** — Períodos sem nenhum `AuditLog` não geram `AuditSeal` (sem registro vazio); o próximo selo não vazio referencia o `chainHash` do último selo existente, preservando a continuidade da cadeia mesmo com lacunas. Registros `audit.seal` sozinhos não contam como atividade (senão cada selo geraria o seguinte para sempre); quando o período tem outra atividade, eles entram no `digest` como qualquer registro. *(esclarecido na implementação, 2026-10-16)*
- **RN-AUD-13** — A selagem de um tenant é idempotente por `periodStart` (`unique (tenant_id, period_start)`); reexecutar o job para o mesmo período é no-op silencioso, sem duplicar nem falhar visivelmente.
- **RN-AUD-14** — A ação `audit.seal` é registrada no `AuditLog` do período **seguinte** ao selado, nunca no período que está sendo selado (evita mover o próprio alvo do hash depois de calculado).
- **RN-AUD-15** — `AUD-05` recalcula, para cada selo do intervalo pedido, o `digest` a partir dos `rowHash` atuais dos `AuditLog` do período e o `chainHash` a partir do `chainHash` do selo anterior e do `digest` recalculado; qualquer divergência marca o selo como `INVALID` e identifica se a quebra é em `digest` (linha alterada/removida/inserida no período) ou em `chainHash` (selo anterior alterado ou ausente).
- **RN-AUD-16** — A verificação de um intervalo é feita selo a selo, em ordem; a primeira quebra encontrada é reportada como `brokenAtPeriodStart`; selos posteriores ao ponto de quebra ainda são avaliados individualmente (cada um pode estar correto isoladamente, mas a cadeia como um todo é considerada comprometida a partir da primeira quebra).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Período | `periodStart`, `periodEnd` | timestamptz | Sim | hora cheia | calculado pelo job |
| Registros no período | `recordCount` | int | Sim | ≥ 1 (RN-AUD-12) | calculado |
| Primeiro/último registro | `firstAuditId`, `lastAuditId` | uuid | Sim | — | calculado |
| Resumo do período | `digest` | varchar(64) | Sim | RN-AUD-11 | calculado |
| Selo anterior | `previousSealId` | uuid | Não (nulo no 1º selo) | — | calculado |
| Encadeamento | `chainHash` | varchar(64) | Sim | RN-AUD-11 | calculado |
| Selado em | `sealedAt` | timestamptz | Sim | — | `now()` |
| *(consulta)* Intervalo a verificar | `periodStart`, `periodEnd` (request de `AUD-05`) | timestamptz | Sim | ≤ `audit.sealVerification.maxPeriods` | informado pelo auditor |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Intervalo de verificação além do limite de selos | API | "Reduza o intervalo para verificar a integridade (máximo de {N} selos)." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `periodEnd` anterior a `periodStart` | Front + API | "O período final deve ser posterior ao inicial." | `VALIDATION_ERROR` |
| V-03 | Reexecução do job para período já selado | Backend (worker) | — (não visível ao usuário; no-op) | — |
| V-04 | Selo referenciado em `AUD-05` de outro tenant | API | "Selo não encontrado." | `NOT_FOUND` |

## Permissões
- **Permissão:** `AUDIT_VIEW` (risco `H`, sem escopo de unidade) para `AUD-04` e `AUD-05`.
- **Políticas:** `POL-14` (MFA) — `AUDIT_VIEW` é risco `H`; com `security.mfaPolicy` em `ADMINS` (perfil com alguma permissão `H`) ou `ALL`, exige sessão com MFA ativo.
- **MFA:** exigido conforme `POL-14`/`security.mfaPolicy`; sem MFA válido → `403 MFA_REQUIRED` (dispara step-up no BFF).
- **Sem permissão:** a aba "Selos" não é exibida em SCR-037; a API responde `403 PERMISSION_DENIED` e registra `access.denied`. O job de selagem em si não exige permissão (ator `SYSTEM`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio publicado. A selagem é observável via `AuditLog` `audit.seal`, via `AUD-04` e via métricas/logs (ver Impacto técnico). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma nesta story (ver lacuna em Dependências — alerta de quebra de integridade tratado só por log/métrica no MVP 1). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Selagem de integridade da trilha de auditoria

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Clara" possui o perfil "AUDITOR" com a permissão "AUDIT_VIEW"

  Scenario: [Sucesso] Selagem horária encadeada
    Given que existem 10 "AuditLog" do tenant entre 14:00 e 14:59 e um "AuditSeal" anterior com "chainHash" "H0"
    When o job de selagem horária processar o período 14:00–14:59
    Then deve ser criado um "AuditSeal" com "recordCount" igual a 10
    And o "digest" deve ser o SHA-256 dos "rowHash" ordenados do período
    And o "chainHash" deve ser SHA-256 de "H0" concatenado ao novo "digest"
    And deve existir um "AuditLog" "audit.seal" registrado no período seguinte

  Scenario: [Validação] Intervalo de verificação maior que o permitido
    When "Clara" solicitar a verificação de um intervalo de 1.000 selos
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And a mensagem deve pedir a redução do intervalo

  Scenario: [Permissão] Usuário sem AUDIT_VIEW não acessa os selos
    Given que "Bruno" não possui a permissão "AUDIT_VIEW"
    When "Bruno" enviar GET para "/api/v1/audit/seals"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" igual a "AUDIT_VIEW"

  Scenario: [Tenant incorreto] Selo de outro tenant não é acessível
    Given que existe um "AuditSeal" do tenant "Prefeitura B"
    When "Clara", no tenant "Prefeitura de São José", solicitar a verificação desse selo
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Reexecução do job para o mesmo período
    Given que o período 14:00–14:59 do tenant já foi selado
    When o job de selagem for reexecutado para o mesmo período
    Then nenhum "AuditSeal" duplicado deve ser criado
    And a cadeia deve permanecer com um único selo para aquele período

  Scenario: [Concorrência] Dois workers processam o mesmo período simultaneamente
    Given que dois processos do worker disparam a selagem do mesmo período ao mesmo tempo
    When ambos tentarem inserir o "AuditSeal"
    Then apenas um deve ser persistido (restrição "unique (tenant_id, period_start)")
    And o outro deve finalizar sem erro visível ao operador

  Scenario: [Falha de banco] Banco indisponível durante a selagem
    Given que o banco de dados fica indisponível durante o job de selagem
    When o worker tentar gravar o "AuditSeal"
    Then o job deve ser reencaminhado para nova tentativa (retry)
    And nenhum selo parcial deve ser persistido

  Scenario: [Falha de integração] Esgotamento de tentativas envia para a dead letter queue
    Given que o job de selagem falhou nas 3 tentativas configuradas
    When a última tentativa falhar
    Then o job deve ser movido para a dead letter queue
    And deve ser registrado log "error" "audit.seal_failed" com alerta correspondente

  Scenario: [Sucesso] Verificação detecta quebra de integridade
    Given que um "AuditLog" do período 10:00–10:59 foi alterado diretamente no banco após a selagem
    When "Clara" verificar a integridade do intervalo que inclui esse período
    Then o resultado deve indicar "INVALID" para o selo de 10:00–10:59
    And deve indicar que a quebra está no "digest" desse período
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Intervalo de verificação muito longo | 422 | `VALIDATION_ERROR` | "Reduza o intervalo para verificar a integridade (máximo de {N} selos)." | Ajusta seletor de datas |
| Selo inexistente/outro tenant | 404 | `NOT_FOUND` | "Selo não encontrado." | Retorna à lista de selos |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para consultar a auditoria." | Aba "Selos" oculta |
| MFA ausente | 403 | `MFA_REQUIRED` | "Esta ação exige verificação adicional (MFA)." | Dispara step-up |
| Banco indisponível na verificação | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível verificar a integridade agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe correlationId |
| Job de selagem esgota tentativas | — | — | — (operação de backend; sem tela própria) | Alerta operacional, não exibido ao usuário final |

## Dependências
- **Stories:** US-073 (trilha e `rowHash` por linha a selar), US-083 (worker com filas, retries e dead letter — executa o job horário e trata falhas).
- **Decisões/ADRs:** DEC-084, DEC-161; ADR-006.
- **Configurações:** `audit.sealVerification.maxPeriods` (plataforma — variável de ambiente; padrão 720).
- **Lacunas nas fontes canônicas:** não há `NotificationType` (events.md §6) para alertar sobre quebra de integridade detectada em `AUD-05` ou sobre esgotamento de tentativas do job de selagem (confirmado por busca em events.md — apenas o catálogo de ações de auditoria §7 cita `audit.seal`, sem entrada correspondente em §6). Adotamos como solução provisória log `error` + métrica/alerta operacional; propomos criar, em story futura, um novo `NotificationType` dedicado a essa quebra de integridade, com canais `IN_APP`/`EMAIL` para destinatários com `AUDIT_VIEW` de risco `H` (nome final a definir pelo time de produto).

## Impacto técnico
- Depende de um agendador confiável (cron do worker — US-083); atraso ou falha sistemática do agendador é uma falha silenciosa de conformidade — por isso a métrica de "selos pendentes por tenant" deve ter alerta.
- O cálculo de `digest`/`chainHash` lê todos os `rowHash` do período; para tenants de alto volume, a leitura deve usar o índice `(tenant_id, occurred_at DESC)` e permanecer dentro do SLA de 5 minutos após o fechamento da hora.
- `AUD-05` recalculando selos sob demanda tem custo proporcional ao número de registros no intervalo; o limite de `audit.sealVerification.maxPeriods` protege a API de verificações excessivamente longas.
- A cadeia (`chainHash`) é por tenant; não há verificação cruzada entre tenants nem selo "global" da plataforma no MVP 1.

## Backend
- **Módulo(s):** `audit` (dono); usa a fachada de `platform` (worker/fila de US-083).
- **Casos de uso:** `SealAuditPeriodJob` (worker, disparado pelo agendador); `GetAuditSealsQuery` → `GetAuditSealsHandler` (`AUD-04`); `VerifyAuditSealsCommand` → `VerifyAuditSealsHandler` (`AUD-05`, somente leitura/cálculo — não grava nada).
- **Domínio:** `AuditSeal.create(period, previousSeal, rowHashes)` (fábrica que aplica RN-AUD-11/12); `SealChainVerifier` (RN-AUD-15/16).
- **Transação:** a criação do selo (passo 6 do fluxo principal) e o registro de `audit.seal` (passo 7) ocorrem na **mesma** transação, como manda RN-AUD-01/DEC-161 — o `audit.seal` leva `occurredAt = now()`, já no período seguinte ao selado, então não altera o `digest` calculado; falhou um, falham os dois. Uma transação por período selado, sob trava consultiva por tenant (cadeia sequencial). *(ajustado na implementação, 2026-10-16: a redação anterior pedia transações distintas, o que deixaria selo sem auditoria numa falha entre as duas)*
- **Agendamento:** cron horário (ex.: `5 * * * *`, 5 min de margem) enfileira um job por tenant ativo; retries com backoff exponencial e dead letter queue (US-083).

## Frontend
- **Tela(s):** SCR-037 (`/auditoria`), aba "Selos".
- **Componentes:** `SealList` (período, quantidade de registros, status), `SealVerificationPanel` (seletor de intervalo + botão "Verificar integridade"), `SealVerificationResult` (lista por selo com ícone íntegro/quebrado e detalhe da quebra).
- **Estados:** skeleton ao carregar selos; vazio ("Nenhum selo gerado ainda para este período"); erro de carregamento com "Tentar novamente"; resultado de verificação com estado de carregamento próprio (pode levar alguns segundos em intervalos longos).
- **Acessibilidade e responsividade:** status íntegro/quebrado comunicado também por texto (não só cor/ícone); tabela de selos com rolagem horizontal em telas estreitas; foco movido ao resultado da verificação ao concluir.

## Banco de dados
- **Tabelas:** `audit_seals` (criada por esta story, conforme entities.md §4: imutável, `unique (tenant_id, period_start)`).
- **Migrações:** criação de `audit_seals` com trigger de bloqueio de `UPDATE`/`DELETE`; FK simples para `audit_seals.previous_seal_id` (mesma tabela).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, period_start)`; índice `(tenant_id, period_start DESC)` para listagem e para localizar o selo anterior.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| AUD-04 | GET | `/api/v1/audit/seals` | `?periodFrom&periodTo&page&pageSize` | `200 { data: [{ id, periodStart, periodEnd, recordCount, digest, chainHash, sealedAt }], meta }` | 200, 401, 403, 429 |
| AUD-05 | POST | `/api/v1/audit/seals/verify` | `{ periodStart, periodEnd }` | `200 { data: { brokenAtPeriodStart, results: [{ periodStart, status: "VALID"\|"INVALID", brokenAt?: "digest"\|"chain" }] } }` | 200, 403, 404, 422, 503 |

## Logs
- `info` `audit.seal_created` — `tenantId`, `periodStart`, `recordCount`, `durationMs`.
- `info` `audit.seal_skipped_empty` — período sem atividade (RN-AUD-12).
- `warn` `audit.seal_retry` — tentativa de retry do worker, com número da tentativa.
- `error` `audit.seal_failed` — esgotamento de tentativas, job movido para dead letter queue.
- `warn` `audit.seal_verification_broken` — verificação (`AUD-05`) encontrou selo `INVALID`; inclui `periodStart` e tipo de quebra.
- **Nunca logar:** conteúdo de `changes` dos `AuditLog` subjacentes.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `audit.seal` | `SYSTEM` | Selagem concluída (registrado no período seguinte — RN-AUD-14) | `metadata`: `periodStart`, `periodEnd`, `recordCount`, `digest` |
| `audit.search` *(reaproveitado)* | `ACCESS` | Consulta de selos via `AUD-04` | `metadata`: filtros de período |

## Testes necessários
- **Unitários:** `AuditSeal.create` (digest/chainHash determinísticos); `SealChainVerifier` (detecção de quebra em digest vs. chain); comportamento com período vazio (RN-AUD-12).
- **Integração (Testcontainers PostgreSQL + Redis/BullMQ):** job horário fim a fim; idempotência por `periodStart`; retries e dead letter queue; leitura de `rowHash` por partição.
- **Concorrência:** dois workers processando o mesmo período → um selo único, sem erro visível.
- **API/contrato:** `AUD-04`/`AUD-05` conforme api.md (paginação, erros); limite de `maxPeriods` em `AUD-05`.
- **RBAC e multi-tenant:** `AUDIT_VIEW` e `POL-14` (MFA) aplicados; selo de outro tenant → 404; isolamento na suíte "tenant leak".
- **E2E (Playwright):** jornada "ver selos → verificar intervalo → ver resultado íntegro"; jornada com dado alterado manualmente no banco de teste → resultado `INVALID` visível.
- **Acessibilidade/performance:** axe na aba "Selos"; job horário completa em até 5 min para tenant com 100k registros/hora (meta inicial).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (worker + API + E2E) e passando no CI
- [ ] `AUDIT_VIEW` e `POL-14` (MFA) aplicados em `AUD-04`/`AUD-05`
- [ ] Idempotência do job por `periodStart` comprovada por teste de concorrência
- [ ] Verificação detecta corretamente quebra em `digest` e em `chainHash` (casos distintos testados)
- [ ] Retry e dead letter queue do job verificados
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `AUD-04`/`AUD-05` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de selos pendentes/atrasados com alerta configurado
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — lógica de encadeamento criptográfico e verificação bem delimitada, reaproveitando a trilha e a infraestrutura de filas já existentes; sem wizard nem fluxo de usuário complexo.

## Prioridade
**P1** — fortalece a evidência de conformidade (prova de não adulteração), mas o produto já registra e consulta auditoria (US-073/US-075) sem selagem; pode seguir imediatamente após o P0 do épico.
