import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setDocumentLanguage } from "../../i18n";
import App from "./App";
import { applyPagePalette } from "./page-context";
import "./popup.css";

setDocumentLanguage();
void applyPagePalette();

const root = document.getElementById("root");
if (!root) throw new Error("Popup root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
