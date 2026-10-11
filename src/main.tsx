import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./fs";
import "./styles.css";

document.documentElement.classList.toggle("tauri", isTauri);
// The window's traffic-light buttons overlap the content only on macOS.
document.documentElement.classList.toggle("mac", /Mac/.test(navigator.userAgent));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
