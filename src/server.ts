import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

app.listen(env.port, () => {
  logger.info(`authservice listening on port ${env.port} (${env.nodeEnv})`);
});
