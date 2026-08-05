# Runbook — resposta automática de chamados do GLPI

Como ligar, operar e desligar a automação que responde chamados do GLPI assim que a
correção chega em produção.

---

## 1. O que a automação faz

A cada ciclo, o worker:

1. Descobre qual commit está rodando em produção (último deploy verde no GitHub).
2. Varre os commits até esse ponto procurando o trailer `Chamado: GLPI #N`.
3. Lê a comprovação em `docs/chamados/N.md`.
4. Anexa a comprovação no chamado, publica a resposta e marca como **Solucionado**.

Ela responde **sozinha**, sem revisão humana — foi a decisão tomada em 05/08/2026.
As travas da seção 6 fazem o papel do revisor.

## 2. Por que roda na máquina do time, e não na VPS

O GLPI está na rede interna (`10.100.100.6`). Medição de 05/08/2026:

| Origem | Alcança o GLPI? |
|---|---|
| VPS de produção (76.13.169.177) | **Não** — `curl` devolve `http_code=000`, timeout |
| Runner do GitHub Actions | **Não** — internet pública para rede privada |
| Máquina do time (dentro da rede) | **Sim** |

Não é preferência de arquitetura: é o único lugar de onde dá para falar com o GLPI.

## 3. Pré-requisitos (uma vez só)

### 3.1 Ligar a API REST do GLPI

Vem **desligada de fábrica**. Em **Configurar → Geral → aba API**:

- "Ativar a API REST" = **Sim**
- Se houver filtro de IP no cliente de API, liberar o IP da máquina que vai rodar o
  worker.

Conferir com:

```bash
node scripts/smoke-glpi.mjs
```

Enquanto estiver desligada, o smoke responde `GLPI_API_DISABLED` e diz onde ligar.

### 3.2 Gerar os dois tokens

O GLPI não autentica com um só:

| Token | Onde gerar |
|---|---|
| `GLPI_APP_TOKEN` | Configurar → Geral → API → **Adicionar cliente de API** |
| `GLPI_USER_TOKEN` | Perfil do usuário técnico → **Chave de API remota** |

Use um **usuário técnico** dedicado: é o nome que vai assinar as respostas nos
chamados. Não use credencial de AD (login/senha) — a automação não aceita esse
formato de propósito.

### 3.3 Preencher o `.env`

Em `backend/.env` (local, **nunca** commitado):

```
GLPI_APP_TOKEN=...
GLPI_USER_TOKEN=...
```

Sem os dois, o worker sai com código 2 e não faz nada.

## 4. Como marcar um chamado como resolvido por um PR

Duas coisas, ambas dentro do PR da correção:

**1. Trailer no commit** (na última linha, junto do `Co-Authored-By`):

```
Chamado: GLPI #40
```

Só o trailer exato conta. Menção solta no texto ("mesma causa do chamado 40") é
ignorada de propósito — a automação nunca deduz qual chamado alguém quis dizer.

**2. Arquivo de comprovação** em `docs/chamados/40.md`:

```markdown
# Chamado #40 — título curto

## Resposta ao operador

Texto em linguagem de quem abriu o chamado: o que acontecia, o que mudou,
como conferir na tela. Sem nome de arquivo, sem código de LH, sem termo técnico.

## Comprovação

Tabelas, antes/depois, contagens medidas em produção.
```

A seção **"Resposta ao operador"** é o que o operador lê. O **arquivo inteiro** vai
como anexo. Por isso a comprovação técnica pode ser longa sem poluir a leitura.

Sem esse arquivo — ou sem essa seção — o chamado **não é respondido**.

## 5. Agendar na máquina (Windows)

Registrar uma tarefa que roda de hora em hora:

```powershell
$repo = "C:\Users\antonio.magalhaes\Documents\Projetos\produção\Cargas_Lamonica"
$acao = New-ScheduledTaskAction -Execute "node" -Argument "scripts\glpi-worker.mjs" -WorkingDirectory $repo
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "GLPI-resposta-automatica" -Action $acao -Trigger $gatilho -Description "Responde chamados do GLPI cuja correcao ja esta em producao"
```

Ver, rodar na hora e remover:

```powershell
Get-ScheduledTask -TaskName "GLPI-resposta-automatica"
Start-ScheduledTask -TaskName "GLPI-resposta-automatica"
Unregister-ScheduledTask -TaskName "GLPI-resposta-automatica" -Confirm:$false
```

A máquina precisa estar ligada e dentro da rede na hora do ciclo. Perder um ciclo
não perde nada: o próximo pega o mesmo chamado.

## 6. As travas (o que faz o papel do revisor humano)

Todas falham para o lado de **não responder**:

| Trava | O que impede |
|---|---|
| Só commit **deployado** | Responder antes da correção estar no ar |
| Só trailer **explícito** | Responder o chamado errado por dedução |
| **Sem comprovação, não responde** | "Resolvido" sem prova nenhuma |
| **Anexo antes da solução** | "Resolvido, veja o anexo" sem anexo |
| Chamado já solucionado/fechado é ignorado | Reabrir ou re-responder o que um humano concluiu |
| Marca no histórico do chamado | Notificar o operador em série a cada ciclo |

A idempotência vive no **próprio GLPI** (uma marca invisível no histórico), não num
arquivo de estado local — então não há o que corromper ou dessincronizar.

## 7. Operação do dia a dia

```bash
node scripts/glpi-worker.mjs --dry-run     # mostra o que faria, sem escrever nada
node scripts/glpi-worker.mjs               # ciclo normal
node scripts/glpi-worker.mjs --dias 60     # amplia a janela de commits (padrão 30)
node scripts/glpi-worker.mjs --chamado 40  # força um chamado específico
```

`--chamado` serve para chamados corrigidos **antes** desta automação existir, cujo
commit não tem o trailer. O arquivo de comprovação continua obrigatório.

Saída típica:

```
produção: 2c23be29 (último deploy verde) · janela: 30 dias
#40  RESPONDIDO e marcado como Solucionado (anexo: docs/chamados/40.md)

resumo: 1 respondido(s) · 0 já tratado(s) · 0 sem comprovação · 0 erro(s)
```

## 8. Desligar

Qualquer um destes basta, do mais leve ao mais definitivo:

1. `Unregister-ScheduledTask -TaskName "GLPI-resposta-automatica" -Confirm:$false`
2. Apagar `GLPI_APP_TOKEN`/`GLPI_USER_TOKEN` do `backend/.env` — o worker sai sem agir.
3. Desativar a API REST no GLPI — corta para qualquer cliente.

## 9. Diagnóstico

| Mensagem | Causa | O que fazer |
|---|---|---|
| `GLPI não configurado` | falta token no `.env` | seção 3.2 |
| `GLPI_API_DISABLED` | API REST desligada | seção 3.1 |
| `GLPI_UNAUTHORIZED` | token errado, ou filtro de IP barrando | regerar token / liberar IP |
| `GLPI_SOURCE_TIMEOUT` | máquina fora da rede interna | conectar na rede/VPN |
| `SEM PROVA` | falta `docs/chamados/N.md` no commit deployado | criar o arquivo (seção 4) |
| `PROVA INVÁLIDA` | falta a seção "Resposta ao operador" | seção 4 |
| `ignorado (ja_respondido)` | já respondido antes | nada — é a idempotência funcionando |
| `ignorado (ja_fechado)` | alguém já concluiu o chamado | nada |

---

**Convenção relacionada:** todo chamado atendido também vira card no Jira (projeto
**DC**) — ver [`JIRA-WORKFLOW.md`](../JIRA-WORKFLOW.md).
