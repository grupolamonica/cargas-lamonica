import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { redirectLegacyDeploymentToCanonicalOrigin } from "@/lib/runtimeOrigin";
import { installStaleChunkReloadHandler } from "@/lib/lazyWithRetry";
import { purgeExpiredRegistrationDrafts } from "@/lib/localStorageHygiene";

if (typeof window !== "undefined") {
  redirectLegacyDeploymentToCanonicalOrigin(window.location);
  // DC-265: recarrega uma vez quando um chunk dinâmico falha (deploy novo /
  // rede móvel) em vez de mostrar "recarregue a página".
  installStaleChunkReloadHandler();
  // DC-283 / MED-4: o TTL de 72h do rascunho só era checado na LEITURA, então
  // rascunho abandonado guardava CNH, CPF, endereço e dados bancários no
  // aparelho para sempre. Varre no boot pra o prazo valer de fato.
  purgeExpiredRegistrationDrafts();
}

createRoot(document.getElementById("root")!).render(<App />);
