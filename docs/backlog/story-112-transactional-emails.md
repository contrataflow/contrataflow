---
id: US-112
title: "E-mails transacionais"
epic: EP-019
feature: FT-059
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-078, US-083]
modules: [notification]
screens: []
endpoints: []
permissions: []
events: []
---

# US-112 — E-mails transacionais

## Título
E-mails transacionais

## Descrição
**Como** usuário que não está com o produto aberto, **quero** receber por e-mail os avisos mais importantes (e o convite para entrar no tenant), **para** não perder prazos e aprovações só porque não olhei a central in-app.

Esta story entrega o `EmailSender`: o consumidor da fila `email` que renderiza o template pt-BR de cada `NotificationType` e envia via `MailProvider` (SMTP local em desenvolvimento, Amazon SES em produção — DEC-050), com retentativas, registro de falhas/bounces e idempotência. Também é o consumidor que efetivamente despacha o e-mail de convite de usuário (conteúdo definido pela US-091), compartilhando a mesma infraestrutura de envio.

## Contexto
- A central in-app (US-111) só ajuda quem abre o produto. Boa parte dos avisos urgentes (aprovação pendente, etapa atrasada, anexo rejeitado) precisa alcançar o usuário onde ele já está: o e-mail institucional.
- O envio de e-mail é tratado como "padrão B" de trabalho assíncrono (architecture/queues.md §1.1): o próprio registro (`Notification.emailStatus = PENDING` ou o convite pendente) é o estado durável; o `EmailSender` só executa o envio e atualiza o status — se o worker cair entre o commit e o envio, o reconciliador da fila reenfileira.
- `ROLE_CHANGED` e o convite de usuário (`UserInvited`, US-091) são os dois casos de e-mail **obrigatório** hoje no registro/produto; ambos passam por este consumidor, mas o convite nasce fora de `Notification` (events.md §4.6/queues.md §4.3) — esta story não define o conteúdo do convite, só garante o envio técnico.

## Objetivo
Entregar 99% dos e-mails elegíveis em até 5 minutos da criação da notificação (ou do convite), com toda falha permanente registrada em `emailError` e visível para o suporte, sem nunca duplicar envio por reentrega.

## Persona
- **Principal:** usuário destinatário de uma notificação com e-mail habilitado, ou convidado pendente (US-091).
- **Secundárias:** administrador do órgão (consulta falhas de entrega quando um usuário diz "não recebi o e-mail").

## Pré-condições
- Ambiente local provê um `MailProvider` de desenvolvimento (Mailpit — US-078); produção está configurada com Amazon SES e domínio com SPF/DKIM/DMARC válidos (DEC-050).
- Infraestrutura de filas em operação (US-083).
- Existe uma `Notification` com `emailStatus = PENDING` (US-111) ou um convite pendente (US-091) enfileirado em `email`.

## Fluxo principal
1. `NotificationDispatcher` (US-111) ou o caso de uso de convite (US-091) enfileira um job em `email` com `jobId` próprio (`notificationId` ou equivalente) e `JobData` mínimo (`{ kind: 'NOTIFICATION', notificationId }` ou `{ kind: 'INVITATION', membershipId }`).
2. O `EmailSender` consome o job no contexto do tenant (RLS) e carrega o registro de origem.
3. Para `kind = NOTIFICATION`: se `emailStatus` não é mais `PENDING` (já enviado ou pulado por outro worker), encerra sem efeito (idempotência). Caso contrário, resolve o destinatário (endereço do usuário, resolvido só agora — minimização), escolhe o template pt-BR do `NotificationType` e renderiza assunto + HTML + texto simples.
4. Para `kind = INVITATION`: delega à renderização definida pela US-091 (fora do escopo desta story) e segue o mesmo caminho de envio.
5. Chama o `MailProvider.send(...)`; em caso de aceite, grava `emailStatus = SENT` e `emailSentAt = now`.
6. Em caso de rejeição definitiva do provedor (endereço inválido, bounce), grava `emailStatus = FAILED` e `emailError` com a causa resumida.
7. Em caso de falha transitória (timeout, 5xx do provedor), o job falha e a fila `email` reaplica a política padrão (5 tentativas, backoff exponencial, base 5 s — DEC-163); esgotadas as tentativas, grava `FAILED`.
8. Métricas e logs de entrega alimentam o painel operacional (fora do escopo desta story) e o *circuit breaker* da fila (alerta com falha > 5% em 15 min — queues.md §12).

## Fluxos alternativos
- **FA-01 — E-mail desabilitado entre a criação e o envio:** se `notifications.emailEnabled` do tenant foi desligado depois que a notificação ficou `PENDING`, o `EmailSender` revalida antes de enviar e grava `SKIPPED` em vez de enviar.
- **FA-02 — Usuário sem e-mail válido cadastrado:** situação não esperada (e-mail é identificador de login); se ocorrer, grava `FAILED` com `emailError = "destinatário sem e-mail"` e loga `error` para investigação.
- **FA-03 — Template inexistente para um `NotificationType` novo:** grava `FAILED` com `emailError = "template ausente"` e loga `error` (alerta de operação); a notificação in-app não é afetada.
- **FA-04 — Tenant suspenso entre a criação e o envio:** `EmailSender` não envia (grava `SKIPPED`); a notificação in-app criada anteriormente permanece.
- **FA-05 — Bounce reportado pelo provedor após `SENT`:** registrado como atualização posterior de `emailError` (sem mudar `emailStatus` de volta — risco residual aceito, consistente com queues.md §4.3); processamento automático de *webhooks* de bounce do SES fica para fases futuras (ver Dependências).

## Regras de negócio
- **RN-NTF-13** — O `EmailSender` só processa `kind = NOTIFICATION` quando `Notification.emailStatus = 'PENDING'` no momento do envio; qualquer outro status é um no-op idempotente.
- **RN-NTF-14** — O endereço de e-mail do destinatário é resolvido no momento do envio, nunca persistido no payload do job (minimização de dados).
- **RN-NTF-15** — Cada `NotificationType` tem um template pt-BR (assunto + HTML + texto simples) cujo corpo nunca inclui dados sigilosos (POL-09), seguindo a mesma régua de conteúdo de RN-NTF-07.
- **RN-NTF-16** — Envio aceito pelo provedor → `emailStatus = SENT` + `emailSentAt`; rejeição definitiva (endereço inválido/bounce) → `emailStatus = FAILED` + `emailError` resumido (sem stack trace, sem corpo do e-mail).
- **RN-NTF-17** — Falhas transitórias seguem a política padrão da fila `email` (5 tentativas, backoff exponencial, base 5 s); esgotadas, `emailStatus = FAILED`.
- **RN-NTF-18** — Cabeçalhos técnicos obrigatórios: `Message-ID` derivado de `notificationId` (rastreio/deduplicação), `X-Correlation-Id`, `Auto-Submitted: auto-generated`.
- **RN-NTF-19** — Remetente autenticado no domínio do produto (SPF/DKIM/DMARC); `MailProvider` abstrai SMTP (dev) e Amazon SES (produção — DEC-050).
- **RN-NTF-20** — O conteúdo do e-mail de convite (`kind = INVITATION`) é definido pela US-091; esta story só garante entrega, retentativas e registro de falha para esse fluxo, pela mesma infraestrutura.
- **RN-NTF-21** — Taxa de envio limitada à cota do provedor (`EMAIL_RATE_PER_SECOND`, padrão 10/s), configurável por variável de ambiente, não por tenant.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | `emailStatus` | `EmailDeliveryStatus` (sistema) | — | RN-NTF-13/16 | atualizado pelo envio |
| — | `emailSentAt` | timestamptz (sistema) | — | RN-NTF-16 | preenchido no envio aceito |
| — | `emailError` | varchar(500) (sistema) | — | RN-NTF-16; sem dados sensíveis | preenchido na falha |
| *(job)* | `kind` | `'NOTIFICATION' \| 'INVITATION'` | Sim | RN-NTF-13/20 | gerado por US-111/US-091 |
| *(job)* | `notificationId` / `membershipId` | uuid | Condicional por `kind` | — | gerado por US-111/US-091 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `Notification` referenciada pelo job não existe mais (outro tenant/excluída) | Worker (interno) | — | — (log `error`; job concluído sem envio) |
| V-02 | `emailStatus` já não é `PENDING` | Worker (interno) | — | — (no-op idempotente) |
| V-03 | Template ausente para o tipo | Worker (interno) | — | — (`FAILED` + log `error`, alerta de operação) |
| V-04 | Provedor rejeita o destinatário (endereço inválido) | Worker (interno) | — | — (`FAILED` + `emailError`) |

## Permissões
- **Permissão:** não aplicável — consumidor assíncrono sem endpoint HTTP exposto; roda no contexto do tenant do job (RLS), sem ator humano.
- **Políticas:** POL-09 (conteúdo do e-mail nunca traz valores sigilosos).
- **MFA:** não aplicável.
- **Sem permissão:** não aplicável.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum. Esta story **consome** a fila `email`; não publica eventos de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| *(mesmos tipos de US-111 com e-mail elegível)* + convite de usuário (US-091) | Conforme events.md §6 / US-091 | EMAIL | Quando `emailStatus = PENDING` ou convite pendente |

## Critérios de aceite em Gherkin
```gherkin
Feature: E-mails transacionais

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "notifications.emailEnabled" verdadeiro
    And o usuário "Diego" tem e-mail "diego@pmsj.gov.br" e vínculo ativo

  Scenario: [Sucesso] Notificação pendente é enviada por e-mail
    Given que existe a notificação "N10" do tipo "APPROVAL_REQUESTED" para "Diego" com "emailStatus" igual a "PENDING"
    When o "EmailSender" processar o job correspondente
    Then o e-mail deve ser enviado pelo "MailProvider"
    And "emailStatus" deve mudar para "SENT" com "emailSentAt" preenchido

  Scenario: [Validação] Job com referência inexistente
    Given que o job referencia uma notificação que não existe mais
    When o "EmailSender" processar o job
    Then nenhum e-mail deve ser enviado
    And deve ser registrado log "error" sem travar a fila

  Scenario: [Permissão] E-mail desabilitado pelo tenant entre a criação e o envio
    Given que "notifications.emailEnabled" foi desligado após a notificação "N10" ficar "PENDING"
    When o "EmailSender" processar o job
    Then "emailStatus" deve mudar para "SKIPPED"
    And nenhum e-mail deve ser enviado

  Scenario: [Tenant incorreto] Tenant suspenso entre a criação e o envio
    Given que o tenant de "Diego" foi suspenso após a notificação "N10" ficar "PENDING"
    When o "EmailSender" processar o job
    Then nenhum e-mail deve ser enviado
    And "emailStatus" deve mudar para "SKIPPED"

  Scenario: [Duplicidade] Reentrega do job não envia duas vezes
    Given que a notificação "N10" já está com "emailStatus" igual a "SENT"
    When o job de envio para "N10" for reprocessado (reentrega at-least-once)
    Then nenhum novo e-mail deve ser enviado

  Scenario: [Concorrência] Dois workers pegam o mesmo job
    Given que dois workers tentam processar o job de "N10" simultaneamente
    When ambos lerem "emailStatus"
    Then apenas um deve conseguir transicionar de "PENDING" para "SENT"
    And o outro deve encerrar sem enviar e-mail duplicado

  Scenario: [Falha de banco] Banco indisponível ao gravar o status de envio
    Given que o banco de dados está indisponível após o provedor aceitar o e-mail
    When o "EmailSender" tentar gravar "emailStatus = SENT"
    Then o job deve falhar e ser reprocessado conforme a política da fila "email"

  Scenario: [Falha de integração] Provedor de e-mail indisponível
    Given que o "MailProvider" (SES/SMTP) está indisponível
    When o "EmailSender" tentar enviar o e-mail da notificação "N10"
    Then o job deve falhar e ser reprocessado com backoff exponencial
    And após esgotar as tentativas "emailStatus" deve mudar para "FAILED" com "emailError" preenchido
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| — (consumidor assíncrono, sem endpoint HTTP) | — | — | — | — |
| Falha permanente de envio | — | — | — | Suporte consulta `emailError`/logs; usuário não vê erro (a notificação in-app já existe) |

## Dependências
- **Stories:** US-078 (pré-requisito — ambiente local com `MailProvider` de desenvolvimento/Mailpit); US-083 (pré-requisito — infraestrutura de filas/outbox); US-111 (produtor dos jobs `kind = NOTIFICATION`); US-091 (dono do conteúdo e do disparo do convite; esta story só executa o envio).
- **Decisões/ADRs:** DEC-050 (SMTP/SES), DEC-161, DEC-163, DEC-138.
- **Configurações:** `notifications.emailEnabled`; variável de ambiente `EMAIL_RATE_PER_SECOND` (plataforma, não por tenant).
- **Lacunas nas fontes canônicas:** processamento automático de *webhook* de bounce/queixa do SES não está definido no MVP 1 (queues.md §4.3 já registra o risco residual de duplicidade); tratado aqui como melhoria futura, não como lacuna bloqueante — o conceito mais próximo hoje é a atualização manual de `emailError` por suporte.

## Impacto técnico
- Segundo consumidor assíncrono do produto (depois de `NotificationDispatcher`); reforça o padrão de trabalho B (architecture/queues.md §1.1) com estado durável em `Notification.emailStatus`.
- `MailProvider` é uma abstração estável (interface única) para permitir troca de provedor (SMTP ↔ SES) sem alterar `EmailSender`; é também o ponto único de teste de contrato com o provedor real.
- Rate limit de fila (`EMAIL_RATE_PER_SECOND`) é cota de plataforma, não de tenant — um tenant com muitos avisos pode consumir a cota de outros; aceito no MVP 1 (sem *fair-share* por tenant ainda).

## Backend
- **Módulo(s):** `notification` (dono do `EmailSender`); integra com `platform` (`MailProvider`, abstração SMTP/SES).
- **Casos de uso:** `SendTransactionalEmailJob` (consumidor da fila `email`).
- **Domínio:** `EmailTemplateRegistry` (um template por `NotificationType`, pt-BR); `MailMessage` (value object: assunto, HTML, texto, cabeçalhos técnicos).
- **Integrações internas:** lê `Notification` (US-111); para `kind = INVITATION`, delega a renderização ao conteúdo definido por US-091.
- **Transação:** leitura condicional (`WHERE email_status = 'PENDING'`) e atualização de `emailStatus`/`emailSentAt`/`emailError` em uma transação curta; a chamada ao `MailProvider` ocorre **fora** da transação de banco (I/O externo), com o resultado gravado depois.

## Frontend
- **Tela(s):** nenhuma tela própria — o resultado é visível indiretamente (o usuário recebe o e-mail no seu provedor).
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** os templates de e-mail seguem HTML acessível básico (texto alternativo, contraste, versão texto simples sempre enviada junto).

## Banco de dados
- **Tabelas:** `notifications` (atualização de `email_status`, `email_sent_at`, `email_error`); nenhuma tabela nova.
- **Migrações:** nenhuma (reaproveita `notifications` de US-111).
- **Índices/constraints relevantes:** `(email_status) WHERE email_status = 'PENDING'` (já previsto em US-111), usado pelo `EmailSender` para o reconciliador de órfãos (architecture/queues.md §1.1, padrão B).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| — | — | — | Sem endpoint HTTP; consumidor de fila (`email`) | — | — |

## Logs
- `info` `email.sent` — `notificationId` ou `membershipId`, `provider`, `durationMs`, `correlationId`.
- `warn` `email.retry` — `attempt`, `errorCode` resumido.
- `warn` `email.skipped` — motivo (`emailEnabled=false`, tenant suspenso).
- `error` `email.failed` — `errorCode` resumido, `correlationId` (nunca a resposta completa do provedor).
- **Nunca logar:** corpo renderizado do e-mail, endereço completo do destinatário (mascarado — DEC-138), credenciais SMTP/SES.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Envio de e-mail é operação de infraestrutura, não ação de usuário; não gera `AuditLog` (mesma lógica de US-111). |

## Testes necessários
- **Unitários:** `EmailTemplateRegistry` (um template por tipo, renderização sem dados sigilosos); cabeçalhos técnicos.
- **Integração (Testcontainers + Mailpit):** envio real em ambiente de teste; condição `WHERE email_status = 'PENDING'` sob concorrência; transição para `FAILED` após esgotar tentativas (fila com política reduzida em teste).
- **API/contrato:** não aplicável (sem endpoint HTTP); contrato do `MailProvider` testado com dublê (fake) e, em pipeline dedicado, contra Mailpit.
- **RBAC e multi-tenant:** job de um tenant nunca lê/atualiza `Notification` de outro (RLS); tenant suspenso não recebe e-mail.
- **Concorrência:** dois workers no mesmo job → um único envio.
- **E2E (Playwright):** fluxo completo notificação → e-mail capturado no Mailpit de teste, com assunto e link corretos.
- **Acessibilidade/performance:** HTML do e-mail validado (texto alternativo, contraste); 10 envios/s sustentados sem acumular atraso na fila.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (worker + E2E) e passando no CI
- [ ] Idempotência comprovada por teste de reentrega e de concorrência
- [ ] SPF/DKIM/DMARC configurados e verificados no domínio de produção
- [ ] Templates pt-BR de todos os tipos elegíveis a e-mail revisados por UX writing
- [ ] Logs sem dados sensíveis; métricas `email_sent_total`, `email_failed_total`, `email_skipped_total`
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] `MailProvider` testado contra Mailpit (dev) com plano de verificação equivalente para SES (produção)

## Estimativa
**M** — consumidor assíncrono com abstração de provedor, templates por tipo, retentativas e tratamento de falhas; sem UI própria, mas com requisitos de entregabilidade (SPF/DKIM/DMARC) que exigem configuração cuidadosa de infraestrutura.

## Prioridade
**P0** — sem e-mail, tipos obrigatórios como `APPROVAL_REQUESTED` e `ROLE_CHANGED` dependem só do usuário abrir o produto; é também o canal usado pelo convite (US-091), pré-requisito de todo onboarding.
