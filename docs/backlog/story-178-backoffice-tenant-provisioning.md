---
id: US-178
title: "Acesso ao backoffice e provisionamento de tenant e órgãos"
epic: EP-029
feature: FT-083
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-087, US-090, US-099]
modules: [tenancy, identity, access, audit, platform]
screens: [SCR-123]
endpoints: [PLT-01, PLT-02, PLT-03, PLT-09, PLT-10, PLT-11, PLT-12]
permissions: [PLATFORM_TENANT_MANAGE]
events: [TenantProvisioned, TenantActivated]
---

# US-178 — Acesso ao backoffice e provisionamento de tenant e órgãos

## Título
Acesso ao backoffice e provisionamento de tenant e órgãos

## Descrição
**Como** operador da plataforma (`User.isPlatformOperator`, com `PLATFORM_TENANT_MANAGE`), **quero** entrar numa área web própria (`/plataforma`, SCR-123), com segundo fator sempre, ver as instituições contratantes (tenants) e provisionar uma nova — com o órgão principal, órgãos adicionais e o convite do primeiro administrador — acompanhando o resultado etapa por etapa, **para** implantar um órgão em minutos, sem terminal, sem erro de digitação e sem que a plataforma veja processo ou documento de ninguém (DEC-208).

A story entrega a **porta de entrada do backoffice** (acesso, sessão do operador, menu e rota que não existem para quem não é operador, auditoria `backoffice.access`), a **listagem e o detalhe** de tenants (só metadados e o checklist) e o **assistente de provisionamento**. O provisionamento é **exatamente a operação da US-099** (`ProvisionTenantCommand`, checklist de etapas idempotentes e retomáveis): o backoffice é só mais um canal, ao lado da CLI e da API de plataforma, e não duplica regra. Ativar, suspender, encerrar e desativar depois do provisionamento são da US-179; acesso de suporte, da US-180; saúde operacional, da US-181.

## Contexto
- DT-07 (risks-and-decisions §6): no MVP 1 não havia UI de backoffice — a CLI era o canal principal (US-099) porque os pilotos eram poucos. Com mais órgãos, a operação manual vira gargalo e risco de erro (DEC-208, EP-029).
- DEC-208: área web própria para operadores, separada das telas do órgão; operador = grupo próprio no Authentik, MFA obrigatório; **o backoffice não lê processos nem documentos**; sem módulo novo de domínio (reaproveita `tenancy`, `identity`, `access` e `audit`); a CLI continua existindo. DEC-078: provisionamento e ciclo de vida pela plataforma (checklist, retomada, `PlatformOperatorGuard`, MFA sempre). DEC-139: operadores não têm vínculo com tenants; DEC-076: rotas `/platform/*` são `@TenantScope('PLATFORM')`, e todo acesso entre tenants passa pelo `SystemDbService` com `reason` da lista fechada (ADR-002).
- FT-083 (RN-PLAT-01..07) e POL-29: só `isPlatformOperator` acessa `/plataforma` e `/platform/*`, com MFA sempre, independentemente de `security.mfaPolicy`; nenhuma rota devolve dado de processo ou documento. Esta story detalha a **RN-PLAT-01** (acesso), a **RN-PLAT-02** (ausência de dado de tenant) e a **RN-PLAT-03** (provisionar pela operação da US-099) e não as redefine.
- RN-TEN-01..18 (US-099) continuam valendo sem mudança: slug (formato, reservados, único para sempre, imutável após a ativação), dados do ente, órgão principal (US-101), idempotência por chave natural, checklist calculado, convite só com o tenant `ACTIVE`, auditoria `actorType = PLATFORM_OPERATOR` no tenant afetado. As RN-PLAT-100..119 abaixo só acrescentam o que é do backoffice.
- A auditoria de plataforma (`tenantId` nulo) e a do tenant seguem multi-tenancy.md: ações com efeito em um tenant são gravadas **no tenant**, visíveis ao administrador com `AUDIT_VIEW`; o que acontece antes de existir tenant (slug em uso, acesso negado) vai para a auditoria de plataforma.
- Pessoa de teste neste card: "Rui" (operador). Nomes, CNPJ e e-mails dos exemplos são fictícios.

## Objetivo
Provisionar um tenant completo pelo backoffice em até 10 minutos de trabalho do operador (meta da FT-083; processamento da operação em até 2 min, p95, como na US-099), com 100% dos tenants novos provisionados pelo backoffice a partir da entrega, 0 acesso à área por quem não é operador ou está sem MFA, 0 dado de processo, documento ou pessoa do tenant em qualquer resposta de `/platform/*` e toda etapa com resultado e erro legíveis para o operador.

## Persona
- **Principal:** Operador da plataforma — Implantação/Sucesso do Cliente (Rui; `isPlatformOperator = true`, `PLATFORM_TENANT_MANAGE`, MFA).
- **Secundárias:** Administrador do órgão (`ADMIN_ORGAO`) — recebe o convite do primeiro acesso e depois vê as ações do operador na auditoria do tenant; Controle Interno e Auditor — consultam essa auditoria (DEC-139); equipe de engenharia/segurança — recebe os registros `backoffice.access`.

## Pré-condições
- US-099 concluída (operação de provisionamento, checklist, seeders registrados, PLT-01..08), US-087 (login OIDC e BFF) e US-090 (MFA e *step-up*).
- Authentik com o **grupo de operadores** e o mapeamento da *claim* `cf_platform_permissions` no cliente do BFF (lacuna 5); o operador existe em `users` com `isPlatformOperator = true` e fator TOTP ou WebAuthn cadastrado (WebAuthn preferido — security.md §4).
- Dados da fase 0 do onboarding à mão: nome e tipo do ente, UF e código IBGE; nome, sigla, CNPJ e tipo do órgão principal (e dos adicionais, se houver); nome e e-mail do primeiro administrador.
- Para o convite sair no ato: fila `email` e `IdentityFacade` (US-091/US-112) disponíveis; sem elas o tenant fica ativo e o convite é reenviado depois (FA-05).

## Fluxo principal
1. O operador acessa `/plataforma` (pelo item "Plataforma" do cartão do usuário ou direto, quando a conta não tem vínculo com nenhuma instituição). O BFF mantém a sessão e **não** injeta `X-Tenant-Id` nas chamadas `/api/v1/platform/*`.
2. A área chama `PLT-09`. A API aplica o `PlatformOperatorGuard` (operador ativo → depois MFA), registra `backoffice.access` na auditoria de plataforma e devolve o nome, as permissões de plataforma e o estado do MFA; o menu mostra só as telas das permissões que a pessoa tem.
3. Com `PLATFORM_TENANT_MANAGE`, a tela mostra a **lista de instituições** (`PLT-02`): nome, identificador (slug), tipo, UF, situação, ativada em; filtros por situação, UF, tipo e busca por nome ou identificador.
4. Ao abrir uma instituição, o **detalhe** (`PLT-03`) mostra os dados do cadastro, a situação, o checklist de provisionamento (etapas com estado e contagens) e, se houver, o resumo do convite do primeiro administrador (e-mail mascarado e situação do vínculo). Nenhum dado de negócio aparece.
5. Em "Nova instituição" o assistente tem quatro passos: **Instituição** (nome, denominação oficial, tipo, UF, IBGE, fuso, identificador), **Órgãos** (principal e até 5 adicionais), **Primeiro administrador** (nome e e-mail) e **Revisão** (resumo e "Ativar ao final").
6. No passo "Instituição", o identificador é sugerido a partir do nome e verificado em `PLT-10` enquanto o operador digita ("Disponível", "Já em uso" ou "Reservado").
7. Em "Provisionar", a tela gera uma `Idempotency-Key`, desabilita o botão e envia `PLT-01`. Enquanto a resposta não chega, acompanha o checklist: localiza o tenant por `PLT-02` (`slug` exato) e consulta `PLT-11` a cada 3 s.
8. A operação roda como na US-099: tenant em `PROVISIONING`, órgão principal e adicionais, configurações, seeders, vínculo do primeiro administrador, `tenancy.complete` (auditoria `tenant.provision`, evento `TenantProvisioned`) e, com `activate = true`, a ativação (`tenant.activate`, `TenantActivated`) seguida do envio do convite.
9. A API responde **201**; a tela mostra o **resultado**: situação "Ativa", todas as etapas "Concluída" com as contagens (órgãos, itens de catálogo, perfis, tipos de documento, workflows, feriados), o e-mail mascarado do administrador e "Convite enviado". O operador vai ao detalhe da instituição.
10. O operador informa ao administrador, fora do sistema, que o convite foi enviado (a comunicação contratual não é do produto — US-099). O administrador aceita o convite (SCR-102) e abre o assistente de implantação da US-099 (FA-09).

## Fluxos alternativos
- **FA-01 — Não é operador:** `/plataforma` e toda rota abaixo dela respondem **404** (página "não encontrada" igual à de uma rota inexistente), sem redirecionar ao login e sem item de menu. Chamada direta à API: `403 PERMISSION_DENIED` (contrato da US-099) e `backoffice.access` negado na auditoria de plataforma.
- **FA-02 — Operador sem segundo fator:** a API responde `403 MFA_REQUIRED`; a área aciona o *step-up* (`/api/auth/step-up?returnTo=/plataforma`) e volta ao ponto de origem. Nenhuma lista é carregada antes do fator.
- **FA-03 — Identificador indisponível:** `PLT-10` marca "Já em uso" ou "Reservado" (inclusive de tenant `DEACTIVATED`); o passo não avança. Se a corrida acontecer depois (outro operador criou o mesmo slug entre a verificação e o envio), `PLT-01` responde `409 TENANT_SLUG_TAKEN` e o assistente volta ao passo com a mensagem.
- **FA-04 — Etapa falhou (banco ou integração):** a resposta é `503 DEPENDENCY_UNAVAILABLE` (ou o checklist com a etapa `PENDING`/`FAILED`); a tela mostra o que foi concluído, qual etapa parou e o botão **"Retomar"**, que reenvia o mesmo pedido (mesmo slug, CNPJ e e-mail; FA-01 da US-099). As etapas concluídas permanecem intactas.
- **FA-05 — Convite não enviado:** com a fila de e-mail ou o Authentik indisponível, o tenant fica `ACTIVE` com `invitationDispatched = false`; o detalhe mostra "Convite não enviado" e o botão **"Reenviar convite"** (`PLT-12`).
- **FA-06 — Conexão perdida durante o provisionamento:** se o navegador perder a resposta (tempo-limite do BFF/ALB, rede), a tela diz "O provisionamento continua em andamento" e segue acompanhando por `PLT-02`/`PLT-11` até o fim; repetir o envio com a mesma chave resulta em `409 IDEMPOTENCY_IN_PROGRESS` (tratado como "já em andamento") ou no `201` repetido com `Idempotent-Replayed: true`.
- **FA-07 — Provisionar sem ativar:** com "Ativar ao final" desmarcado, o tenant fica `PROVISIONING` com o checklist completo e sem convite enviado; a ativação é da US-179.
- **FA-08 — Operador só com outra permissão de plataforma:** quem tem, por exemplo, só `PLATFORM_HEALTH_VIEW` entra na área e vê só a saúde (US-181); a lista de instituições e o assistente não aparecem e `PLT-02` responde `403 PERMISSION_DENIED`.
- **FA-09 — Operador desligado durante a sessão:** a condição de operador é relida a cada requisição; ao perder o grupo (ou a flag), a próxima chamada recebe `403 PERMISSION_DENIED` e a tela passa a exibir a página 404.
- **FA-10 — Administrador com identidade existente:** se o e-mail já pertence a um `User` (por exemplo, consultor com vínculo em outro tenant), reaproveita a identidade e cria só o novo vínculo; nada do outro tenant é lido nem mostrado (FA-10 da US-099).
- **FA-11 — Operador que também é servidor de um tenant:** o vínculo comum continua valendo nas telas do órgão; `/plataforma` não usa o vínculo e o operador nunca ganha vínculo com o tenant que provisiona (RN-TEN-14).

## Regras de negócio
- **RN-PLAT-100** — Quem é operador (detalha RN-PLAT-01): a API exige **duas condições** a cada requisição de `/platform/*` — `User.isPlatformOperator = true` e `status = ACTIVE`, relidos do banco, e a permissão de plataforma da rota na *claim* `cf_platform_permissions` do grupo do Authentik. Falta de qualquer uma → `403 PERMISSION_DENIED`. A flag sozinha não basta e a *claim* sozinha também não.
- **RN-PLAT-101** — MFA sempre (POL-29, DEC-078): o `amr` precisa comprovar o segundo fator em toda rota do backoffice, sem depender de `security.mfaPolicy` do tenant (que nem existe nesse contexto). A ordem é fixa: operador primeiro, MFA depois — não operador recebe `PERMISSION_DENIED` mesmo sem fator, para não revelar que a rota existe. Sem o fator: `403 MFA_REQUIRED` e *step-up*.
- **RN-PLAT-102** — Rota e menu inexistentes para quem não é operador: `/plataforma/**` responde 404 idêntico ao de qualquer rota desconhecida (mesmo corpo, mesmo tempo aproximado), nenhum redirecionamento ao login, nenhum item de menu e nenhuma referência no bundle público carregado por não operadores (a área é um grupo de rotas separado). O item "Plataforma" só aparece quando `/api/auth/session` traz `platformOperator = true` (lacuna 5). A API mantém o contrato da US-099 (403); a tradução para 404 é do servidor web.
- **RN-PLAT-103** — Sessão sem instituição ativa: rotas `PLATFORM` não recebem `X-Tenant-Id`; operador sem nenhum vínculo vai direto a `/plataforma` (e não à SCR-111 "sem vínculo"); operador com vínculos comuns continua escolhendo instituição para as telas do órgão. Trocar de instituição não altera nada em `/plataforma`. O operador nunca recebe `TenantMembership` do tenant provisionado (RN-TEN-14, DEC-139).
- **RN-PLAT-104** — Auditoria de acesso `backoffice.access` (categoria `ACCESS`, auditoria de plataforma, `tenantId` nulo): uma vez por sessão do BFF e a cada *step-up* concluído, na primeira chamada de `PLT-09`, **concedida ou negada** (mesmo padrão de `queue_dashboard.access`). `metadata`: `outcome` (`GRANTED`/`DENIED`), `reasonCode` (`NOT_OPERATOR`, `MFA_REQUIRED`, `PERMISSION_MISSING`), `permissions` concedidas e `channel = WEB`. Sem URL, sem corpo, sem IP em claro além do campo `ip` padrão do registro. Em `PLT-09` este registro **substitui** o `access.denied` do guard (para não gravar duas vezes a mesma negativa).
- **RN-PLAT-105** — Só metadados (detalha RN-PLAT-02): toda resposta de `/platform/*` sai de um *schema* de saída com **allowlist** de campos. Permitidos: dados do cadastro do tenant, situação e datas, versão, checklist (chave da etapa, estado e contagens), situação do vínculo do primeiro administrador e e-mail **mascarado**. Proibidos: conteúdo de processo, documento, comentário, anexo, valor, nome de usuário do tenant, CNPJ e dados de contato do órgão, e-mail em claro. Uma rota ou campo novo sem entrada na allowlist reprova o teste de contrato (lacuna 4).
- **RN-PLAT-106** — Listagem (`PLT-02`, estendida): filtros `status` (um ou mais), `stateCode`, `type`, `q` (nome ou slug, mínimo 2 caracteres) e `slug` (igualdade exata, usado no acompanhamento); ordenação `name` (padrão), `-createdAt`, `-activatedAt` e `status`; `pageSize` padrão 25 e no máximo 100. Lê só `tenants` pelo `SystemDbService` com `reason = TENANT_ENUMERATION`. A lista **não** calcula o checklist (custo por tenant): tenant em `PROVISIONING` é sinalizado pela situação.
- **RN-PLAT-107** — Detalhe (`PLT-03`, estendido): devolve o tenant, o checklist calculado (`verify()` de cada etapa, que lê só contagens, em transação do tenant como `PLATFORM_OPERATOR`) e o resumo do convite (situação do vínculo do primeiro administrador, `invitationDispatched`, quantidade de reenvios). Traz `ETag` (versão). O histórico de mudanças de situação é da US-179 (`PLT-13`).
- **RN-PLAT-108** — Uma só operação (RN-PLAT-03): o backoffice chama `ProvisionTenantCommand` da US-099; validações, ordem das etapas e atomicidade por etapa são as de lá. O front usa o mesmo *schema* `provisionTenantSchema` de `packages/validation` só para orientar o preenchimento; a decisão é sempre da API. `metadata.channel = BACKOFFICE` na auditoria e no evento (lacuna 2).
- **RN-PLAT-109** — Idempotência no assistente: `Idempotency-Key` obrigatória em `PLT-01` (DEC-105), gerada pela tela (UUID v4) **uma vez por tentativa de provisionar** e reutilizada em qualquer reenvio após erro de rede ou 5xx; "Provisionar" fica desabilitado enquanto há requisição em andamento. Mesma chave com corpo diferente → `422 IDEMPOTENCY_KEY_REUSED`; em processamento → `409 IDEMPOTENCY_IN_PROGRESS`.
- **RN-PLAT-110** — Identificador (slug): a tela sugere a partir do nome (minúsculas, sem acento, hífen no lugar de espaço) e confirma por `PLT-10` com *debounce* de 400 ms. `PLT-10` é só **orientação**: quem decide é `PLT-01` (RN-TEN-01/02, índice único). Responde `available`, e quando indisponível, `reason` ∈ `INVALID_FORMAT`, `RESERVED`, `TAKEN`; nunca devolve dados do tenant dono do slug.
- **RN-PLAT-111** — Órgãos: o pedido leva o órgão principal e, opcionalmente, até 5 órgãos adicionais (`additionalOrganizations[]`), todos com as regras da US-101 (CNPJ com DV, sigla única no tenant). CNPJ ou sigla repetidos dentro do próprio pedido → `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`). Os adicionais entram na etapa `tenancy.additionalOrganizations` (depois da `tenancy.primaryOrganization`), idempotente por CNPJ; o checklist mostra a contagem. Depois do provisionamento, criar ou editar órgão é do administrador (ORG-02/ORG-04, US-101) — o operador não edita órgão de tenant.
- **RN-PLAT-112** — Primeiro administrador: nome (3–200) e e-mail (≤ 254, minúsculas). O e-mail volta **mascarado** em toda resposta e tela (`r***@…`), nunca entra em log, nunca é gravado no navegador (o assistente não persiste rascunho em `localStorage`/`sessionStorage`) e some da memória da página ao sair do assistente.
- **RN-PLAT-113** — Ativação ao final: `activate` padrão `true` (como na US-099); `false` mantém `PROVISIONING`. O convite só é enviado com o tenant `ACTIVE` (RN-TEN-08) e a validade de 7 dias conta do envio.
- **RN-PLAT-114** — Acompanhamento: a tela consulta `PLT-11` a cada 3 s (recuo gradual até 10 s) enquanto houver etapa em andamento, por no máximo 10 minutos; `PLT-11` lê o checklist e o último erro de etapa (`step`, `errorCode`) do registro `tenant.provision` de falha, sem texto livre. O acompanhamento não depende de a resposta do `PLT-01` chegar.
- **RN-PLAT-115** — Resultado legível: cada etapa aparece com rótulo em português ("Órgão principal", "Catálogos", "Perfis", "Tipos de documento", "Templates", "Fluxos de trabalho", "Feriados", "Primeiro administrador"…), estado (Concluída, Pendente, Falhou) e contagem; o erro mostra a mensagem do catálogo de erros, a ação possível ("Retomar", "Reenviar convite", "Voltar e corrigir") e o `correlationId` copiável. Nenhuma pilha de erro, SQL ou nome de tabela chega à tela.
- **RN-PLAT-116** — Retomada pelo backoffice: "Retomar" reenvia o pedido completo; a API compara a impressão (`provisioningFingerprint`: slug + CNPJ do órgão principal + e-mail do administrador, DEC-078). Divergência → `409 TENANT_SLUG_TAKEN` ("Este identificador pertence a outro pedido de provisionamento"). Se a página foi fechada, o operador refaz o preenchimento (o pedido não é guardado no navegador — RN-PLAT-112; lacuna 7).
- **RN-PLAT-117** — Reenviar convite (`PLT-12`): só com o tenant `ACTIVE` e o vínculo do primeiro administrador ainda `INVITED` (convite não aceito); regra de reenvio de convite do RN-IAM-53 (máximo 5 reenvios, intervalo mínimo de 1 min) → `429 RATE_LIMITED`; novo token e nova validade de 7 dias a partir do envio. Fila ou Authentik indisponíveis → `503 DEPENDENCY_UNAVAILABLE` sem consumir o limite de reenvios. Auditoria `tenant.resend_invite` (lacuna 8).
- **RN-PLAT-118** — Limites de taxa por operador (lacuna 9): `PLT-01` até 5 por minuto; `PLT-10` até 30 por minuto; demais leituras 600/min e escritas 120/min; excesso → `429 RATE_LIMITED` com `Retry-After`.
- **RN-PLAT-119** — Cabeçalhos e navegação da área: `/plataforma/**` e `/api/v1/platform/*` respondem `Cache-Control: no-store` e `X-Robots-Tag: noindex`; a área tem cabeçalho próprio ("Plataforma ContrataFlow", cor de faixa distinta das telas do órgão) para que ninguém confunda os dois contextos; vale o CSRF do BFF (`X-CF-Request`, DEC-135).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome da instituição | `name` | texto | Sim | 3–200 (RN-TEN-04) | — |
| Denominação oficial | `legalName` | texto | Não | até 250 | — |
| Tipo de ente | `type` | `TenantType` | Sim | enum | — |
| UF | `stateCode` | char(2) | Sim | lista de UFs | — |
| Código IBGE | `ibgeCityCode` | char(7) | Condicional | RN-TEN-03 | — |
| Fuso horário | `timezone` | IANA | Não | allowlist BR | `America/Sao_Paulo` |
| Identificador | `slug` | texto | Sim | RN-TEN-01/02, RN-PLAT-110 | sugerido a partir do nome |
| Órgão principal | `primaryOrganization.{name, shortName, cnpj, type, email?, phone?}` | objeto | Sim | US-101 | — |
| Órgãos adicionais | `additionalOrganizations[]` | lista de objetos | Não | até 5, RN-PLAT-111 | vazio |
| Primeiro administrador | `firstAdmin.{email, name}` | objeto | Sim | RN-PLAT-112 | — |
| Ativar ao final | `activate` | booleano | Não | RN-PLAT-113 | `true` |
| Chave de idempotência | `Idempotency-Key` | cabeçalho (UUID) | Sim | RN-PLAT-109 | gerada pela tela |
| Filtros da lista | `status[]`, `stateCode`, `type`, `q`, `slug` | texto | Não | RN-PLAT-106 | — |
| Ordenação e paginação | `sort`, `page`, `pageSize` | texto, inteiros | Não | `pageSize` ≤ 100 | `name`, 1, 25 |
| Situação da instituição | `status` | `TenantStatus` | — | somente leitura | sistema |
| Checklist | `provisioning.steps[]` | lista | — | `key`, `status`, `details` | calculado |
| Convite do administrador | `firstAdmin.{email mascarado, membershipStatus, invitationDispatched, resendCount}` | objeto | — | RN-PLAT-107/112 | sistema |
| Disponibilidade do identificador | `available`, `reason` | booleano, enum | — | RN-PLAT-110 | `PLT-10` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Obrigatórios e tamanhos do pedido | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Formato do identificador ou identificador reservado | Front + API | "Use letras minúsculas, números e hífen; este identificador é reservado." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | Identificador já usado (inclusive de tenant desativado) | API + índice único | "O identificador \"{slug}\" já está em uso." | `TENANT_SLUG_TAKEN` |
| V-04 | UF, tipo ou fuso fora da lista; IBGE ausente ou divergente da UF | Front + API | "Selecione um valor válido." / "Informe o código IBGE de 7 dígitos do município da UF {uf}." | `VALIDATION_ERROR` (`INVALID_ENUM`/`CONDITIONAL_REQUIRED`/`INVALID_FORMAT`) |
| V-05 | CNPJ inválido em qualquer órgão | Front + API | "CNPJ inválido. Confira os dígitos verificadores." | `VALIDATION_ERROR` (`INVALID_CNPJ`) |
| V-06 | Órgão adicional repetido no pedido (CNPJ ou sigla) ou mais de 5 | Front + API | "Este órgão já foi informado." / "Informe no máximo 5 órgãos adicionais." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`/`OUT_OF_RANGE`) |
| V-07 | E-mail ou nome do primeiro administrador inválidos | Front + API | "Informe um e-mail válido." / "Informe o nome do administrador." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`TOO_SHORT`) |
| V-08 | `Idempotency-Key` ausente | API | "Não foi possível enviar o pedido. Tente novamente." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-09 | Mesma chave com corpo diferente / em processamento | API | "Esta solicitação já foi enviada com outros dados." / "O provisionamento já está em andamento." | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` |
| V-10 | Não é operador, ou sem a permissão da rota | API | "Acesso restrito a operadores da plataforma." | `PERMISSION_DENIED` |
| V-11 | Sessão sem segundo fator | API | "Confirme sua identidade com o segundo fator." | `MFA_REQUIRED` |
| V-12 | Filtro, `sort` ou `pageSize` fora do domínio; `q` com menos de 2 caracteres | Front + API | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`OUT_OF_RANGE`/`TOO_SHORT`) |
| V-13 | Convite: tenant fora de `ACTIVE` ou administrador já ativo | API | "Não é possível reenviar: o convite já foi aceito ou a instituição não está ativa." | `INVALID_STATE` |
| V-14 | Excesso de reenvios ou de chamadas | API | "Muitas tentativas. Aguarde alguns instantes." | `RATE_LIMITED` |

## Permissões
- **Permissão:** `PLATFORM_TENANT_MANAGE` (permissions.md §8) para `PLT-01`, `PLT-02`, `PLT-03`, `PLT-10`, `PLT-11` e `PLT-12`; `PLT-09` exige só ser operador com MFA (qualquer permissão de plataforma) e devolve as que a pessoa tem. A permissão vem da *claim* `cf_platform_permissions` (RN-PLAT-100) e **não** faz parte de perfis de tenant.
- **Políticas:** POL-29 (backoffice: `isPlatformOperator` + MFA sempre + permissão da rota; não lê processo nem documento); DEC-139 (sem vínculo para o operador); DEC-078 (`PlatformOperatorGuard`).
- **MFA:** sempre, por rota, sem depender de `security.mfaPolicy`.
- **Sem permissão:** não operador → página 404 no web e `403 PERMISSION_DENIED` na API; operador sem a permissão da rota → `403 PERMISSION_DENIED` (`access.denied` de plataforma, `reasonCode` = permissão); operador sem MFA → `403 MFA_REQUIRED`. Usuário de tenant, inclusive `ADMIN_ORGAO`, nunca passa. Rotas de tenant chamadas por operador sem vínculo → `403 MEMBERSHIP_INACTIVE`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantProvisioned` | `tenant.provisioned` | Etapa `tenancy.complete` | Uma vez por tenant; payload acrescido de `channel` (`CLI`/`API`/`BACKOFFICE`) — lacuna 2 |
| `TenantActivated` | `tenant.activated` | Ativação ao final do provisionamento | Invalida o cache de status (US-100) |

Eventos próprios das fachadas chamadas (`OrganizationCreated`, `UserInvited`, `RoleAssigned`…) seguem as stories donas. Acesso e reenvio de convite não geram evento de domínio (só auditoria).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| E-mail de convite (US-091/US-112) | Primeiro administrador | E-mail | Após a ativação e a cada reenvio por `PLT-12` |
| — | Operador | — | O resultado é mostrado na própria tela; sem notificação interna |
| — | Usuários do tenant | — | Nenhuma (a comunicação contratual ocorre fora do sistema) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Acesso ao backoffice e provisionamento de tenant e órgãos

  Background:
    Given que "Rui" é operador da plataforma com "PLATFORM_TENANT_MANAGE" e MFA ativo
    And "Paula" é "ADMIN_ORGAO" do tenant "Prefeitura Existente" e não é operadora
    And não existe tenant com o slug "prefeitura-exemplo"
    And os seeders "catalog.items", "access.defaultRoles", "document.systemTypes", "document.templateLibrary", "workflow.seedWorkflows" e "catalog.holidays" estão registrados

  Scenario: [Sucesso] Operador com MFA entra no backoffice
    When "Rui" abrir "/plataforma"
    Then a API deve responder 200 em "PLT-09" com o nome e as permissões de plataforma de "Rui"
    And a tela deve listar as instituições e mostrar "Nova instituição"
    And deve existir auditoria de plataforma "backoffice.access" com outcome "GRANTED"

  Scenario: [Sucesso] Listar e abrir uma instituição só com metadados
    Given que existem 3 tenants em situações "ACTIVE", "SUSPENDED" e "PROVISIONING"
    When "Rui" filtrar por situação "ACTIVE" e abrir o detalhe de "Prefeitura Existente"
    Then a resposta deve trazer cadastro, situação, versão, checklist com contagens e o e-mail mascarado do primeiro administrador
    And nenhum processo, documento, comentário, nome de usuário, CNPJ de órgão ou e-mail em claro deve ser retornado

  Scenario: [Sucesso] Provisionar uma prefeitura com dois órgãos
    When "Rui" provisionar o tenant "prefeitura-exemplo" com nome "Prefeitura Exemplo", tipo "MUNICIPALITY", UF "SC", IBGE "4216602", órgão principal "Prefeitura Municipal Exemplo" (sigla "PME", CNPJ "11.222.333/0001-81"), órgão adicional "Câmara Municipal Exemplo" (sigla "CME", CNPJ "11.444.777/0001-61") e administrador "Ana Exemplo" com e-mail "ana@pexemplo.exemplo.gov.br"
    Then a API deve responder 201 com status "ACTIVE" e todas as etapas do checklist "DONE"
    And o tenant deve ter 2 órgãos, 84 itens de catálogo de sistema, 15 perfis padrão, 11 tipos de documento e 2 workflows publicados
    And a resposta deve trazer o e-mail do administrador mascarado e "invitationDispatched" verdadeiro
    And devem existir auditorias "tenant.provision" e "tenant.activate" com actorType "PLATFORM_OPERATOR" e channel "BACKOFFICE" no tenant "prefeitura-exemplo"
    And devem ser gerados os eventos "TenantProvisioned" e "TenantActivated"
    And "Rui" não deve possuir vínculo com o tenant "prefeitura-exemplo"

  Scenario: [Sucesso] Verificar o identificador antes de enviar
    When "Rui" digitar o identificador "prefeitura-exemplo" no assistente
    Then "PLT-10" deve responder "available" verdadeiro
    When "Rui" digitar "plataforma"
    Then "PLT-10" deve responder "available" falso com motivo "RESERVED"

  Scenario: [Sucesso] Acompanhar o checklist durante o provisionamento
    Given que o provisionamento de "prefeitura-exemplo" está em andamento
    When a tela consultar "PLT-11" a cada 3 segundos
    Then cada etapa deve aparecer com rótulo em português, estado e contagem
    And ao final a tela deve mostrar "Instituição ativa" e o resumo do resultado

  Scenario: [Sucesso] Provisionar sem ativar
    When "Rui" provisionar "prefeitura-exemplo" desmarcando "Ativar ao final"
    Then a resposta deve trazer status "PROVISIONING" com o checklist completo
    And nenhum e-mail de convite deve ser enfileirado

  Scenario: [Sucesso] Reenviar o convite do primeiro administrador
    Given que o tenant "prefeitura-exemplo" está "ACTIVE" e o convite não foi aceito
    When "Rui" acionar "Reenviar convite"
    Then "PLT-12" deve responder 200 com "invitationDispatched" verdadeiro
    And o token anterior deve ser invalidado e deve existir auditoria "tenant.resend_invite"

  Scenario: [Validação] Dados de cadastro inválidos
    When "Rui" enviar slug "Prefeitura Exemplo", CNPJ "11.222.333/0001-82" e fuso "Europe/Lisbon"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And "errors" deve conter "slug" com "INVALID_FORMAT", "primaryOrganization.cnpj" com "INVALID_CNPJ" e "timezone" com "INVALID_ENUM"
    And nenhum tenant deve ser criado

  Scenario: [Validação] Órgão adicional repetido no pedido
    When "Rui" informar o mesmo CNPJ no órgão principal e em um órgão adicional
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST" em "additionalOrganizations[0].cnpj"

  Scenario: [Validação] Pedido sem chave de idempotência
    When "Rui" enviar "PLT-01" sem o cabeçalho "Idempotency-Key"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no cabeçalho

  Scenario: [Permissão] Administrador de tenant não enxerga o backoffice
    When "Paula" abrir "/plataforma"
    Then a página deve ser a de "não encontrada" e o menu não deve ter o item "Plataforma"
    When "Paula" enviar GET "/api/v1/platform/tenants"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve existir auditoria de plataforma "access.denied" com reasonCode "PLATFORM_TENANT_MANAGE"

  Scenario: [Permissão] Operador sem segundo fator
    Given que "Rui" se autenticou sem segundo fator
    When "Rui" abrir "/plataforma"
    Then a API deve responder 403 com código "MFA_REQUIRED" e a tela deve acionar o step-up
    And nenhuma instituição deve ser listada antes do segundo fator
    And deve existir auditoria de plataforma "backoffice.access" com outcome "DENIED" e reasonCode "MFA_REQUIRED"

  Scenario: [Permissão] Operador sem a permissão da tela
    Given que "Rui" tem só "PLATFORM_HEALTH_VIEW"
    When "Rui" enviar GET "/api/v1/platform/tenants"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o menu não deve mostrar "Instituições"

  Scenario: [Tenant incorreto] Operador não acessa dados do tenant que provisionou
    When "Rui" enviar GET "/api/v1/processes" com "X-Tenant-Id" do tenant "prefeitura-exemplo"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Tenant incorreto] Detalhe de instituição inexistente
    When "Rui" abrir o detalhe de um identificador que não existe
    Then a API deve responder 404 com código "TENANT_NOT_FOUND"

  Scenario: [Tenant incorreto] Seeders gravam somente no tenant novo
    Given que o tenant "Prefeitura Existente" tem itens de catálogo personalizados
    When o tenant "prefeitura-exemplo" for provisionado
    Then nenhuma linha de "Prefeitura Existente" deve ser criada, alterada ou lida
    And todas as linhas criadas devem ter "tenant_id" do tenant "prefeitura-exemplo"

  Scenario: [Duplicidade] Identificador de tenant desativado não é reutilizado
    Given que existe o tenant "prefeitura-antiga" com status "DEACTIVATED"
    When "Rui" provisionar outro tenant com o slug "prefeitura-antiga"
    Then a API deve responder 409 com código "TENANT_SLUG_TAKEN"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Rui" provisionou "prefeitura-exemplo" com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo tenant e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único conjunto de dados semeados e um único convite

  Scenario: [Concorrência] Dois operadores provisionam o mesmo identificador
    Given que "Rui" e "Caio" são operadores
    When os dois enviarem ao mesmo tempo o slug "prefeitura-exemplo" com CNPJs diferentes
    Then exatamente um deve receber 201 e o outro 409 com código "TENANT_SLUG_TAKEN"

  Scenario: [Concorrência] Mesma chave em processamento
    Given que o provisionamento de "prefeitura-exemplo" com a chave "K2" está em andamento
    When "Rui" reenviar a requisição com a chave "K2"
    Then a API deve responder 409 com código "IDEMPOTENCY_IN_PROGRESS"
    And a tela deve continuar acompanhando o checklist

  Scenario: [Concorrência] Operador desligado durante a sessão
    Given que "Rui" está com o backoffice aberto
    When a flag de operador de "Rui" for removida e ele recarregar a lista
    Then a API deve responder 403 com código "PERMISSION_DENIED" e a tela deve exibir a página "não encontrada"

  Scenario: [Falha de banco] Banco falha no meio do provisionamento e a retomada continua
    Given que o banco falha durante o seeder "document.templateLibrary"
    When "Rui" provisionar "prefeitura-exemplo"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e o tenant deve permanecer "PROVISIONING"
    And a tela deve mostrar as etapas concluídas, a etapa parada e o botão "Retomar"
    When "Rui" acionar "Retomar" com o banco disponível
    Then somente as etapas pendentes devem ser executadas e os itens de catálogo devem continuar 84

  Scenario: [Falha de banco] Banco indisponível ao listar
    Given que o banco de dados está indisponível
    When "Rui" abrir a lista de instituições
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Tentar novamente" e manter os filtros

  Scenario: [Falha de integração] Authentik indisponível na etapa do primeiro administrador
    Given que o Authentik está indisponível
    When o provisionamento de "prefeitura-exemplo" chegar à etapa "identity.firstAdmin"
    Then a etapa deve ficar "PENDING", o tenant deve permanecer "PROVISIONING" e a resposta deve ser 503 "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Retomar" e nenhuma etapa concluída deve ser refeita

  Scenario: [Falha de integração] Fila de e-mail indisponível na ativação
    Given que a fila "email" está indisponível
    When o provisionamento de "prefeitura-exemplo" for concluído
    Then o tenant deve ficar "ACTIVE" e a resposta deve indicar "invitationDispatched" falso
    And a tela deve mostrar "Convite não enviado" e o botão "Reenviar convite"
    When "Rui" acionar "Reenviar convite" com a fila ainda indisponível
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" sem consumir o limite de reenvios
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo, filtro ou cabeçalho inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Erro no campo; o assistente volta ao passo |
| Identificador em uso | 409 | `TENANT_SLUG_TAKEN` | "O identificador \"{slug}\" já está em uso." | Volta ao passo "Instituição" e sugere outro |
| Chave de idempotência reutilizada com outro corpo | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave e pede confirmação |
| Provisionamento em curso | 409 | `IDEMPOTENCY_IN_PROGRESS` | "O provisionamento já está em andamento." | Continua o acompanhamento |
| Não é operador ou sem a permissão | 403 | `PERMISSION_DENIED` | "Acesso restrito a operadores da plataforma." | Página "não encontrada" (web) |
| Sessão sem segundo fator | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator." | *Step-up* |
| Instituição inexistente | 404 | `TENANT_NOT_FOUND` | "Instituição não encontrada." | Volta à lista |
| Reenvio fora de situação válida | 409 | `INVALID_STATE` | "Não é possível reenviar: o convite já foi aceito ou a instituição não está ativa." | Atualiza o detalhe |
| Excesso de chamadas ou de reenvios | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco, Redis, Authentik ou fila indisponíveis | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Os passos concluídos foram mantidos." | "Retomar" ou "Tentar novamente"; filtros e etapas mantidos |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Erro inesperado. Código: {correlationId}." | Exibe o `correlationId` copiável |

## Dependências
- **Stories:** US-099 (operação de provisionamento, checklist, seeders, CLI e PLT-01..08), US-087 (login OIDC, BFF e sessão), US-090 (MFA e *step-up*). Indiretas: US-100 (`SystemDbService`, cache de status, papéis de banco), US-101 (regras do órgão), US-091 e US-112 (convite e e-mail), US-073 (auditoria), US-082 (outbox), US-086 (shell web e páginas de erro). Habilita: US-179, US-180, US-181 (mesma área e mesma porta de entrada).
- **Decisões/ADRs:** DEC-208, DEC-078, DEC-076, DEC-139, DEC-132, DEC-105, DEC-135, DEC-130, DEC-133; ADR-002; POL-29; DT-07, DT-18.
- **Configurações:** nenhuma chave de tenant nova. De plataforma (proposta): tempo-limite do BFF para `PLT-01` e grupo/claim do Authentik (lacunas 5 e 7).
- **Lacunas nas fontes canônicas:**
  1. `PLT-09` (`GET /platform/me`), `PLT-10` (`GET /platform/tenants/slug-availability`), `PLT-11` (`GET /platform/tenants/{id}/provisioning`) e `PLT-12` (`POST /platform/tenants/{id}/resend-invitation`) são novos; entram no `api.md` do MVP 2 com `x-tenant-scope: PLATFORM` e como operações classificadas no manifesto da suíte "tenant leak" (isentas, com motivo: rotas de plataforma sem dado de tenant). A CLI `tenant:resend-invite` ganha a rota equivalente.
  2. `PLT-01` ganha `additionalOrganizations[]` (até 5) e a etapa `tenancy.additionalOrganizations` no checklist; a US-099 só previa o órgão principal. `TenantProvisioned` e a auditoria `tenant.provision` ganham `channel` com o valor `BACKOFFICE` (events.md e o KPI "provisionados pelo backoffice" do épico dependem disso). `PLT-02` ganha `slug` exato, `type`, `status` múltiplo e `sort`; `PLT-03` ganha o resumo do convite.
  3. `PLT-09` registra `backoffice.access` e, nele, **substitui** o `access.denied` do `PlatformOperatorGuard` (RN-PLAT-104); events.md §7 deve descrever `backoffice.access` com `outcome`, `reasonCode` e `permissions`, hoje só listada.
  4. O *schema* de saída com allowlist (RN-PLAT-105) e o teste de contrato que reprova rota ou campo de processo/documento em `/platform/*` não existem no MVP 1; entram aqui como padrão para as US-179, US-180 e US-181.
  5. Autenticação do operador: o grupo de operadores e a *claim* `cf_platform_permissions` existem só no cliente de operação do Bull Board (queues.md §15.1); é preciso o mesmo mapeamento no cliente do BFF (blueprint do Authentik), o campo `platformOperator` em `/api/auth/session` e a regra do BFF "operador sem vínculo → `/plataforma`" (US-087 mandava ao SCR-111).
  6. Divergência de contrato 404 × 403: o web responde 404 para o não operador (a área "não existe"), enquanto a API mantém `403 PERMISSION_DENIED` (US-099). Documentar em `api.md` e no guia de segurança que o 404 é do servidor web, não da API.
  7. `PLT-01` é síncrono (201, p95 < 2 min): o tempo-limite do BFF e do balanceador para essa rota precisa ser maior que o dos demais (proposta: 130 s) e a retomada pela tela exige redigitar CNPJ e e-mail do administrador se a página for fechada. Alternativa a decidir com segurança: gravar o pedido cifrado (sem o e-mail em claro) para "Retomar" sem redigitar, ou tornar a operação assíncrona (`202` + `PLT-11`).
  8. Ação de auditoria `tenant.resend_invite` (categoria `SYSTEM`, `PLATFORM_OPERATOR`) não existe em events.md §7 (a CLI da US-099 reenvia sem registro específico); acrescentar com `metadata`: `channel`, `resendCount`.
  9. api.md §1.6 não tem classe de limite para `/platform/*`: proposta 600/min de leitura e 120/min de escrita por operador, com 5/min em `PLT-01` e 30/min em `PLT-10`.
  10. O detalhe mostra só o que `tenants` e o checklist trazem; o **nome e a sigla do órgão principal** não são lidos (são dado do tenant). Se o produto quiser mostrá-los, `details` da etapa `tenancy.primaryOrganization` precisa carregar `shortName` (dado institucional público): decisão de produto.

## Impacto técnico
- **Performance:** meta p95 ≤ 2 min do provisionamento (US-099), listagem p95 ≤ 500 ms para até 1.000 tenants (só `tenants`, sem checklist), `PLT-09` e `PLT-10` p95 ≤ 200 ms; o acompanhamento consulta `PLT-11` (barato: lê o registro de falha e as contagens já gravadas) a cada 3 s, no máximo 200 consultas por provisionamento.
- **Segurança:** nenhuma rota devolve dado de processo ou documento (allowlist, RN-PLAT-105); e-mail do administrador mascarado e fora de logs; operador relido do banco a cada requisição; sem vínculo do operador; auditoria de acesso concedida e negada; a área não é indexável nem guardada em cache.
- **Consistência:** o provisionamento mantém a atomicidade por etapa da US-099; `backoffice.access` não depende de transação de tenant; reexecução do mesmo pedido não duplica dado nem convite.
- **Compatibilidade:** `PLT-01..03` mudam de forma aditiva (campos novos opcionais); CLI e API de plataforma continuam iguais; o `TenantProvisioned` ganha um campo opcional (consumidores existentes ignoram).
- **Risco operacional:** o operador pode confundir a área com as telas do órgão — cabeçalho e faixa próprios (RN-PLAT-119); privilégio amplo demais — permissões de plataforma separadas por tela e auditoria visível ao tenant (feature FT-083).

## Backend
- **Módulo(s):** `tenancy` (provisionamento, consultas, `PlatformTenantsController`), `identity` (operador, convite, `PlatformOperatorPort`), `access` (permissões de plataforma a partir da *claim*), `audit`, `platform` (BFF).
- **Casos de uso:** `GetPlatformOperatorContextQuery` (`PLT-09`, grava `backoffice.access`), `ListTenantsQuery` e `GetTenantQuery` (estendidos), `CheckTenantSlugAvailabilityQuery` (`PLT-10`), `GetProvisioningProgressQuery` (`PLT-11`), `ProvisionTenantCommand` (estendido: órgãos adicionais, `channel`), `ResendFirstAdminInvitationCommand` (`PLT-12`; o mesmo da CLI).
- **Domínio:** `TenantSlug` (regras e reservados de `packages/types`), `ProvisioningChecklist`/`TenantSeeder` (US-099), nova etapa `tenancy.additionalOrganizations`, `PlatformResponseAllowlist` (schemas de saída).
- **Integrações internas:** `SystemDbService` (`TENANT_ENUMERATION`, `TENANT_PROVISIONING`, `PLATFORM_AUDIT`), `TenantTransaction.runForTenant` (contagens do checklist, como `PLATFORM_OPERATOR`), `IdentityFacade.dispatchInvitation`, `AuditService`, `OutboxWriter`, `TenantStatusCache`.
- **Apresentação:** `PlatformOperatorGuard` + MFA em todas as rotas `PLATFORM`; `PlatformSessionController` (`PLT-09`); BFF: `platformOperator` na sessão, rota sem `X-Tenant-Id` para `/api/v1/platform/*`, tempo-limite estendido em `PLT-01`.
- **Transação:** a mesma da US-099 (uma por etapa; mudança de status + auditoria + outbox juntas na conexão de plataforma); `backoffice.access` em transação própria, curta, que nunca bloqueia a resposta (falha de gravação → `error` e a requisição segue negada ou concedida conforme a regra).

## Frontend
- **Tela(s):** SCR-123 — Backoffice da plataforma (`/plataforma`): lista de instituições; `/plataforma/instituicoes/nova` (assistente) e `/plataforma/instituicoes/[tenantId]` (detalhe e checklist). Grupo de rotas separado do shell do órgão, com layout e cabeçalho próprios.
- **Componentes:** `PlatformShell`, `PlatformNav` (itens por permissão), `TenantListTable` e `TenantFilters`, `TenantDetailCard`, `ProvisioningChecklist` (etapas com rótulo, estado e contagem), `ProvisioningWizard` (quatro passos), `SlugField` (sugestão e verificação), `OrganizationsFieldArray`, `ProvisioningProgress`, `ProvisioningResult`, `FirstAdminInvitationStatus` (com "Reenviar convite"), `OperatorBanner`.
- **Estados:** loading (skeleton), lista vazia ("Nenhuma instituição cadastrada."), erro com "Tentar novamente", provisionando (progresso por etapa em `aria-live`), parcial ("Retomar"), sucesso; página 404 para quem não é operador.
- **Acessibilidade e responsividade:** assistente operável por teclado, foco no título do passo e no primeiro campo com erro; estado das etapas por texto e ícone (não só cor); progresso anunciado em `aria-live="polite"`; tabela rolável com cabeçalho fixo e cartões abaixo de 768 px; contraste AA na faixa distinta da área.

## Banco de dados
- **Tabelas:** leitura e escrita de `tenants` (`cf_platform`); escritas do provisionamento como na US-099 (`organizations`, `tenant_settings`, `catalog_items`, `roles`, `document_types`, `document_templates`, `workflows`, `holidays`, `users`, `tenant_memberships`, `role_assignments`, `audit_logs`, `outbox_events`). Nenhuma tabela nova.
- **Migrações:** nenhuma de esquema; ações de auditoria novas (`backoffice.access`, `tenant.resend_invite`) entram no registro de ações; seeders sem mudança.
- **Índices/constraints relevantes:** `UNIQUE (slug)` e índice `tenants(status)` (US-099/US-100); busca por `q` em nome e slug com `ILIKE` (volume baixo, sem índice novo); trigger `tenants_slug_immutable`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PLT-09` | GET | `/api/v1/platform/me` | — | `200 { data: { userId, name, permissions[], mfaVerified, areas[] } }` | 200, 403 |
| `PLT-01` | POST | `/api/v1/platform/tenants` | US-099 + `additionalOrganizations[]` (≤ 5) + `Idempotency-Key` | `201 { data: Tenant + provisioning{ complete, steps[] } + firstAdmin{ email mascarado, membershipStatus, invitationDispatched } }` + `Location` | 201, 403, 409, 422, 429, 503 |
| `PLT-02` | GET | `/api/v1/platform/tenants` | `status[]`, `stateCode`, `type`, `q`, `slug`, `sort`, `page`, `pageSize` | `200 { data: [{ id, slug, name, type, status, stateCode, plan, activatedAt, suspendedAt, version }], meta }` | 200, 403, 422, 503 |
| `PLT-03` | GET | `/api/v1/platform/tenants/{id}` | — | `200 { data: Tenant + provisioning + firstAdmin{ … resendCount } }` + `ETag` | 200, 403, 404, 503 |
| `PLT-10` | GET | `/api/v1/platform/tenants/slug-availability` | `slug` | `200 { data: { slug, available, reason? } }` | 200, 403, 422, 429 |
| `PLT-11` | GET | `/api/v1/platform/tenants/{id}/provisioning` | — | `200 { data: { status, complete, steps[], lastError? { step, errorCode } } }` | 200, 403, 404, 503 |
| `PLT-12` | POST | `/api/v1/platform/tenants/{id}/resend-invitation` | `{}` | `200 { data: { invitationDispatched, firstAdmin{ email mascarado, membershipStatus, resendCount } } }` | 200, 403, 404, 409, 429, 503 |

Trecho de `PLT-09`: `{ "data": { "name": "Rui", "permissions": ["PLATFORM_TENANT_MANAGE", "PLATFORM_SUPPORT_ACCESS"], "mfaVerified": true, "areas": ["tenants", "support"] } }`. Trecho de `PLT-11`: `{ "status": "PROVISIONING", "complete": false, "steps": [{ "key": "catalog.items", "status": "DONE", "details": { "items": 84 } }, { "key": "document.templateLibrary", "status": "PENDING" }], "lastError": { "step": "document.templateLibrary", "errorCode": "DEPENDENCY_UNAVAILABLE" } }`.

## Logs
- `info` `backoffice.access` — `operatorId`, `outcome`, `reasonCode`, `permissions`, `durationMs`.
- `info` `tenant.provision.started` / `tenant.provision.step_completed` — como na US-099, com `channel = BACKOFFICE`.
- `warn` `tenant.provision.step_failed` — `tenantId`, `step`, `errorCode`.
- `warn` `tenant.invitation_dispatch_failed` — `tenantId`, `membershipId`.
- `info` `tenant.slug_availability_checked` — `outcome` (`AVAILABLE`/`RESERVED`/`TAKEN`/`INVALID`), sem o slug.
- **Nunca logar:** e-mail completo do administrador, nome do administrador, CNPJ, tokens de convite, corpo do pedido, *claims* do token.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `backoffice.access` | `ACCESS` | Abertura da área por sessão e a cada *step-up* (concedida ou negada) | Auditoria de plataforma; `outcome`, `reasonCode`, `permissions`, `channel = WEB` |
| `tenant.provision` | `SYSTEM` | Conclusão (`SUCCESS`) ou falha de etapa (`FAILURE`) | Como na US-099, com `channel = BACKOFFICE`, `additionalOrganizations` (contagem), `idempotencyKey` |
| `tenant.activate` | `SYSTEM` | Ativação ao final do provisionamento | `changes`: `status`; `metadata`: `fromStatus`, `toStatus`, `channel` |
| `tenant.resend_invite` | `SYSTEM` | Reenvio do convite (`PLT-12`) | `metadata`: `channel`, `resendCount`, `invitationDispatched` |
| `access.denied` | `ACCESS` | Operador sem a permissão da rota, ou não operador em rota diferente de `PLT-09` | Auditoria de plataforma; `reasonCode` = permissão da rota |

## Testes necessários
- **Unitários:** `TenantSlug` (válidos, inválidos, reservados), sugestão de slug a partir do nome, órgãos adicionais (duplicidade, limite 5), ordenação da etapa `tenancy.additionalOrganizations`, allowlist de saída, máscara do e-mail, decisão de `backoffice.access` (concedida, negada por não operador, por falta de MFA, por falta de permissão).
- **Integração (Testcontainers PostgreSQL + Redis):** provisionamento completo com dois órgãos; reexecução sem nenhuma linha nova; falha injetada por etapa e retomada; `PLT-11` durante o provisionamento; `PLT-12` com limites; auditoria e outbox na mesma transação; operador relido do banco a cada requisição.
- **API/contrato:** `PLT-01..03` e `PLT-09..12` conforme `api.md`; `Location`, `ETag`, `Idempotent-Replayed`; **teste de allowlist: nenhuma rota de `/platform/*` devolve campo de processo, documento, comentário, anexo, valor, nome de usuário ou e-mail em claro**.
- **RBAC e multi-tenant:** não operador → 404 (web) e 403 (API); sem MFA → `MFA_REQUIRED`; operador sem a permissão; `ADMIN_ORGAO` em rota de plataforma; operador em rota de tenant → `MEMBERSHIP_INACTIVE`; seeders só no tenant novo (suíte `test/tenant-leak` com dois tenants); classificação das rotas no manifesto.
- **Concorrência:** mesmo slug em paralelo; mesma `Idempotency-Key` em processamento; operador desligado durante a sessão; dois reenvios simultâneos de convite.
- **E2E (Playwright):** operador entra com MFA, provisiona com dois órgãos, acompanha o checklist, vê o resultado; não operador vê 404; falha injetada e "Retomar"; convite não enviado e "Reenviar convite".
- **Acessibilidade/performance:** axe nas telas do assistente e do detalhe; lista com 1.000 tenants p95 ≤ 500 ms; provisionamento p95 ≤ 2 min na suíte de performance (medida no endurecimento).

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
- [ ] Teste de autorização: operador sem MFA recebe `MFA_REQUIRED` e nenhuma rota do backoffice devolve dado de processo ou documento
- [ ] Teste de que `/plataforma` e o menu não existem para não operador (404 idêntico ao de rota desconhecida)
- [ ] Guia do operador (acesso, provisionamento, retomada, reenvio de convite) publicado e runbook RB-12 atualizado com o canal web

## Estimativa
**L** — reaproveita a operação da US-099, mas entrega a área nova (layout, porta de entrada, sessão do operador no BFF, lista e detalhe), o assistente de quatro passos com acompanhamento e retomada, quatro endpoints novos, a extensão de três existentes, os órgãos adicionais e os testes de autorização do backoffice.

## Prioridade
**P1** — paga DT-07 e é a base das demais stories do backoffice (US-179 a US-181); sem ela o provisionamento continua só por CLI e API, aceitável com poucos pilotos, mas gargalo conforme a base de órgãos cresce.
