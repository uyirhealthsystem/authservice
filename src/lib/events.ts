import { publishEvent } from "./kafka";

// Domain events authservice emits to the "auth.events" Kafka topic. Consumers
// (today just notification-service) subscribe and decide what to do with each
// eventType. Envelope shape is a contract - bump `eventVersion` on a breaking
// change rather than mutating v1.
export const AUTH_EVENTS_TOPIC = "auth.events";

interface EventEnvelope<T> {
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  data: T;
}

function envelope<T>(eventType: string, eventVersion: number, data: T): EventEnvelope<T> {
  return { eventType, eventVersion, occurredAt: new Date().toISOString(), data };
}

export interface PasswordResetRequestedData {
  userId: string;
  email: string;
  otp: string; // 6-digit code, raw (only its hash is persisted)
  expiresAt: string;
}

export async function emitPasswordResetRequested(data: PasswordResetRequestedData): Promise<void> {
  await publishEvent(AUTH_EVENTS_TOPIC, data.userId, envelope("PasswordResetRequested", 1, data));
}
