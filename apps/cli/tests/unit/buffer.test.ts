import { describe, expect, test } from "vitest";
import { createEventBuffer, type EventEnvelope } from "../../src/agent/buffer.js";

function evt(id: string, n: number): EventEnvelope {
  return { id, type: "send", data: { n } };
}

describe("event buffer", () => {
  test("push + replaySince returns events newer than the given id", () => {
    const buf = createEventBuffer({ capacity: 10 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    expect(buf.replaySince("01").map((e) => e.id)).toEqual(["02", "03"]);
    expect(buf.replaySince(undefined).map((e) => e.id)).toEqual(["01", "02", "03"]);
    expect(buf.replaySince("99").map((e) => e.id)).toEqual(["01", "02", "03"]);
  });

  test("evicts oldest when over capacity", () => {
    const buf = createEventBuffer({ capacity: 2 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    expect(buf.replaySince(undefined).map((e) => e.id)).toEqual(["02", "03"]);
  });

  test("replaySince of an evicted id returns whole remaining buffer (best-effort)", () => {
    const buf = createEventBuffer({ capacity: 2 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    expect(buf.replaySince("01").map((e) => e.id)).toEqual(["02", "03"]);
  });
});
