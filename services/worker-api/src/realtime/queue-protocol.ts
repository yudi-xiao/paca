import * as z from "zod";

import { parseRealtimeEnvelope, type RealtimeEnvelope } from "./protocol";

const realtimeQueueMessageSchema = z
  .object({
    version: z.literal(1),
    outboxId: z.uuid(),
    roomType: z.enum(["project", "user"]),
    roomId: z.string().min(1).max(255),
    event: z.unknown(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type RealtimeQueueMessage = {
  version: 1;
  outboxId: string;
  roomType: "project" | "user";
  roomId: string;
  event: RealtimeEnvelope;
  createdAt: string;
};

export function parseRealtimeQueueMessage(value: unknown): RealtimeQueueMessage {
  const parsed = realtimeQueueMessageSchema.parse(value);
  return {
    ...parsed,
    event: parseRealtimeEnvelope(parsed.event),
  };
}
