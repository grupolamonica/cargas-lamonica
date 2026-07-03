# Conectar o VPS ao BRK do SERVERBD (`:5010`)

O backend (VPS, produção) consulta a aptidão BRK chamando o endpoint
`GET /api/brk/consultar` do bot que roda no **SERVERBD** (`10.100.100.6:5010`).
O VPS **não alcança** esse IP interno (LAN) — este runbook cria o caminho.

> ⚠️ O `cf_clearance` do BRK é amarrado ao IP: a **consulta continua saindo do
> SERVERBD** (mesmo IP do login). O túnel só carrega a chamada HTTP VPS→SERVERBD.

Pré-requisitos já prontos: migrations aplicadas, `BRK_API_KEY` no GitHub + no
`.env` do SERVERBD, e o deploy injeta `BRK_BASE_URL`/`BRK_API_KEY`/`BRK_SYNC_ENABLED`
quando os secrets existem (ver `.github/workflows/deploy.yml`).

---

## Opção A (recomendada quando o `C:` do SERVERBD tiver espaço): Cloudflare Tunnel

Sem porta aberta, sem mudança no VPS, HTTPS ponta a ponta. Requer `cloudflared`
instalado no SERVERBD (por isso depende de liberar o `C:` a 0GB) + conta Cloudflare.

1. No SERVERBD: instalar `cloudflared`, autenticar, criar tunnel apontando para
   `http://localhost:5010`, publicá-lo num hostname (ex.: `brk.grupolamonica.com`).
2. Rodar o `cloudflared` como serviço (sobrevive a reboot).
3. Definir o secret no GitHub: `BRK_BASE_URL=https://brk.grupolamonica.com`.
4. Re-deploy (merge na main) → o backend passa a alcançar o BRK por HTTPS.

## Opção B (hoje, sem instalar nada / sem conta): túnel SSH reverso

O SERVERBD **disca pro VPS** e publica o `:5010` no host do VPS. Não abre porta na
internet. Usa o OpenSSH client (já vem no Windows) — imune ao `C:` cheio.

### B1. No SERVERBD — gerar chave dedicada do túnel (1x)
```powershell
ssh-keygen -t ed25519 -C "brk-tunnel@serverbd" -f "$env:USERPROFILE\.ssh\brk_tunnel" -N ""
type "$env:USERPROFILE\.ssh\brk_tunnel.pub"   # copie a pública
```

### B2. No VPS — autorizar a chave, restrita a encaminhamento (usuário `samuel`)
```bash
# em ~/.ssh/authorized_keys, prefixe a chave do SERVERBD com restrições:
# no-pty,no-X11-forwarding,permitlisten="0.0.0.0:5011",command="/bin/false" ssh-ed25519 AAAA... brk-tunnel@serverbd
```
E habilitar o bind em interface acessível ao container (requer root):
```bash
sudo sed -i 's/^#\?GatewayPorts.*/GatewayPorts clientspecified/' /etc/ssh/sshd_config
sudo systemctl reload ssh
# firewall: NÃO exponha o 5011 na internet — só o Docker precisa dele
sudo ufw deny 5011/tcp || true
```

### B3. No SERVERBD — subir o túnel resiliente (tarefa agendada / loop)
```powershell
# publica o :5010 local no host do VPS em 0.0.0.0:5011 (alcançável pelo container
# via host.docker.internal; bloqueado pra internet pelo ufw acima)
ssh -i "$env:USERPROFILE\.ssh\brk_tunnel" -N `
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
    -R 0.0.0.0:5011:localhost:5010 samuel@76.13.169.177
```
Envolver num loop/Tarefa Agendada pra reconectar se cair (mesmo padrão do keep-alive).

### B4. No GitHub — apontar o backend pro túnel
```
BRK_BASE_URL = http://host.docker.internal:5011
```
(o `docker-compose.yml` já dá ao backend o `extra_hosts: host.docker.internal:host-gateway`).
Re-deploy (merge na main) → o backend alcança o BRK pelo túnel.

---

## Validar (no VPS, após qualquer opção)
```bash
cd /opt/apps/lamonica
grep -E "^BRK_" backend.env                       # BRK_BASE_URL/API_KEY/SYNC_ENABLED presentes
# de dentro do container backend:
docker compose exec backend sh -lc 'curl -s -H "X-API-Key: $BRK_API_KEY" "$BRK_BASE_URL/api/brk/consultar?cpf=01230714618&placa=EJY4C08" | head -c 200'
```
Deve retornar JSON com `"ok":true`. A partir daí o badge BRK preenche nas candidaturas
(e o backfill retroativo é o `backfill_brk_supabase.js`).
