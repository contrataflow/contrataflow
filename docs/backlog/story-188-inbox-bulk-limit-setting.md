---
id: US-188
title: "Limite configurável do lote da caixa de tarefas (DT-16)"
epic: EP-029
feature: FT-085
mvp: 2
priority: P2
estimate: XS
status: Especificada
depends_on: [US-058, US-103]
modules: [tenancy, process, platform]
screens: [SCR-041, SCR-013]
endpoints: [SET-01, SET-02, SET-03, TSK-03, TSK-04]
permissions: [SETTINGS_MANAGE, PROCESS_CLAIM, PROCESS_ASSIGN]
events: [TenantSettingsChanged]
---

# US-188 — Limite configurável do lote da caixa de tarefas (DT-16)

## Título
Limite configurável do lote da caixa de tarefas

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`) com `SETTINGS_MANAGE`, **quero** ajustar quantos processos podem ser assumidos ou atribuídos de uma vez na caixa de tarefas, dentro de uma faixa que a plataforma permite, **para** que órgãos com muito volume trabalhem em lotes maiores e órgãos que preferem mais cautela os reduzam, sem depender de suporte nem de release.

No MVP 1 o lote era fixo, de 2 a 50 itens (RN-INBOX-19). Esta story cria a chave `inbox.bulkMaxItems` (padrão 50, piso 2, teto definido pela plataforma em `INBOX_BULK_MAX_ITEMS`, padrão 200) e faz `TSK-03` (assumir em lote) e `TSK-04` (atribuir em lote) lerem o limite do tenant. O mesmo limite já é citado pelos lotes do jurídico (LGL-04, RN-LGL-74) e do cockpit de ramos paralelos (US-125).

## Contexto
- DT-16 (DEC-209): "limite do lote da caixa de tarefas configurável por tenant (`inbox.bulkMaxItems`, faixa permitida pela plataforma)". No MVP 1 (US-058) o limite de 50 era fixo para equilibrar utilidade (mutirões) com tempo de resposta e o raio de impacto de um erro operacional.
- RN-PLAT-19 (FT-085): `inbox.bulkMaxItems` respeita o piso 2 e o teto `INBOX_BULK_MAX_ITEMS` definido pela plataforma; valor fora da faixa é recusado.
- US-103: as configurações do tenant são um registro tipado (`SET-01`/`SET-02`), com concorrência por chave (`expectedVersions`), auditoria `settings.update` e um evento `TenantSettingsChanged` por requisição; `SET-03` expõe chaves públicas a qualquer vínculo ativo.
- O lote processa cada item em transação própria, com resultado por item (RN-INBOX-22): subir o limite não muda as regras por item, só quantos itens entram numa requisição.
- Não existe código de erro específico de lote nas fontes do MVP 1: o limite excedido é `422 VALIDATION_ERROR` com `errors[].code = TOO_LONG` no campo da lista (`processIds`, ou `items` na variante da US-125).

## Objetivo
Permitir que o administrador mude o limite do lote em menos de 1 minuto, com 100% das requisições de lote validadas contra o limite efetivo do tenant (nunca acima do teto da plataforma) e a mudança valendo para os lotes seguintes em até 60 segundos.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, `SETTINGS_MANAGE`).
- **Secundárias:** Gestor de contratações e Compras (`GESTOR_CONTRATACOES`, `COMPRAS`), titulares de unidade e demais usuários da caixa de tarefas, que usam o lote ampliado ou reduzido.

## Pré-condições
- Para alterar: usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `SETTINGS_MANAGE` e, se `security.mfaPolicy` exigir, sessão com MFA (POL-14).
- Para usar o lote: `PROCESS_CLAIM` (`TSK-03`) ou `PROCESS_ASSIGN`/titular da unidade (`TSK-04`), como na US-058.
- A variável de ambiente `INBOX_BULK_MAX_ITEMS` é um inteiro ≥ 2 (a API recusa a subida com valor inválido).

## Fluxo principal
1. Em **Administração › Configurações** (SCR-041, `/admin/configuracoes`), grupo novo **"Caixa de tarefas"**, o administrador vê "Itens por lote" com o valor atual, a faixa permitida ("de 2 a {teto}") e o texto de apoio "Quantos processos podem ser assumidos ou atribuídos de uma vez."
2. Ele informa o novo valor (por exemplo, 100). Acima de 100, a tela mostra o aviso não bloqueante "Lotes grandes demoram mais para responder. O resultado continua sendo informado item a item."
3. O front valida o inteiro e a faixa e envia `PATCH /settings` (`SET-02`) com `{ values: { "inbox.bulkMaxItems": 100 }, expectedVersions: { "inbox.bulkMaxItems": 1 } }`.
4. A API, em uma transação: valida a chave e o valor (inteiro entre 2 e o teto da plataforma), confere a versão, grava a configuração, audita `settings.update` (valor anterior e novo) e publica `TenantSettingsChanged` com `keys = ["inbox.bulkMaxItems"]`.
5. A API responde `200` com o valor e a nova versão; o front mostra "Configurações salvas".
6. O `InboxBulkLimitProvider` invalida seu cache ao receber `TenantSettingsChanged`; no máximo 60 segundos depois (TTL de segurança) todas as réplicas usam o novo limite.
7. Na caixa de tarefas (SCR-013, US-058), a barra de lote lê o limite efetivo em `SET-03` e permite marcar até esse número de linhas: "{N} selecionados (máximo {limite})".
8. Ao enviar `TSK-03`/`TSK-04`, a API lê o limite efetivo **uma vez, no início da requisição**, e valida o tamanho da lista: de 2 até o limite; acima, `422`; o processamento por item segue como na US-058.

## Fluxos alternativos
- **FA-01 — Valor fora da faixa:** abaixo de 2 ou acima do teto da plataforma → `422 VALIDATION_ERROR` (`OUT_OF_RANGE`) com `params.min` e `params.max`; nada é gravado.
- **FA-02 — Valor não inteiro:** texto, decimal ou nulo → `422 VALIDATION_ERROR` (`INVALID_TYPE`); a UI só aceita inteiros.
- **FA-03 — Teto da plataforma reduzido abaixo do valor do tenant:** o valor gravado (por exemplo, 150) não é reescrito; o limite **efetivo** passa a ser o teto novo (por exemplo, 60). A tela mostra "O limite do órgão ({150}) está acima do teto da plataforma ({60}). Está valendo {60}." e o administrador pode salvar um valor dentro da faixa.
- **FA-04 — Limite reduzido com a seleção já feita:** a pessoa marcou 80 linhas com limite 100 e o administrador baixou para 20; o envio recebe `422 TOO_LONG` com `params.max = 20`, a UI atualiza o limite e pede para reduzir a seleção.
- **FA-05 — Lote em andamento:** a mudança do limite durante o processamento de um lote não o interrompe nem o altera (o limite é lido uma vez, no início).
- **FA-06 — Reenvio idempotente depois de o limite baixar:** repetir `TSK-03`/`TSK-04` com a mesma `Idempotency-Key` e o mesmo corpo devolve o resultado original (`Idempotent-Replayed: true`), sem revalidar o tamanho do lote contra o limite novo.
- **FA-07 — Chave sem linha no tenant:** vale o padrão 50 (RN-TEN-57), limitado ao teto da plataforma.
- **FA-08 — Redis ou relay indisponíveis:** a gravação vale e o limite novo pode demorar até 60 segundos para chegar a todas as réplicas (TTL do cache); sem cache, a API lê o valor do banco.
- **FA-09 — Lote de 1 item:** continua `422 TOO_SHORT`; o piso do lote é 2 e não é configurável.

## Regras de negócio
- **RN-PLAT-300** — Chave `inbox.bulkMaxItems` no registro de configurações (módulo `tenancy`/`process`): inteiro, padrão `50`, mínimo `2`, máximo = teto da plataforma; grupo "Caixa de tarefas" (`inbox.*`); não é leitura pública irrestrita, mas o **valor efetivo** é exposto em `SET-03` (RN-PLAT-303). É a mesma chave citada por LGL-04 (RN-LGL-74) e pela US-125.
- **RN-PLAT-301** — Teto da plataforma: variável de ambiente `INBOX_BULK_MAX_ITEMS` (inteiro, padrão `200`), lida no boot; valor inválido ou menor que 2 impede a subida. É de plataforma, não do tenant, e muda só com reinício controlado.
- **RN-PLAT-302** — Validação em `SET-02` (RN-PLAT-19): inteiro com `2 ≤ valor ≤ teto`; fora disso, `422 VALIDATION_ERROR` (`OUT_OF_RANGE`, com `params.min` e `params.max`) e o lote de chaves inteiro é recusado (tudo ou nada, RN-TEN-54). A concorrência é a de `expectedVersions` por chave (`412 VERSION_CONFLICT`, `428 PRECONDITION_REQUIRED`).
- **RN-PLAT-303** — Limite efetivo = `min(valor do tenant, teto da plataforma)`, calculado na leitura. `SET-01` devolve o valor gravado e `meta.limits["inbox.bulkMaxItems"] = { min, max, effective }`; `SET-03` devolve o valor **efetivo** (campo `inbox.bulkMaxItems`) a qualquer vínculo ativo, porque a barra de lote precisa dele (número sem dado sensível).
- **RN-PLAT-304** — Teto reduzido: não há reescrita do valor gravado, nem `TenantSettingsChanged`, nem notificação; vale o efetivo (RN-PLAT-303) e a tela explica a diferença. Salvar outras chaves não revalida o valor gravado de `inbox.bulkMaxItems`; salvar a própria chave com valor acima do teto é recusado.
- **RN-PLAT-305** — `TSK-03` e `TSK-04` (e a variante `items[]` da US-125) leem o limite efetivo do tenant uma vez, no início da requisição, pelo `InboxBulkLimitProvider`, e validam o tamanho: menos de 2 → `422 VALIDATION_ERROR` (`TOO_SHORT`); mais que o limite → `422 VALIDATION_ERROR` (`TOO_LONG`) com `errors[].params.max = <limite>`; repetidos → `DUPLICATE_IN_LIST`. Não há código específico de lote. As demais regras da US-058 (RN-INBOX-20..24) não mudam.
- **RN-PLAT-306** — Lote em andamento não é afetado por mudança de limite (limite lido uma vez); a `Idempotency-Key` cobre o lote e o replay devolve o resultado original sem revalidar o tamanho (RN-INBOX-23).
- **RN-PLAT-307** — Cache: o `InboxBulkLimitProvider` guarda o valor por tenant em memória de processo com TTL de 60 s e o invalida ao consumir `TenantSettingsChanged` cujo `keys[]` contenha `inbox.bulkMaxItems`; Redis fora do ar não impede a leitura (cai no banco). O pior caso de defasagem é 60 s.
- **RN-PLAT-308** — Permissão e política: `SETTINGS_MANAGE` (risco `H`), com MFA conforme `security.mfaPolicy` (POL-14); auditoria `settings.update` com valor anterior e novo; um único `TenantSettingsChanged` por requisição. Alterar o limite não notifica usuários.
- **RN-PLAT-309** — O limite é por tenant, igual para todos os perfis; não há limite por usuário nem por permissão. O piso de 2 itens não é configurável.
- **RN-PLAT-310** — A UI nunca é a fonte da decisão: a barra de lote usa o limite de `SET-03` só para orientar a seleção; a API sempre revalida (FA-04).
- **RN-PLAT-311** — Texto das mensagens com o limite atual: "Selecione no máximo {limite} processos por vez." e "Selecione ao menos 2 processos."; a mensagem do MVP 1 com o número 50 fixo é substituída.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Itens por lote | `values["inbox.bulkMaxItems"]` | inteiro | Não (só se alterado) | `2 ≤ valor ≤ teto` (RN-PLAT-302) | `50` |
| Versão esperada | `expectedVersions["inbox.bulkMaxItems"]` | inteiro | Sim, ao alterar | RN-TEN-54 | `version` de `SET-01` |
| Faixa permitida | `meta.limits["inbox.bulkMaxItems"]` | `{ min, max, effective }` | — | RN-PLAT-303 | `SET-01` |
| Limite efetivo (leitura pública) | `inbox.bulkMaxItems` | inteiro | — | RN-PLAT-303 | `SET-03` |
| Teto da plataforma | `INBOX_BULK_MAX_ITEMS` | inteiro (ambiente) | — | ≥ 2; padrão 200 (RN-PLAT-301) | plataforma |
| Itens do lote | `processIds` / `items` | lista | Sim (TSK-03/04) | de 2 ao limite efetivo (RN-PLAT-305) | seleção na tabela |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Valor fora da faixa permitida | Front + API (Zod) | "Informe um valor entre 2 e {teto}." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | Valor não inteiro ou nulo | Front + API (Zod) | "Informe um número inteiro." | `VALIDATION_ERROR` (`INVALID_TYPE`) |
| V-03 | `expectedVersions` ausente | API | "Recarregue a página de configurações e tente novamente." | `PRECONDITION_REQUIRED` |
| V-04 | `expectedVersions` divergente | API | "Esta configuração foi alterada por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-05 | Lote com menos de 2 itens | Front + API | "Selecione ao menos 2 processos." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-06 | Lote acima do limite efetivo | Front + API | "Selecione no máximo {limite} processos por vez." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-07 | Sem `SETTINGS_MANAGE` ao alterar | API | "Você não tem permissão para alterar configurações." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `SETTINGS_MANAGE` (risco `H`, escopo `TENANT`) para `SET-01`/`SET-02`; `SET-03` é capacidade implícita de qualquer vínculo `ACTIVE`; `PROCESS_CLAIM` e `PROCESS_ASSIGN` (ou titular) continuam sendo as permissões do lote (`TSK-03`/`TSK-04`).
- **Políticas:** POL-14 (MFA); POL-04/POL-05 por item, como na US-058.
- **MFA:** exigido ao salvar conforme `security.mfaPolicy` (`ADMINS`/`ALL`); `403 MFA_REQUIRED` abre o *step-up*.
- **Sem permissão:** o grupo "Caixa de tarefas" some para quem não tem `SETTINGS_MANAGE`; a API responde `403 PERMISSION_DENIED` e registra `access.denied`. A leitura do limite efetivo em `SET-03` continua disponível a todos os vínculos ativos.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit de `SET-02` com `inbox.bulkMaxItems` alterada | Payload: `keys[]`. Consumidor novo: `InboxBulkLimitProvider` (invalida o cache do tenant), além dos já existentes |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Alterar o limite não notifica usuários (visível na tela e na auditoria). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Limite configurável do lote da caixa de tarefas

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "inbox.bulkMaxItems" não tem valor gravado (padrão 50) e o teto da plataforma "INBOX_BULK_MAX_ITEMS" é 200
    And "Ana" é "ADMIN_ORGAO" com "SETTINGS_MANAGE"
    And "Carlos" é titular da unidade "Setor de Manutenção" e há 120 processos sem responsável na fila dela

  Scenario: [Sucesso] Aumentar o limite e assumir um lote maior
    When "Ana" alterar "inbox.bulkMaxItems" para 100 informando a versão esperada 0
    Then a configuração deve ficar em 100 na versão 1
    And deve gerar a auditoria "settings.update" com valor anterior 50 e novo 100
    And deve gerar o evento "TenantSettingsChanged" com "keys" contendo "inbox.bulkMaxItems"
    When "Carlos" assumir 80 processos em um único "bulk-claim"
    Then a API deve responder 200 com 80 resultados por item

  Scenario: [Sucesso] Reduzir o limite
    Given que "inbox.bulkMaxItems" é 100
    When "Ana" alterar para 20
    And "Carlos" enviar "bulk-claim" com 21 processos
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_LONG" no campo "processIds" com "params.max" igual a 20

  Scenario: [Sucesso] Sem configuração gravada vale o padrão
    When "Carlos" enviar "bulk-claim" com 51 processos
    Then a API deve responder 422 com erro "TOO_LONG" e "params.max" igual a 50

  Scenario: [Sucesso] A barra de lote usa o limite efetivo
    Given que "inbox.bulkMaxItems" é 100
    When "Carlos" abrir a caixa de tarefas
    Then "SET-03" deve trazer "inbox.bulkMaxItems" igual a 100
    And a seleção deve parar na linha 100 com a mensagem "Selecione no máximo 100 processos por vez."

  Scenario: [Sucesso] Teto da plataforma reduzido abaixo do valor gravado
    Given que "inbox.bulkMaxItems" está gravado em 150
    When a plataforma reduzir "INBOX_BULK_MAX_ITEMS" para 60 e reiniciar
    Then "SET-01" deve trazer o valor 150 e "meta.limits" com "effective" igual a 60
    And "SET-03" deve trazer 60
    And um "bulk-claim" com 61 processos deve receber 422 com "params.max" igual a 60
    And nenhum evento "TenantSettingsChanged" deve ser gerado

  Scenario: [Validação] Valor abaixo do piso ou acima do teto
    When "Ana" tentar gravar 1 e depois 201
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" nas duas tentativas
    And o valor gravado não deve mudar

  Scenario: [Validação] Valor que não é inteiro
    When "Ana" tentar gravar "abc"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_TYPE"

  Scenario: [Validação] Lote de um item continua inválido
    When "Carlos" enviar "bulk-claim" com 1 processo
    Then a API deve responder 422 com erro "TOO_SHORT"

  Scenario: [Permissão] Sem SETTINGS_MANAGE
    Given que "Bruno" não possui "SETTINGS_MANAGE"
    When "Bruno" enviar PATCH para "/settings" alterando "inbox.bulkMaxItems"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    But "Bruno" deve conseguir ler o limite efetivo em "/settings/public"

  Scenario: [Permissão] MFA exigido pela política
    Given que "security.mfaPolicy" é "ADMINS" e a sessão de "Ana" não tem MFA
    When "Ana" tentar alterar "inbox.bulkMaxItems"
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] O limite de outro tenant não vale
    Given que o tenant "Prefeitura B" tem "inbox.bulkMaxItems" igual a 200
    When "Carlos", em "Prefeitura de São José", enviar "bulk-claim" com 120 processos
    Then a API deve responder 422 com "params.max" igual ao limite de "Prefeitura de São José"
    And "SET-03" não deve trazer nenhum valor de "Prefeitura B"

  Scenario: [Duplicidade] Reenvio do mesmo PATCH
    Given que "Ana" enviou a alteração com "Idempotency-Key" "K1" e não recebeu resposta
    When o front reenviar o mesmo PATCH com a chave "K1"
    Then a API deve responder com o mesmo resultado e "Idempotent-Replayed" verdadeiro
    And a alteração deve ser aplicada uma única vez

  Scenario: [Duplicidade] Replay de lote depois de o limite baixar
    Given que "Carlos" enviou "bulk-claim" com 60 processos e a chave "K2" com limite 100
    And "Ana" baixou o limite para 20
    When "Carlos" reenviar a mesma requisição com a chave "K2"
    Then a API deve responder 200 com o resultado original e "Idempotent-Replayed" verdadeiro

  Scenario: [Concorrência] Duas alterações da mesma chave
    Given que "inbox.bulkMaxItems" está na versão 3
    When "Ana" e "Diego" enviarem PATCH informando a versão 3 ao mesmo tempo
    Then apenas uma alteração deve ser aplicada, avançando para a versão 4
    And a outra deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Concorrência] Limite reduzido durante um lote em andamento
    Given que "Carlos" enviou um "bulk-claim" de 90 processos com limite 100 e o processamento já começou
    When "Ana" baixar o limite para 20 durante o processamento
    Then o lote em andamento deve terminar com os 90 resultados por item
    And o próximo lote de "Carlos" deve ser validado com o limite 20

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Ana" tentar salvar o limite
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o valor gravado não deve mudar

  Scenario: [Falha de integração] Relay do outbox ou Redis indisponível
    Given que o relay do outbox está indisponível
    When "Ana" alterar o limite para 100
    Then a API deve responder 200 e o valor deve ficar gravado
    And o evento "TenantSettingsChanged" deve permanecer "PENDING" no outbox
    And o novo limite deve valer em todas as réplicas em até 60 segundos, pelo TTL do cache
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Valor fora da faixa | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | "Informe um valor entre 2 e {teto}." | Marca o campo |
| Valor não inteiro | 422 | `VALIDATION_ERROR` (`INVALID_TYPE`) | "Informe um número inteiro." | Marca o campo |
| Lote com menos de 2 itens | 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | "Selecione ao menos 2 processos." | Mantém a seleção |
| Lote acima do limite | 422 | `VALIDATION_ERROR` (`TOO_LONG`) | "Selecione no máximo {limite} processos por vez." | Atualiza o limite e pede para reduzir |
| Versão ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "Recarregue a página e tente novamente." / "Esta configuração foi alterada por outra pessoa." | Recarrega `SET-01` |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar configurações." | Oculta o grupo |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara o *step-up* |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas tentativas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém o valor digitado |

## Dependências
- **Stories:** US-058 (lote da caixa de tarefas, RN-INBOX-19..24; esta story substitui o limite fixo de 50), US-103 (registro de configurações, `SET-01..03`, `TenantSettingsChanged`). Indiretas: US-056 (caixa de tarefas), US-125 (variante `items[]` no cockpit de ramos), US-150 (LGL-04, mesmo limite), US-105 (padrão de idempotência no `PATCH`).
- **Decisões/ADRs:** DEC-209 (DT-16), DEC-059 (registro tipado), DEC-104/DEC-105 (concorrência e idempotência), DEC-161 (outbox); POL-14.
- **Configurações:** `inbox.bulkMaxItems` (tenant, padrão 50, 2..teto); `INBOX_BULK_MAX_ITEMS` (plataforma, padrão 200); `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. O código de erro do lote acima do limite: o MVP 1 não tem `BULK_LIMIT_EXCEEDED`; vale `VALIDATION_ERROR` com `TOO_LONG` (RN-INBOX-19). `params.max` é acrescentado ao erro de campo (aditivo).
  2. `SET-03` lista como públicas só `labels.*`, `branding.*` e `process.requireInternalCode` (RN-TEN-56); incluímos o valor **efetivo** de `inbox.bulkMaxItems` para a barra de lote. Alternativa: devolver o limite em `TSK-02` (`meta.bulkMaxItems`). Confirmar com o produto.
  3. O registro de configurações (US-103) não tem o grupo "Caixa de tarefas" (`inbox.*`): acrescentado aqui, assim como `meta.limits` em `SET-01` para chaves com faixa dinâmica.
  4. `INBOX_BULK_MAX_ITEMS` não está no catálogo de variáveis de ambiente: registrar em `.env.example` e na validação de configuração da API (inteiro ≥ 2), com teste de boot.
  5. A US-125 (RN-WF2-32) ainda escreve "2 a 50 itens" para `items[]`; passa a valer o limite efetivo desta story. Ajuste de redação na US-125 e no `api.md`.
  6. A meta de desempenho de um lote de 200 itens (processamento sequencial, uma transação por item) não está definida; proposta p95 ≤ 10 s, a medir na suíte de performance do endurecimento. **Dúvida de produto:** exigir confirmação reforçada acima de certo tamanho (por exemplo, acima de 100)?

## Impacto técnico
- **Performance:** subir o limite a 200 multiplica o tempo da requisição de lote (itens em sequência, transação por item); meta inicial p95 ≤ 10 s para 200 itens, a medir no endurecimento. Se não couber, o processamento paralelo controlado já previsto na US-058 é a evolução, sem mudar o contrato.
- **Segurança:** o teto da plataforma limita o raio de impacto de erro operacional; o limite não é um controle de autorização (POL-04/POL-05 seguem por item).
- **Consistência:** limite lido uma vez por requisição; cache de 60 s com invalidação por evento; a API é sempre a autoridade.
- **Compatibilidade:** sem a chave gravada, o comportamento é idêntico ao do MVP 1 (50); `params.max` e `meta.limits` são aditivos (DEC-108).

## Backend
- **Módulo(s):** `tenancy` (registro de configurações, `SET-01..03`), `process` (`BulkClaimProcessesHandler`, `BulkAssignProcessesHandler`, `InboxBulkLimitProvider`), `platform` (configuração de ambiente, outbox).
- **Casos de uso:** `UpdateSettingsCommand` (US-103, com a chave nova); `BulkClaimProcessesCommand` e `BulkAssignProcessesCommand` (US-058) passam a consultar o provedor do limite.
- **Domínio:** `SettingDefinition('inbox.bulkMaxItems')` (schema Zod `int().min(2).max(platformCeiling)`, padrão 50, grupo `inbox`), `EffectiveBulkLimit.of(tenantValue, ceiling)`.
- **Integrações internas:** `InboxBulkLimitProvider` (cache em memória com TTL 60 s e invalidação por `TenantSettingsChanged`), também usado por LGL-04 e pelo cockpit de ramos.
- **Transação:** `SET-02` como na US-103 (uma transação: validação, upsert, auditoria, outbox); a leitura do limite no lote é fora de transação e anterior ao processamento.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`, grupo "Caixa de tarefas") e SCR-013 (`/tarefas`, barra de lote).
- **Componentes:** `SettingField` (numérico com faixa e texto de apoio), `PlatformCeilingNotice`, `BulkActionBar` (limite dinâmico), `BulkResultSummary` (da US-058).
- **Dados:** TanStack Query — `['t', tenantId, 'settings']` (invalidada ao salvar) e `['t', tenantId, 'settings', 'public']` (limite efetivo).
- **Estados:** carregando, erro com "Tentar novamente", valor acima do teto com aviso, salvando; barra de lote com o limite carregado ou, na falta, o padrão 50.
- **Acessibilidade e responsividade:** campo com rótulo, descrição e faixa associados; mensagem de limite anunciada por `aria-live`; formulário em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `tenant_settings` (sem alteração de esquema), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma de esquema; a chave entra no registro tipado (`SETTING_DEFINITIONS`) e o seeder `tenancy.settings` (`applyToExistingTenants`) grava o padrão nos tenants existentes (RN-TEN-57).
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, key)` de `tenant_settings`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SET-01` *(ajuste)* | GET | `/api/v1/settings` | — | `inbox.bulkMaxItems` com `value` e `version`; `meta.limits["inbox.bulkMaxItems"] = { min, max, effective }` | 200, 401, 403 |
| `SET-02` *(ajuste)* | PATCH | `/api/v1/settings` | `{ values: { "inbox.bulkMaxItems": 100 }, expectedVersions: { "inbox.bulkMaxItems": 1 } }` | `200 { data: { chave: { value, version } } }` | 200, 403, 412, 422, 428, 429, 503 |
| `SET-03` *(ajuste)* | GET | `/api/v1/settings/public` | — | passa a incluir `inbox.bulkMaxItems` com o valor efetivo | 200, 401 |
| `TSK-03` *(ajuste)* | POST | `/api/v1/tasks/bulk-claim` | `{ processIds }` (2 até o limite efetivo) | sem mudança; `TOO_LONG` traz `params.max` | 200, 403, 422, 429, 503 |
| `TSK-04` *(ajuste)* | POST | `/api/v1/tasks/bulk-assign` | `{ processIds, assigneeId, reason }` (2 até o limite efetivo) | sem mudança; `TOO_LONG` traz `params.max` | 200, 403, 422, 429, 503 |

## Logs
- `info` `settings.updated` — `keys`, `actorId`, `correlationId` (da US-103; sem valores sensíveis).
- `info` `inbox.bulk_limit_resolved` — `tenantId`, `effective`, `source` (`CACHE` ou `DB`), a cada expiração do cache, não por requisição.
- `warn` `inbox.bulk_limit_clamped` — `tenantValue`, `ceiling` (uma vez por tenant e processo, quando o valor gravado supera o teto).
- `warn` `inbox.bulk_limit_exceeded` — `requested`, `max` (contagem; sem ids de processos).
- **Nunca logar:** lista de ids de processos do lote em nível `info`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `settings.update` | `CONFIGURATION` | Commit de `SET-02` | `changes`: `inbox.bulkMaxItems` (antes → depois) |
| `access.denied` | `ACCESS` | Sem `SETTINGS_MANAGE` | `reasonCode` = `SETTINGS_MANAGE` |

## Testes necessários
- **Unitários:** schema da chave (faixa, inteiro); `EffectiveBulkLimit` (min entre tenant e teto); validação do tamanho do lote com limite dinâmico; leitura do ambiente (`INBOX_BULK_MAX_ITEMS` inválido impede o boot).
- **Integração (Testcontainers PostgreSQL + Redis):** `SET-02` com a chave, auditoria e evento; invalidação do cache por `TenantSettingsChanged`; fallback sem Redis; `bulk-claim` e `bulk-assign` com limites diferentes; replay idempotente após mudança do limite.
- **API/contrato:** `SET-01` (`meta.limits`), `SET-02`, `SET-03` e `TOO_LONG` com `params.max` conforme o `api.md`.
- **RBAC e multi-tenant:** `SETTINGS_MANAGE` e MFA; limite e valor de um tenant nunca afetam outro (suíte `test/tenant-leak`).
- **Concorrência:** duas alterações da mesma chave; mudança do limite com lote em andamento.
- **E2E (Playwright):** alterar o limite e usar um lote maior; reduzir e ver a mensagem de limite.
- **Acessibilidade/performance:** axe no grupo de configurações; lote de 200 itens na suíte de performance (meta proposta p95 ≤ 10 s, medida no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `SET-01..03`, `TSK-03` e `TSK-04` atualizado e compatível com o `api.md`
- [ ] Logs sem dados sensíveis; métricas e traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card, `.env.example` e fontes canônicas) atualizada
- [ ] Teste de que o limite efetivo nunca excede o teto da plataforma, inclusive após o teto ser reduzido

## Estimativa
**XS** — uma chave no registro de configurações já existente, um provedor de limite com cache e a troca da constante 50 pela leitura do tenant em dois handlers; o resto é validação e texto de tela.

## Prioridade
**P2** — débito do MVP 1 (DT-16): o limite fixo atende a maioria dos órgãos; a configurabilidade ajuda os de maior volume e os mais cautelosos, sem bloquear outras stories.
