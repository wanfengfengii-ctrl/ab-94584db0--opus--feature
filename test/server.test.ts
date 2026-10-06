import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createAuditServer } from "../src/server.ts";
import { OggFileBuilder, opusPacket } from "./helpers/oggBuilder.ts";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createAuditServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("server has no address");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function validStream(): Uint8Array {
  const packets = Array.from({ length: 4 }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([0x11])] }),
  );
  return new OggFileBuilder({ preSkip: 0 }).writeHeaders().writeAudioPackets(packets).build();
}

/** One complete chain link (config-31 packets: 960 samples each). */
function chainLink(options: { serial: number; preSkip?: number; packetCount?: number }): Uint8Array {
  const count = options.packetCount ?? 4;
  const packets = Array.from({ length: count }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([0x11])] }),
  );
  return new OggFileBuilder({ preSkip: options.preSkip ?? 0, serial: options.serial })
    .writeHeaders()
    .writeAudioPackets(packets)
    .build();
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function postAudit(body: Uint8Array, query = ""): Promise<Response> {
  return fetch(`${baseUrl}/api/opus/audit${query}`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body,
  });
}

interface ErrorBody {
  error: { code: string; page?: number; message: string };
}

async function readErrorBody(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

test("GET /health reports ok", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST valid audio/ogg returns stable statistics", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: validStream(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    pageCount: 3,
    audioPacketCount: 4,
    decodedSamples: 3840,
    playableSamples: 3840,
  });
});

test("content-type with charset is still accepted", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg; charset=binary" },
    body: validStream(),
  });
  assert.equal(res.status, 200);
});

test("wrong content type yields 415", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: validStream(),
  });
  assert.equal(res.status, 415);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("unknown route yields 404 with a stable error code", async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await readErrorBody(res)).error.code, "NOT_FOUND");
});

test("empty body yields 400 EMPTY_INPUT", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: new Uint8Array(0),
  });
  assert.equal(res.status, 400);
  assert.equal((await readErrorBody(res)).error.code, "EMPTY_INPUT");
});

test("a corrupted stream yields 422 with code and failing page", async () => {
  const bad = validStream();
  bad[bad.length - 1]! ^= 0xff; // damage last page body -> CRC fail
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: bad,
  });
  assert.equal(res.status, 422);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "BAD_CRC");
  assert.equal(body.error.page, 2);
  assert.equal(typeof body.error.message, "string");
});

test("body beyond the configured byte cap yields 413", async () => {
  const smallServer = createAuditServer({ maxBytes: 64 });
  await new Promise<void>((resolve) => smallServer.listen(0, "127.0.0.1", resolve));
  const addr = smallServer.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}/api/opus/audit`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: new Uint8Array(128),
  });
  assert.equal(res.status, 413);
  assert.equal((await readErrorBody(res)).error.code, "PAYLOAD_TOO_LARGE");
  await new Promise<void>((resolve, reject) =>
    smallServer.close((err) => (err ? reject(err) : resolve())),
  );
});

/* --------------------- chained logical streams --------------------- */

test("chained mode audits a single-link file and adds linkCount", async () => {
  const res = await postAudit(validStream(), "?logical_streams=chained");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    linkCount: 1,
    pageCount: 3,
    audioPacketCount: 4,
    decodedSamples: 3840,
    playableSamples: 3840,
  });
});

test("chained mode aggregates a two-link chain with different pre-skips", async () => {
  const a = chainLink({ serial: 0x0a0a_0001, preSkip: 312, packetCount: 4 });
  const b = chainLink({ serial: 0x0b0b_0002, preSkip: 96, packetCount: 2 });
  const res = await postAudit(concatBytes([a, b]), "?logical_streams=chained");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    linkCount: 2,
    pageCount: 6,
    audioPacketCount: 6,
    decodedSamples: 5760,
    playableSamples: 3840 - 312 + (1920 - 96),
  });
});

test("chained audit summaries are stable across repeated requests", async () => {
  const file = concatBytes([
    chainLink({ serial: 0x0a0a_0001, preSkip: 312, packetCount: 4 }),
    chainLink({ serial: 0x0b0b_0002, preSkip: 96, packetCount: 2 }),
  ]);
  const first = await (await postAudit(file, "?logical_streams=chained")).json();
  const second = await (await postAudit(file, "?logical_streams=chained")).json();
  assert.deepEqual(second, first);
});

test("duplicate link serials yield 422 with the first global failing page", async () => {
  const file = concatBytes([
    chainLink({ serial: 0x0c0c_0001, packetCount: 1 }),
    chainLink({ serial: 0x0c0c_0001, packetCount: 1 }),
  ]);
  const res = await postAudit(file, "?logical_streams=chained");
  assert.equal(res.status, 422);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "SERIAL_NUMBER_REUSED");
  assert.equal(body.error.page, 3);
});

test("a chained file without the parameter keeps the single-stream contract", async () => {
  const file = concatBytes([
    chainLink({ serial: 0x0a0a_0001, packetCount: 1 }),
    chainLink({ serial: 0x0b0b_0002, packetCount: 1 }),
  ]);
  const res = await postAudit(file);
  assert.equal(res.status, 422);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "BOS_FLAG_INVALID");
  assert.equal(body.error.page, 3);
});

test("an unsupported logical_streams value yields 400", async () => {
  const res = await postAudit(validStream(), "?logical_streams=grouped");
  assert.equal(res.status, 400);
  assert.equal((await readErrorBody(res)).error.code, "UNSUPPORTED_LOGICAL_STREAMS");
});
