import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Token Talk root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
