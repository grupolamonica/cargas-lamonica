import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { redirectLegacyDeploymentToCanonicalOrigin } from "@/lib/runtimeOrigin";
import { installStaleChunkReloadHandler } from "@/lib/lazyWithRetry";

if (typeof window !== "undefined") {
  redirectLegacyDeploymentToCanonicalOrigin(window.location);
  // DC-265: recarrega uma vez quando um chunk dinâmico falha (deploy novo /
  // rede móvel) em vez de mostrar "recarregue a página".
  installStaleChunkReloadHandler();
}

createRoot(document.getElementById("root")!).render(<App />);
