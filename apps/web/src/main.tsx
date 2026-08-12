import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { captureLandingParams } from "./lib/analytics";
import { captureAttribution } from "./lib/leadIntake";
import "./index.css";

// Everything that reads the landing URL runs here, before render, because
// captureLandingParams() erases the campaign params from the address bar and an
// effect inside the tree would race both it and the first page_view.
//
// ORDER IS LOAD-BEARING: captureAttribution() reads the same utm_*/gclid params
// for the CRM's first-touch lead source. It must read them before they are
// erased, so it goes first.
captureAttribution();
captureLandingParams();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
