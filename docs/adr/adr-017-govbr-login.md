# ADR-017 — Login gov.br federado no Authentik

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-11-10 |
| **Decisores** | Arquitetura/Tech Lead, Produto, Segurança |
| **Decisões relacionadas** | DEC-207 (resolve PEND-18), DEC-130 (OIDC com Authentik), DEC-187 (login nativo), DEC-012 (identidade global + vínculo), DEC-133 (MFA), DEC-086 e DEC-140 (dados pessoais e LGPD) |
| **Documentos** | [ADR-003](adr-003-authentication.md) e o adendo de 2026-10-28 · [authentication.md](../architecture/authentication.md) · [mvp-01/screens.md](../mvp-01/screens.md) (SCR-001: botão gov.br "em breve") |

## Contexto

- Servidores públicos já têm conta gov.br, e muitos órgãos preferem que o acesso a sistemas use essa identidade. O login gov.br ficou fora do MVP 1 (PEND-18).
- Toda a autenticação passa pelo Authentik (DEC-130): o ContrataFlow só fala OIDC com ele, e a API valida tokens pelo JWKS do Authentik. Desde a DEC-187, usuário e senha são digitados numa tela do próprio ContrataFlow e o BFF conduz o *flow* pela API do executor — esse caminho não serve para federação, que exige levar o navegador ao provedor externo.
- Identidade não é acesso: o vínculo com o tenant (`TenantMembership`) é o que dá acesso (DEC-012).
- O gov.br informa níveis de confiabilidade da conta (bronze, prata, ouro) e o CPF como identificador; integrar exige credenciamento do sistema no Login Único.

## Decisão

1. **gov.br como fonte OIDC no Authentik** (*OAuth Source*), com os escopos de identificação, e-mail e níveis de confiabilidade. O ContrataFlow não fala diretamente com o gov.br; tokens do gov.br nunca chegam ao BFF nem à API.
2. **Entrada pelo navegador:** o botão "Entrar com gov.br" em `/entrar` chama uma rota do BFF que inicia o Authorization Code + PKCE de sempre no Authentik já direcionado à fonte gov.br; o navegador vai ao gov.br, volta ao Authentik e ao callback do BFF. Sessão, cookie e validação na API não mudam (ADR-003).
3. **Vínculo da identidade:** o Authentik associa a identidade gov.br a um usuário existente somente quando (a) a pessoa, já autenticada, vincula a conta gov.br em "Meu perfil", ou (b) o CPF do gov.br confere com o CPF cadastrado no usuário. Sem vínculo, a entrada é recusada com orientação ("Peça ao administrador do seu órgão o convite" / "Vincule sua conta gov.br em Meu perfil"). gov.br **nunca cria** usuário nem vínculo de tenant.
4. **CPF:** guardado como HMAC (chave da plataforma) para comparação e com máscara para exibição; não vai para logs (DEC-138, DEC-086).
5. **Níveis de confiança** como atributo: o nível vem como *claim* do Authentik, fica na sessão (`govbrTrustLevel`) e na auditoria do login; nenhuma regra o exige no MVP 2. O tenant pode, opcionalmente, aceitar o nível prata/ouro como segundo fator para a política de MFA (DEC-133) — desligado por padrão.
6. **Habilitação por tenant** (`auth.govbrEnabled`, padrão desligado) e por ambiente (credenciais da fonte no Secrets Manager). Sem credenciamento no Login Único, a fonte não é criada e o botão não aparece.

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| BFF integrado direto ao gov.br | Sem configuração no Authentik | Dois IdPs para a API validar; duplica sessão, MFA e auditoria de login | **Rejeitada:** contra a DEC-130 |
| Conduzir o gov.br pelo executor de fluxos (como o login nativo) | Mesma tela | Federação exige redirecionar o navegador ao provedor; não há como conduzir no servidor | **Rejeitada:** inviável |
| Criar usuário automaticamente no primeiro login gov.br | Menos atrito | Identidade virando acesso; risco de contas órfãs e de vínculo com a pessoa errada | **Rejeitada** |
| **Fonte federada no Authentik + vínculo explícito ou por CPF** | Reaproveita sessão, MFA, auditoria e validação existentes | Depende do credenciamento externo; CPF passa a ser dado guardado | **Adotada** |

## Consequências

**Positivas**
- Login com a conta que o servidor já usa, sem mudar a API nem a sessão.
- Nível de confiança disponível para políticas futuras.

**Negativas**
- Dependência externa (credenciamento e disponibilidade do gov.br) — indisponibilidade do gov.br afeta só quem entra por ele; usuário e senha continuam funcionando.
- CPF passa a ser guardado (em HMAC) — inventário de dados e termos atualizados.
- A tela `/entrar` passa a ter dois caminhos, com mensagens próprias para recusa por falta de vínculo.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Vínculo com o usuário errado | Vínculo só por ação da própria pessoa autenticada ou por CPF igual ao cadastrado; auditoria do vínculo; desvincular em "Meu perfil" |
| Mudança de contrato do Login Único | Integração isolada na fonte do Authentik; teste de fumaça em homologação do gov.br |
| Indisponibilidade do gov.br | Mensagem clara e login por usuário e senha mantido |
| Exposição do CPF | HMAC, máscara, fora de logs; acesso ao CPF em claro nenhum no sistema |

## Critérios de revisão

- Órgão exigir nível mínimo de confiança → ativar política por tenant sobre `govbrTrustLevel`.
- Demanda por outros provedores federados (Entra ID do órgão) → mesma abordagem de fonte no Authentik.
- Assinatura eletrônica gov.br no MVP 3 → reavaliar o uso do mesmo credenciamento.

## Referências

- Internas: DEC-012, DEC-086, DEC-130, DEC-133, DEC-138, DEC-140, DEC-187, DEC-207; PEND-18; [ADR-003](adr-003-authentication.md).
- Documentação do Login Único gov.br (integração OIDC e níveis de confiabilidade).
