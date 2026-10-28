// Kafka connection settings, parsed from the environment. Kept free of other
// imports (env.ts requires DATABASE_URL at load) so it can be unit-tested alone.
//
//   KAFKA_BROKERS         comma-separated; empty => producer is a no-op (see kafka.ts)
//   KAFKA_CLIENT_ID       default "authservice"
//   KAFKA_SSL             "true" for a TLS listener (MSK, Confluent Cloud, Aiven...)
//   KAFKA_SASL_MECHANISM  plain | scram-sha-256 | scram-sha-512 (empty = no SASL)
//   KAFKA_SASL_USERNAME / KAFKA_SASL_PASSWORD   required with a mechanism
//
// Same variables, same meaning as notification-service - the two must point at
// the same cluster for password-reset emails to flow.

const SASL_MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"] as const;
export type SaslMechanism = (typeof SASL_MECHANISMS)[number];
// One member per mechanism - the shape kafkajs' SASLOptions expects.
type Sasl = { [M in SaslMechanism]: { mechanism: M; username: string; password: string } }[SaslMechanism];

export interface KafkaSettings {
  brokers: string[];
  clientId: string;
  ssl: boolean;
  sasl?: Sasl;
}

export function parseKafkaSettings(source: Record<string, string | undefined>): KafkaSettings {
  const brokers = (source.KAFKA_BROKERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ssl = source.KAFKA_SSL === "true" || source.KAFKA_SSL === "1";

  // A half-configured SASL setup would otherwise surface only as a vague
  // connection error on the first password reset - fail at boot instead.
  const mechanism = (source.KAFKA_SASL_MECHANISM ?? "").trim().toLowerCase();
  let sasl: KafkaSettings["sasl"];
  if (mechanism) {
    if (!(SASL_MECHANISMS as readonly string[]).includes(mechanism)) {
      throw new Error(`KAFKA_SASL_MECHANISM must be one of ${SASL_MECHANISMS.join(", ")} (got "${mechanism}")`);
    }
    const username = source.KAFKA_SASL_USERNAME;
    const password = source.KAFKA_SASL_PASSWORD;
    if (!username || !password) {
      throw new Error("KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set");
    }
    sasl = { mechanism: mechanism as SaslMechanism, username, password } as Sasl;
  }

  return { brokers, clientId: source.KAFKA_CLIENT_ID || "authservice", ssl, sasl };
}
