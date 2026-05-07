export interface EventEnvelope {
  id: string;
  type: "send";
  data: unknown;
}

export interface EventBuffer {
  push(e: EventEnvelope): void;
  replaySince(lastId: string | undefined): EventEnvelope[];
  size(): number;
}

export function createEventBuffer(opts: { capacity: number }): EventBuffer {
  const ring: EventEnvelope[] = [];
  return {
    push(e) {
      ring.push(e);
      if (ring.length > opts.capacity) ring.splice(0, ring.length - opts.capacity);
    },
    replaySince(lastId) {
      if (!lastId) return [...ring];
      const idx = ring.findIndex((e) => e.id === lastId);
      if (idx < 0) return [...ring];
      return ring.slice(idx + 1);
    },
    size: () => ring.length,
  };
}
