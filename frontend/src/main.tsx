import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { redirectLegacyDeploymentToCanonicalOrigin } from "@/lib/runtimeOrigin";

if (typeof window !== "undefined") {
  redirectLegacyDeploymentToCanonicalOrigin(window.location);
}

createRoot(document.getElementById("root")!).render(<App />);
