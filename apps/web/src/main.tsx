import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { AppErrorBoundary, Spinner } from "./ui";
import "@livekit/components-styles";
import "./styles.css";
import "./styles/auth.css";
import "./styles/call.css";
import "./styles/workspace.css";
const Application = location.pathname.startsWith("/embed/")
  ? lazy(() => import("./pages/Embed"))
  : lazy(() => import("./App"));
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <Suspense
        fallback={
          <div className="full-loader">
            <Spinner />
          </div>
        }
      >
        <Application />
      </Suspense>
    </AppErrorBoundary>
  </React.StrictMode>,
);
