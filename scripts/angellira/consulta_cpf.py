import os
import re
import sys
import time
from datetime import datetime

import requests

sys.stdout.reconfigure(encoding="utf-8")

USUARIO = os.getenv("ANGELLIRA_USER", "").strip()
SENHA = os.getenv("ANGELLIRA_PASSWORD", "").strip()
EMPRESA_ID = os.getenv("ANGELLIRA_EMPRESA_ID", "").strip()


def validar_configuracao():
    missing = [
        env_name
        for env_name, value in (
            ("ANGELLIRA_USER", USUARIO),
            ("ANGELLIRA_PASSWORD", SENHA),
            ("ANGELLIRA_EMPRESA_ID", EMPRESA_ID),
        )
        if not value
    ]

    if missing:
        print(f"❌ Variáveis ausentes: {', '.join(missing)}")
        return False

    return True


def obter_token_automatico():
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        },
    )

    try:
        print("🔑 Efetuando login inicial...")
        res_login = session.post(
            "https://auth.angellira.com.br/auth",
            json={"login": USUARIO, "pass": SENHA, "lang": "pt-br"},
            timeout=15,
        )

        if res_login.status_code != 200:
            print(f"❌ Erro no login: {res_login.status_code}")
            return None

        print("🔑 Solicitando token final (grant)...")

        payload_grant = {
            "company": EMPRESA_ID,
            "user": '{"userName":"","userId":-1}',
        }

        headers_grant = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://auth.angellira.com.br",
            "Referer": f"https://auth.angellira.com.br/grant?client=Angellira&scope=&company={EMPRESA_ID}",
        }

        res_grant = session.post(
            "https://auth.angellira.com.br/auth/grant",
            data=payload_grant,
            headers=headers_grant,
            timeout=15,
            allow_redirects=True,
        )

        token = None

        try:
            token = res_grant.json().get("token")
        except Exception:
            token = None

        if not token:
            url_final = res_grant.url
            if "access_token=" in url_final:
                token = url_final.split("access_token=")[1].split("&")[0]
            elif "token=" in url_final:
                token = url_final.split("token=")[1].split("&")[0]

        if token:
            print("✅ Token obtido automaticamente!")
            return token

        print(f"❌ Falha no grant. Status: {res_grant.status_code}")
        print(f"URL final: {res_grant.url}")
        print(f"Resposta bruta: {res_grant.text[:200]}...")
        return None

    except Exception as error:
        print(f"💥 Erro: {error}")
        return None


def limpar_cpf(cpf):
    return re.sub(r"\D", "", str(cpf))


def buscar_perfil(cpf, token):
    url = "https://api.angellira.com.br/profile/query"
    params = {
        "q": limpar_cpf(cpf),
        "detailed": "true",
        "since": "2000-01-01",
        "qFor": "cpf",
        "sort[]": "-sentDate",
    }
    headers = {"Authorization": f"Bearer {token}"}
    try:
        response = requests.get(url, headers=headers, params=params, timeout=15)
        return response.json() if response.status_code == 200 else None
    except Exception:
        return None


def executar():
    if not validar_configuracao():
        return

    token = obter_token_automatico()
    if not token:
        return

    cpfs_para_consultar = ["036.787.626-46"]

    print(f"\n{'=' * 60}\n🚚 CONSULTA INICIADA\n{'=' * 60}")

    for cpf in cpfs_para_consultar:
        print(f"🔍 CPF: {cpf}", end=" ", flush=True)

        result = None
        for _ in range(3):
            result = buscar_perfil(cpf, token)
            if result and result.get("data"):
                break
            time.sleep(2)

        if result and result.get("data"):
            item = result["data"][0]
            history = item.get("history", {}) or {}
            driver = item.get("driver", {}) or {}
            nome = history.get("driverName") or driver.get("name", "N/A")
            status = item.get("status", {}).get("description", "N/A")

            raw_sent_date = item.get("sentDate", "")
            formatted_sent_date = "N/A"
            if raw_sent_date:
                try:
                    dt = datetime.fromisoformat(raw_sent_date.replace("Z", "+00:00"))
                    formatted_sent_date = dt.strftime("%d/%m/%Y %H:%M")
                except Exception:
                    formatted_sent_date = raw_sent_date

            validity_raw = item.get("limitDate", "N/A")
            validity = validity_raw
            if "T" in str(validity_raw):
                try:
                    dt_validity = datetime.fromisoformat(validity_raw.replace("Z", "+00:00"))
                    validity = dt_validity.strftime("%d/%m/%Y")
                except Exception:
                    validity = validity_raw.split("T")[0]

            print(
                f"-> {nome.strip()} | ✅ {status} | 📆 Vigência: {validity} | 🕒 Última atualização: {formatted_sent_date}",
            )
        else:
            print("-> Não encontrado após 3 tentativas.")

        time.sleep(1.2)


if __name__ == "__main__":
    executar()
