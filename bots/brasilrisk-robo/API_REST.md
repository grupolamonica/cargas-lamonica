# API REST do BRK — consumo externo (ex.: VPS)

Endpoint que **outro sistema** (ex.: backend na VPS) chama por HTTP pra consultar
aptidão no BRK. A sessão/cookie do BRK fica **só nesta máquina** (Chrome dedicado
via CDP) — a VPS **não** precisa de cookie, só chama o endpoint.

## Endpoint
```
GET http://<IP-DA-MAQUINA-DO-CADASTRO>:5010/api/brk/consultar
```
(`5010` = `PORT` do bot; o bot escuta em `0.0.0.0`.)

### Autenticação (obrigatória)
Header **`X-API-Key: <BRK_API_KEY>`** (também aceita `Authorization: Bearer <key>` ou `?api_key=`).
Defina `BRK_API_KEY` no `.env` da máquina do cadastro (gere forte:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) e
**reinicie o bot**. Use a mesma key como secret na VPS.

### Parâmetros (query)
| Param | Ex. | Obs. |
|---|---|---|
| `cpf` | `35402946515` | motorista (só dígitos ou formatado) |
| `placa` | `RPM3H73` | repita para vários: `&placa=RPM3H73&placa=QTV1I74` |

Informe `cpf` e/ou `placa(s)`.

### Resposta (200)
```json
{
  "ok": true,
  "conjunto_apto": true,
  "status": "vigente",
  "color": "emerald",
  "label": "Apto · vence 27/07/2026",
  "componentes": {
    "motorista": { "status": "vigente", "label": "Apto · vence 10/09/2026", "color": "emerald" },
    "cavalo":    { "status": "vigente", "label": "Apto · vence 28/10/2026", "color": "emerald" },
    "carreta":   { "status": "vigente", "label": "Apto · vence 27/07/2026", "color": "emerald" }
  },
  "consultado_em": "2026-06-30T..."
}
```
- `conjunto_apto`: `true` só quando **tudo** está apto.
- `status` por componente: `vigente` (apto) · `expirado` (vencido) · `nao_conforme` (inapto) · `nao_cadastrado` (não tem) · `erro`.
- Erros: `401` key inválida · `400` faltou cpf/placa · `503` `BRK_API_KEY` não configurada · `500` falha na consulta.

## Exemplos
**curl**
```bash
curl -H "X-API-Key: SUA_KEY" \
  "http://10.0.0.5:5010/api/brk/consultar?cpf=35402946515&placa=RPM3H73&placa=QTV1I74"
```
**Node (VPS)**
```js
const r = await fetch(`${BRK_HOST}/api/brk/consultar?cpf=${cpf}&placa=${cavalo}&placa=${carreta}`,
  { headers: { 'X-API-Key': process.env.BRK_API_KEY } });
const j = await r.json();
if (j.conjunto_apto) { /* liberar */ }
```
**Python (VPS)**
```python
import requests
r = requests.get(f"{BRK_HOST}/api/brk/consultar",
    params={"cpf": cpf, "placa": [cavalo, carreta]},
    headers={"X-API-Key": BRK_API_KEY}, timeout=40)
data = r.json()
```

## Segurança / rede (importante p/ VPS)
- **Chame do BACKEND da VPS**, nunca do browser (a API key não pode ir pro front).
- Exponha o `5010` com cuidado: idealmente atrás de **HTTPS** (reverse proxy) e
  com **allowlist de IP** (só a VPS) ou via túnel/VPN. A `BRK_API_KEY` é a defesa
  no nível de aplicação; rede é camada extra.
- Pré-requisito p/ retornar status real: o **cookie automático (CDP)** rodando
  nesta máquina (ver `COOKIE_AUTOMATICO.md`) + Chrome dedicado logado.

## O que sobe pro GitHub
Vai: o código (`lib/brasilrisk_consulta.js`, endpoint no `bot_cadastro.js`,
scripts). **NÃO vai** (já no `.gitignore`): `cookie.txt`, `useragent.txt`,
`.chrome-brk/`, `.env`. Configure `BRK_API_KEY` no `.env` de cada máquina.
