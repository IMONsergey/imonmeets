import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./ui";
import "@livekit/components-styles";
import "./styles.css";
import "./styles/auth.css";
import "./styles/call.css";
import "./styles/workspace.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
