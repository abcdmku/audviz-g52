import "./style.css";
import { createApp } from "./ui/app.js";

createApp().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root) {
    root.innerHTML = `<pre style="white-space: pre-wrap; padding: 16px;">${String(
      err?.stack ?? err
    )}</pre>`;
  }
});

