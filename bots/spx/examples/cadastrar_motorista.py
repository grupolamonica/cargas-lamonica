"""Exemplo: cadastrar motorista via cliente Python (sem sidecar).

Rode com:
    cd spx-robo
    python -m pip install -r requirements.txt
    python examples/cadastrar_motorista.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# tornar o package importavel quando rodado direto
ROOT = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT.parent / ".env")

from spx_robo.client import SPXClient
from spx_robo import flow_motorista, lookups, constants as K


def main():
    client = SPXClient()  # le SPX_COOKIE_FILE do .env automaticamente

    # 1. Verifica sessao
    if not client.ping():
        print("ERRO: sessao invalida. Reexporte cookies do Chrome.")
        return

    # 2. (debug) lista cidades de Fortaleza
    fortaleza = lookups.fetch_cities(client, city_name="Fortaleza", limit=3)
    print(f"Cidades 'Fortaleza' encontradas: {[c.get('city_name') for c in fortaleza]}")

    # 3. (debug) lista tipos de veiculo
    types = lookups.fetch_vehicle_types(client)
    print(f"Vehicle types disponiveis: {[t.get('vehicle_type_name') for t in types[:5]]}...")

    # 4. dry_run pra validar payload sem submeter
    resultado = flow_motorista.cadastrar_motorista_normal(
        client,
        cpf="85921456519",
        driver_name="JOAO VICTOR NASCIMENTO LIMA",
        contact_number="85999999999",
        gender=K.Gender.MALE,
        birth_day="1995-03-15",

        city_name="Fortaleza",
        neighbourhood_name="ALDEOTA",
        street_name="RUA DAS PALMEIRAS",
        address_number="123",
        zip_code="60150160",

        contract_type=1,  # ajustar conforme a sua agencia
        function_type_list=[K.FunctionType.LINE_HAUL],
        linehaul_station_name="SoC_RJ_Rio de Janeiro",  # da lista de stations

        license_number="12345678901",
        license_type=K.CNHType.E,
        license_expire_date="2030-01-01",
        cnh_remarks=["EAR"],

        vehicle_type_name="TRUCK - EXPRESSA",
        license_plate="ABC1234",
        vehicle_manufacturer="VOLKSWAGEN",
        vehicle_manufacturing_year="2020",
        vehicle_owner_name="JOAO VICTOR NASCIMENTO LIMA",
        renavam="12345678901",

        # arquivos opcionais — se nao passar, payload vai com URLs vazias
        # cnh_frente_path="C:/path/cnh_frente.jpg",
        # cnh_verso_path="C:/path/cnh_verso.jpg",
        # selfie_path="C:/path/selfie.jpg",
        # crlv_path="C:/path/crlv.pdf",

        dry_run=True,  # IMPORTANTE: nao submete, so monta o payload
    )

    print("\n=== RESULTADO ===")
    print(f"ok={resultado.get('ok')} etapa={resultado.get('etapa')}")
    if resultado.get("avisos"):
        for a in resultado["avisos"]:
            print(f"  ⚠ {a}")
    if resultado.get("payload"):
        import json
        print("Payload pronto pro submit (sem dry_run, seria enviado):")
        print(json.dumps(resultado["payload"], indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
