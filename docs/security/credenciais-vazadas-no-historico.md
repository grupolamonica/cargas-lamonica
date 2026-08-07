# Runbook — Credenciais vazadas no histórico do git (DC-283)

Dois casos. O primeiro veio da auditoria; o segundo foi descoberto pelo gitleaks no primeiro run.

---

# Caso 2 — Chave `service_role` de produção em `.claude/settings.local.json`

**Não estava no relatório da auditoria.** Apareceu no primeiro run da varredura de segredos: 38 achados (25 JWT + 13 header de autorização), todos neste arquivo.

O mais grave é um JWT com `role: service_role` do projeto de produção (`lbpzkdecwraipbjbaajs`), emitido em março/2026 e com validade até **2036**. É a chave que ignora RLS por completo — leitura e escrita irrestritas no banco de produção.

## Situação apurada

| Pergunta | Resposta |
|---|---|
| O arquivo ainda está rastreado? | **Não.** Foi untrackado em `be38724c` e está no `.gitignore` |
| O commit está na `main`? | **Não.** Não é alcançável por nenhuma branch, local ou remota |
| Então por que o CI achou? | Sobrevive em `refs/pull/*` do GitHub, que **persiste mesmo depois de apagar a branch** |
| A chave vazada ainda é a de produção? | **Não.** A impressão digital não bate com a que está no container hoje — já foi rotacionada |

## O que falta fazer

1. **Confirmar no painel do Supabase** que a chave antiga está *revogada*, e não apenas substituída. Impressões digitais diferentes provam que outra chave está em uso; não provam que a antiga morreu.
2. Se ainda estiver válida, revogar.
3. Não há como remover o commit de `refs/pull/*` por conta própria — apagar a branch não resolve. Removê-lo exige abrir chamado no suporte do GitHub. Com a chave revogada, o valor no histórico fica inerte e isso deixa de ser urgente.

## Por que isso passou

O `.claude/settings.local.json` guarda as permissões de ferramenta aprovadas, e cada entrada carrega o **comando inteiro** — incluindo `curl -H 'Authorization: Bearer <token>'`. Aprovar um comando com segredo embutido grava o segredo no arquivo. O arquivo hoje é gitignored, o que fecha a porta para frente.

---

# Caso 1 — Credencial do portal SPX/Agency (CRIT-1)

**Severidade:** crítica. **Este runbook não é executável por PR** — exige ação no portal externo e uma reescrita de histórico coordenada.

---

## O que aconteceu

A migration `backend/supabase/migrations/20260420120000_create_aspx_drivers.sql` fazia `INSERT` na tabela `aspx_credentials` com **login nominal, senha em texto puro e `device_id` reais** do portal SPX/Agency — o portal que guarda PII de motoristas.

O commit está em **todo o histórico do git**. Isso significa que a credencial está em:

- todo clone local do repositório, de qualquer pessoa que já clonou;
- todo cache de runner de CI que já rodou o checkout;
- qualquer fork, backup ou espelho.

## O que já foi feito

- O literal saiu da versão atual do arquivo: o seed agora cria o singleton vazio, no mesmo padrão de `brk_credentials` (PR do Bloco 4, DC-283).
- O gitleaks entrou no CI e **bloqueia segredo novo**. A ocorrência histórica está allowlistada **por caminho** em `.gitleaks.toml` — de propósito, porque escrever o segredo como regex de exceção apenas o recommitaria noutro arquivo.

## O que isso NÃO resolve

**Nada disso invalida a credencial.** Enquanto a senha não for trocada no portal, ela continua funcionando para quem tiver qualquer cópia do repositório. Remover o literal do arquivo é higiene, não contenção.

---

## Ordem de execução

A ordem importa: rotacionar antes de purgar. Se purgar primeiro, o histórico é reescrito mas a credencial antiga segue válida durante a janela — e a reescrita atrasa a única ação que realmente contém o risco.

### 1. Rotacionar no portal (contém o risco)

1. Trocar a senha da conta no portal SPX/Agency.
2. Se o portal permitir, invalidar o `device_id` registrado e emitir um novo.
3. Gravar os novos valores direto no banco de produção — **sem passar pelo repositório**:

   ```sql
   UPDATE public.aspx_credentials
      SET email = '...', password = '...', device_id = '...', updated_at = now()
    WHERE id = 1;
   ```

4. Confirmar que o `aspx-sync` e o `spx-bot` voltam a autenticar (o login headless na VPS renova o cookie — ver o keep-alive do spx-bot).

### 2. Revisar acesso enquanto isso

Vale checar no portal se há sessão ou acesso que não reconheça, no período em que a credencial esteve exposta. O repositório é privado, o que reduz — mas não elimina — o alcance.

### 3. Purgar o histórico (opcional, coordenado)

Operação **destrutiva**: reescreve todos os SHAs e obriga todo mundo a re-clonar. PRs abertos precisam ser rebaseados ou refeitos.

Só faz sentido depois do passo 1. Antes de decidir, pesar: com a credencial já rotacionada, o valor no histórico é inerte, e o custo da reescrita (re-clone de todo o time, PRs abertos quebrados, tags e releases apontando para SHAs mortos) pode superar o ganho.

Se for feito, `git filter-repo` é a ferramenta atual (o `filter-branch` está descontinuado).

### 4. Fechar o ciclo

Depois de rotacionar **e** purgar:

1. Remover a entrada allowlistada de `.gitleaks.toml` (a linha do caminho desta migration).
2. Rodar o CI e confirmar que o job `security` segue verde.
3. Se seguir verde, a dívida está encerrada. Se acusar, a purga não pegou tudo.

---

## Por que a allowlist existe

Sem ela, o gitleaks reprova **todo PR** por causa de um segredo que ninguém consegue remover dentro de um PR. O resultado previsível é o time desabilitar a varredura — e aí o repositório fica pior do que antes, porque passa a aceitar segredos novos em silêncio.

A allowlist é estreita (um caminho de arquivo), documentada, e tem condição de saída explícita. É dívida registrada, não dívida escondida.
