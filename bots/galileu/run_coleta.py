"""Entry point do coletor Nestlé (adaptado do Projeto Galileu) para o Cargas Lamônica.

Loop: coleta as ofertas/programações do Galileo (TMS da Nestlé) e faz upsert em
`nestle_ofertas` do banco do Lamônica — que a tela Programação lê como a fonte Nestlé.

Requer no ambiente: GALILEU_URL/GALILEU_USER/GALILEU_PASSWORD (origem) e
NESTLE_SUPABASE_URL/NESTLE_SUPABASE_SERVICE_ROLE_KEY (destino; cai p/ SUPABASE_*).
Cadência via NESTLE_COLETA_INTERVAL_SEC (default 60s).
"""
import os
import time
import traceback

from nestle.robo_coleta import executar as coletar_ofertas
from nestle.robo_embarques import executar as atualizar_embarques

INTERVAL = max(15, int(os.getenv("NESTLE_COLETA_INTERVAL_SEC", "60")))


def main():
    print(f">> Coletor Nestlé (Galileu → Lamônica) iniciado — intervalo {INTERVAL}s")
    while True:
        # 1) Ofertas/programações → nestle_ofertas (o que aparece na Programação).
        try:
            coletar_ofertas()
        except Exception as e:  # nunca derruba o loop
            print(f"[ERROR] ciclo de ofertas falhou: {e}")
            traceback.print_exc()
        # 2) Embarques das aceitas → nestle_embarques (motorista/placa/status real;
        #    FINALIZADO → concluído). Enriquece a tela dinamicamente.
        try:
            atualizar_embarques()
        except Exception as e:
            print(f"[ERROR] ciclo de embarques falhou: {e}")
            traceback.print_exc()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
