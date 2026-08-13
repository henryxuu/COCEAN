import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app.js";
import "./styles.css";
import { applyCachedTheme } from "./theme.js";

applyCachedTheme();

// React Router owns list/detail navigation. Disable the browser's delayed
// scroll replay so it cannot override LibraryPage's route-keyed restoration.
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
