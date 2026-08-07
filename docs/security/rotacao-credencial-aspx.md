# Runbook — Rotação da credencial SPX/Agency vazada (DC-283 / CRIT-1)

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
