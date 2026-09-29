import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Bundled with the app instead of fetched from Google: on his network the
// stylesheet request used to stall first paint for a second or two. Only the
// latin subset and the four weights the UI actually use are shipped; Chinese
// falls back to PingFang / Microsoft YaHei from the system.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
