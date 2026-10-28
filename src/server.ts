import { app } from "./app";
import { env, isProduction } from "./lib/env";
import { logger } from "./lib/logger";
import { disconnectKafka } from "./lib/kafka";

const server = app.listen(env.port, () => {
  logger.info(`authservice listening on port ${env.port} (${env.nodeEnv})`);
});

// Kafka stays optional so the service boots without it, but in production a
// missing KAFKA_BROKERS means every "forgot password" silently sends nothing.
// Say so at boot, loudly, rather than as a warning on the first reset request.
if (isProduction && env.kafka.brokers.length === 0) {
  logger.error(
    "KAFKA_BROKERS is not set - PasswordResetRequested events will NOT be published and no reset emails will be sent",
  );
}

// Graceful shutdown: stop accepting connections, then release the Kafka
// producer so a rolling deploy doesn't drop an in-flight send.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated");
  server.close(async () => {
    await disconnectKafka();
    logger.info("shutdown complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
