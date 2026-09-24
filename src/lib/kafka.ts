import { Kafka, Producer, Partitioners } from "kafkajs";
import { env } from "./env";
import { logger } from "./logger";

// Best-effort event producer. authservice's job is to mint and verify tokens;
// *delivering* the reset email is the notification service's job, reached over
// Kafka. Everything here is written so that Kafka being unconfigured or down
// never breaks an auth request:
//   - no brokers set  -> publishEvent() is a no-op (logs one warning)
//   - send fails       -> caught and logged, never thrown
// The producer connects lazily on first publish, so boot makes no Kafka call.

const configured = env.kafka.brokers.length > 0;

let kafka: Kafka | undefined;
let producer: Producer | undefined;
let connecting: Promise<void> | undefined;
let warnedUnconfigured = false;

async function getProducer(): Promise<Producer | undefined> {
  if (!configured) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn("KAFKA_BROKERS not set - domain events will not be published");
    }
    return undefined;
  }
  if (producer) return producer;
  if (!connecting) {
    kafka ??= new Kafka({ clientId: env.kafka.clientId, brokers: env.kafka.brokers });
    // Pin the partitioner so kafkajs doesn't log its v2 migration warning;
    // same-key messages (key = userId) still land on one partition.
    const p = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
    connecting = p
      .connect()
      .then(() => {
        producer = p;
        logger.info({ brokers: env.kafka.brokers }, "kafka producer connected");
      })
      .catch((err) => {
        connecting = undefined; // allow a later publish to retry the connect
        logger.error({ err }, "kafka producer failed to connect");
      });
  }
  await connecting;
  return producer;
}

export async function publishEvent(topic: string, key: string, value: unknown): Promise<void> {
  try {
    const p = await getProducer();
    if (!p) return;
    await p.send({ topic, messages: [{ key, value: JSON.stringify(value) }] });
  } catch (err) {
    logger.error({ err, topic, key }, "failed to publish domain event");
  }
}

export async function disconnectKafka(): Promise<void> {
  if (producer) {
    await producer.disconnect().catch((err) => logger.error({ err }, "error disconnecting kafka producer"));
    producer = undefined;
    connecting = undefined;
  }
}
