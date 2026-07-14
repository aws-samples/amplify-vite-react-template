import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { connectBackend } from "./lib/backend";

connectBackend().then((backendReady) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App backendReady={backendReady} />
    </React.StrictMode>
  );
});
