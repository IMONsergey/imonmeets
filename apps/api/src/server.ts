import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
const config = loadConfig();
const app = await createApp(config);
await app.listen({ port: config.port, host: config.host });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
