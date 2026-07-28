import { describe, expect, it } from "vitest";

import { buildImportedDriverInfo } from "./import-driver-info.js";

// Payload como o mapSpxMotoristaPayload produz (campos SPX-shaped do nosso cadastro).
const payload = {
  cpf: "03731681366",
  driver_name: "TALES EMANUEL MENDES DE LIMA",
  license_number: "12345678901",
  license_type: 25,
  license_expire_date: "2027-01-23",
  birth_day: "1990-05-10",
  contact_number: "71999999999",
  gender: 1,
  city_name: "SALVADOR",
  neighbourhood_name: "CENTRO",
  street_name: "RUA X",
  address_number: "10",
  zip_code: "40000000",
};

describe("buildImportedDriverInfo (SPX importar outra agência)", () => {
  it("usa o NOSSO cadastro quando o SPX não devolve o perfil (cross-agency: driverInfo vazio)", () => {
    const di = buildImportedDriverInfo(payload, { driverInfo: null, existingDriverId: 999 });
    // Nome + CNH vêm do nosso cadastro → o guard do bot ("nome e CNH vazio") passa.
    expect(di.driver_name).toBe("TALES EMANUEL MENDES DE LIMA");
    expect(di.license_number).toBe("12345678901");
    // Datas seguem em ISO (o bot normaliza p/ unix via _to_unix_seconds).
    expect(di.birth_day).toBe("1990-05-10");
    expect(di.license_expire_date).toBe("2027-01-23");
    expect(di.driver_id).toBe(999);
  });

  it("o que o SPX devolver PREVALECE (não-vazio); o nosso preenche as lacunas", () => {
    const di = buildImportedDriverInfo(payload, {
      driverInfo: { driver_name: "NOME QUE VEIO DO SPX", city_id: 42, license_number: "" },
    });
    expect(di.driver_name).toBe("NOME QUE VEIO DO SPX"); // SPX ganha
    expect(di.license_number).toBe("12345678901"); // SPX vazio → nosso preenche
    expect(di.city_id).toBe(42); // chave extra do SPX é preservada
    expect(di.contact_number).toBe("71999999999"); // nosso, intocado
  });

  it("precheck ausente → só o nosso cadastro, sem driver_id", () => {
    const di = buildImportedDriverInfo(payload);
    expect(di.driver_name).toBe("TALES EMANUEL MENDES DE LIMA");
    expect(di).not.toHaveProperty("driver_id");
  });
});
