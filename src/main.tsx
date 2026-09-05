import React from "react";
import ReactDOM from "react-dom/client";

async function bootstrap() {
  const container = document.getElementById("root");
  if (!container) throw new Error("Loavy could not find its application root.");
  const root = ReactDOM.createRoot(container);
  const [{ default: App }, { installMediaSession }] = await Promise.all([
    import("./App"),
    import("./lib/mediaSession"),
    import("./styles.css").then(() => import("./redesign.css"))
  ]);
  const disposeMediaSession = installMediaSession();

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      disposeMediaSession();
    });
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap().catch((error) => {
  const container = document.getElementById("root");
  if (container) {
    container.setAttribute("role", "alert");
    container.textContent = `Loavy could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
});

