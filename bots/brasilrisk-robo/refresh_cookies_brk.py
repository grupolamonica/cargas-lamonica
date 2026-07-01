"""refresh_cookies_brk.py — renova o cookie do BRK lendo direto do Chrome logado.

Mesma logica do SPX (spx-robo/refresh_cookies_spx.py): le os cookies do dominio
brasilrisk.com.br do Chrome (via browser_cookie3), monta o header `Cookie` e grava
em backend/cookie.txt. O painel (lib/brasilrisk_consulta.js) detecta a mudanca do
arquivo e recarrega sozinho — nao precisa reiniciar o bot.

Requisito: estar LOGADO no BRK (br2.brasilrisk.com.br) no Chrome desta maquina.
Dependencia: browser_cookie3 (o .bat instala automaticamente se faltar).

OBS: o Chrome recente pode usar "App-Bound Encryption" nos cookies; nesse caso o
browser_cookie3 pode nao conseguir descriptografar. Se falhar, exporte manualmente
(extensao Cookie-Editor -> Export) e cole o header em backend/cookie.txt.
"""
from __future__ import annotations

import sys
from pathlib import Path

DOMAIN = "brasilrisk.com.br"
BACKEND = Path(__file__).resolve().parent / "backend"
COOKIE_FILE = BACKEND / "cookie.txt"
UA_FILE = BACKEND / "useragent.txt"
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
# cookies que sinalizam sessao / Cloudflare
AUTH_HINTS = ("ASPXAUTH", "ASP.NET_SessionId", "cf_clearance", "BRSystem", "__RequestVerification")


def main() -> int:
    try:
        import browser_cookie3
    except ImportError:
        print("[erro] browser_cookie3 nao instalado. Rode:  pip install browser_cookie3")
        return 2

    try:
        jar = browser_cookie3.chrome(domain_name=DOMAIN)
    except Exception as exc:
        print(f"[erro] nao consegui ler os cookies do Chrome: {exc}")
        print("       (Chrome recente pode bloquear a leitura — use o export manual nesse caso.)")
        return 3

    pares, nomes = [], []
    for c in jar:
        if DOMAIN not in (c.domain or ""):
            continue
        if c.name and c.value is not None:
            pares.append(f"{c.name}={c.value}")
            nomes.append(c.name)

    if not pares:
        print(f"[erro] nenhum cookie de {DOMAIN} no Chrome. Voce esta LOGADO no BRK nesse Chrome?")
        return 4

    auth_like = [n for n in nomes if any(h.lower() in n.lower() for h in AUTH_HINTS)]
    if not auth_like:
        print(f"[aviso] {len(pares)} cookies lidos, mas nenhum parece ser de sessao "
              f"({', '.join(AUTH_HINTS)}). A sessao pode nao validar — confirme o login no Chrome.")

    header = "; ".join(pares)
    BACKEND.mkdir(parents=True, exist_ok=True)
    tmp = COOKIE_FILE.with_suffix(".txt.tmp")
    tmp.write_text(header, encoding="utf-8")
    tmp.replace(COOKIE_FILE)
    # Cria um UA padrao 1x (nao sobrescreve se voce ja ajustou pra bater com o Chrome).
    if not UA_FILE.exists():
        UA_FILE.write_text(DEFAULT_UA, encoding="utf-8")

    print(f"[ok] {len(pares)} cookies salvos em {COOKIE_FILE}  (auth-like: {len(auth_like)})")
    if "cf_clearance" in nomes:
        print("[ok] cf_clearance presente (Cloudflare).")
    else:
        print("[aviso] cf_clearance ausente — se o BRK exigir Cloudflare, a consulta pode falhar.")
    print("[dica] se a consulta falhar por Cloudflare, ajuste backend/useragent.txt pra bater "
          "com o seu Chrome (veja em chrome://version).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
