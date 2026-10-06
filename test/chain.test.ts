import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOggOpus, auditOggOpusChain, AuditError } from "../src/audit.ts";
import { oggCrc32 } from "../src/crc32ogg.ts";
import {
  buildRawPage,
  FLAG_BOS,
  FLAG_CONTINUED,
  FLAG_EOS,
  lacePackets,
  OggFileBuilder,
  opusHead,
  opusPacket,
  opusTags,
} from "./helpers/oggBuilder.ts";

/**
 * Chained-file fixtures: every link is a complete logical stream built
 * by its own OggFileBuilder (sequence numbers restart at zero per
 * link); links are concatenated byte-wise, mirroring a recorder that
 * restarted its encoder.
 */

function link(options: {
  serial: number;
  preSkip?: number;
  channels?: 1 | 2;
  packetCount?: number;
  packetsPerPage?: number;
  finalPageTrim?: number;
  eos?: boolean;
}): Uint8Array {
  const channels = options.channels ?? 1;
  const count = options.packetCount ?? 4;
  const packets = Array.from({ length: count }, () =>
    opusPacket({ config: 31, stereo: channels === 2, frameData: [new Uint8Array([0x20])] }),
  );
  const audio: { packetsPerPage?: number; finalPageTrim?: number; eos?: boolean } = {};
  if (options.packetsPerPage !== undefined) audio.packetsPerPage = options.packetsPerPage;
  if (options.finalPageTrim !== undefined) audio.finalPageTrim = options.finalPageTrim;
  if (options.eos !== undefined) audio.eos = options.eos;
  return new OggFileBuilder({
    preSkip: options.preSkip ?? 312,
    channels,
    serial: options.serial,
  })
    .writeHeaders()
    .writeAudioPackets(packets, audio)
    .build();
}

/** Hand-rolled three-page link for cases a builder cannot express. */
function manualLink(serial: number, sequences: [number, number, number], headFlags: number): Uint8Array {
  const head = lacePackets([opusHead({})]);
  const tags = lacePackets([opusTags()]);
  const audio = lacePackets([opusPacket({ config: 31, frameData: [new Uint8Array([1])] })]);
  return concatBytes([
    buildRawPage({
      serial,
      sequence: sequences[0],
      flags: headFlags,
      granule: 0n,
      segments: Uint8Array.from(head.segments),
      body: head.body,
    }),
    buildRawPage({
      serial,
      sequence: sequences[1],
      flags: 0,
      granule: 0n,
      segments: Uint8Array.from(tags.segments),
      body: tags.body,
    }),
    buildRawPage({
      serial,
      sequence: sequences[2],
      flags: FLAG_EOS,
      granule: 960n,
      segments: Uint8Array.from(audio.segments),
      body: audio.body,
    }),
  ]);
}

function expectChainFail(input: Uint8Array, code: string, page: number | null): void {
  try {
    auditOggOpusChain(input);
    assert.fail("expected chained audit to fail");
  } catch (err) {
    assert.ok(err instanceof AuditError, `expected AuditError, got ${err}`);
    assert.equal((err as AuditError).code, code);
    assert.equal((err as AuditError).pageIndex, page);
    assert.equal((err as AuditError).status, 422);
  }
}

/* ------------------------------ valid chains ------------------------------ */

test("single-link chain matches the single-stream audit plus linkCount", () => {
  const file = link({ serial: 0x1111_0001, preSkip: 312, packetCount: 10 });
  const single = auditOggOpus(file);
  const chained = auditOggOpusChain(file);
  assert.deepEqual(chained, { ...single, linkCount: 1 });
  assert.equal(chained.pageCount, 3);
  assert.equal(chained.audioPacketCount, 10);
  assert.equal(chained.decodedSamples, 9600);
  assert.equal(chained.playableSamples, 9600 - 312);
});

test("two links with different pre-skips aggregate statistics", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 312, packetCount: 4 }); // 3840 decoded, 3528 playable
  const b = link({ serial: 0x2222_0002, preSkip: 96, packetCount: 2 }); // 1920 decoded, 1824 playable
  const r = auditOggOpusChain(concatBytes([a, b]));
  assert.deepEqual(r, {
    linkCount: 2,
    pageCount: 6,
    audioPacketCount: 6,
    decodedSamples: 5760,
    playableSamples: 3528 + 1824,
  });
});

test("playable samples clamp per link before summing", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 }); // 960 playable
  // Link b ends at granule 960 (EOS trims the whole second page), far
  // below its 5000-sample pre-skip, so it contributes zero playable.
  const b = link({
    serial: 0x2222_0002,
    preSkip: 5000,
    packetCount: 2,
    packetsPerPage: 1,
    finalPageTrim: 960,
  });
  const r = auditOggOpusChain(concatBytes([a, b]));
  assert.equal(r.linkCount, 2);
  assert.equal(r.decodedSamples, 960 + 1920);
  assert.equal(r.playableSamples, 960);
});

test("sixteen links are accepted, the seventeenth is rejected", () => {
  const links = Array.from({ length: 16 }, (_unused, i) =>
    link({ serial: 0x1000 + i, preSkip: 0, packetCount: 1 }),
  );
  const r = auditOggOpusChain(concatBytes(links));
  assert.equal(r.linkCount, 16);
  assert.equal(r.pageCount, 48);
  assert.equal(r.audioPacketCount, 16);
  const seventeen = concatBytes([...links, link({ serial: 0x2000, preSkip: 0, packetCount: 1 })]);
  expectChainFail(seventeen, "TOO_MANY_LINKS", 48);
});

test("a legal chain audits to an identical summary on repeat", () => {
  const file = concatBytes([
    link({ serial: 1, preSkip: 312, packetCount: 3 }),
    link({ serial: 2, preSkip: 0, packetCount: 5 }),
    link({ serial: 3, preSkip: 777, packetCount: 2 }),
  ]);
  assert.deepEqual(auditOggOpusChain(file), auditOggOpusChain(file));
});

test("a stereo chain with matching channels is accepted", () => {
  const a = link({ serial: 0x1111_0001, channels: 2, preSkip: 312, packetCount: 2 });
  const b = link({ serial: 0x2222_0002, channels: 2, preSkip: 96, packetCount: 3 });
  const r = auditOggOpusChain(concatBytes([a, b]));
  assert.equal(r.linkCount, 2);
  assert.equal(r.audioPacketCount, 5);
  assert.equal(r.decodedSamples, 5 * 960);
});

test("a packet spanning pages inside a later link is reconstructed", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 }); // 960 samples
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const before = opusPacket({ config: 31, frameData: [new Uint8Array([7])] });
  const after = opusPacket({ config: 31, frameData: [new Uint8Array([9])] });
  const b = new OggFileBuilder({ preSkip: 0, serial: 0x2222_0002 })
    .writeHeaders()
    .writeSpanningAudio([before, big, after], 1)
    .build();
  const r = auditOggOpusChain(concatBytes([a, b]));
  assert.equal(r.linkCount, 2);
  assert.equal(r.pageCount, 3 + 4);
  assert.equal(r.audioPacketCount, 1 + 3);
  assert.equal(r.decodedSamples, 960 + 960 + 720 + 960);
  assert.equal(r.playableSamples, r.decodedSamples);
});

/* ------------------------------ chain errors ------------------------------ */

test("a new link before the previous EOS fails as missing termination", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1, eos: false });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  expectChainFail(concatBytes([a, b]), "STREAM_NOT_TERMINATED", 3);
});

test("adjacent links reusing a serial are rejected", () => {
  const a = link({ serial: 0x3333_0003, preSkip: 0, packetCount: 1 });
  const b = link({ serial: 0x3333_0003, preSkip: 0, packetCount: 1 });
  expectChainFail(concatBytes([a, b]), "SERIAL_NUMBER_REUSED", 3);
});

test("a serial reused from a non-adjacent earlier link is rejected", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  const c = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 }); // repeats link a
  expectChainFail(concatBytes([a, b, c]), "SERIAL_NUMBER_REUSED", 6);
});

test("pages of another stream interleaved into a link are rejected", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1, eos: false });
  // A foreign non-BOS page where link a's next page should be. Its
  // sequence number continues link a so only the serial is wrong.
  const stray = buildRawPage({
    serial: 0x9999_0009,
    sequence: 3,
    flags: 0,
    granule: 1920n,
    ...packetPayload([opusPacket({ config: 31, frameData: [new Uint8Array([1])] })]),
  });
  expectChainFail(concatBytes([a, stray]), "STREAM_INTERLEAVED", 3);
});

test("a channel-count change across links is rejected", () => {
  const a = link({ serial: 0x1111_0001, channels: 1, packetCount: 1 });
  const b = link({ serial: 0x2222_0002, channels: 2, packetCount: 1 });
  expectChainFail(concatBytes([a, b]), "CHANNEL_CONFIG_MISMATCH", 3);
});

test("a non-BOS page after a link's EOS is rejected", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const stray = buildRawPage({
    serial: 0x9999_0009,
    sequence: 0,
    flags: 0,
    granule: 0n,
    ...packetPayload([opusPacket({ config: 31, frameData: [new Uint8Array([1])] })]),
  });
  expectChainFail(concatBytes([a, stray]), "EOS_FLAG_INVALID", 3);
});

test("a link must not open with a continued packet", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = manualLink(0x2222_0002, [0, 1, 2], FLAG_BOS | FLAG_CONTINUED);
  expectChainFail(concatBytes([a, b]), "BOS_FLAG_INVALID", 3);
});

test("each link's page sequence must restart at zero", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = manualLink(0x2222_0002, [5, 6, 7], FLAG_BOS);
  expectChainFail(concatBytes([a, b]), "PAGE_SEQUENCE_INVALID", 3);
});

test("an EOS page leaving a packet open fails before the next link", () => {
  const head = new OggFileBuilder({ serial: 0x1111_0001, preSkip: 0 }).writeHeaders().build();
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const openEos = buildRawPage({
    serial: 0x1111_0001,
    sequence: 2,
    flags: FLAG_EOS,
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, 510),
  });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  expectChainFail(concatBytes([head, openEos, b]), "AUDIO_PACKET_TRUNCATED", 2);
});

test("granule rules apply per link and report the global page index", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 2, packetsPerPage: 1 });
  const file = concatBytes([a, b]);
  // Link b's first audio page is global page 5; corrupt its granule.
  const off = pageOffset(file, 5);
  writeGranule(file, off, 961n);
  fixCrcs(file);
  expectChainFail(file, "GRANULE_MISMATCH", 5);
});

test("a CRC failure inside a later link reports the global page index", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  const file = concatBytes([a, b]);
  // Flip the first body byte of link b's OpusTags page (global page 4).
  const off = pageOffset(file, 4);
  const bodyStart = off + 27 + file[off + 26]!;
  file[bodyStart]! ^= 0xff;
  expectChainFail(file, "BAD_CRC", 4);
});

test("the 2048-page cap applies to the whole chain", () => {
  const packets = Array.from({ length: 2045 }, () =>
    opusPacket({ config: 28, frameData: [new Uint8Array([1])] }),
  );
  // Link a: 2 header pages + 2045 audio pages = 2047 pages (0..2046).
  const a = new OggFileBuilder({ preSkip: 0, serial: 0x1111_0001 })
    .writeHeaders()
    .writeAudioPackets(packets, { packetsPerPage: 1 })
    .build();
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  expectChainFail(concatBytes([a, b]), "TOO_MANY_PAGES", 2048);
});

test("trailing junk after the final link is rejected", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  expectChainFail(concatBytes([a, new Uint8Array(27)]), "BAD_CAPTURE_PATTERN", 3);
});

test("empty input and oversize bodies keep their status codes in chained mode", () => {
  try {
    auditOggOpusChain(new Uint8Array(0));
    assert.fail();
  } catch (err) {
    assert.equal((err as AuditError).status, 400);
    assert.equal((err as AuditError).code, "EMPTY_INPUT");
  }
  try {
    auditOggOpusChain(new Uint8Array(8 * 1024 * 1024 + 1));
    assert.fail();
  } catch (err) {
    assert.equal((err as AuditError).status, 413);
    assert.equal((err as AuditError).code, "PAYLOAD_TOO_LARGE");
  }
});

test("the single-stream auditor still rejects a chained file", () => {
  const a = link({ serial: 0x1111_0001, preSkip: 0, packetCount: 1 });
  const b = link({ serial: 0x2222_0002, preSkip: 0, packetCount: 1 });
  try {
    auditOggOpus(concatBytes([a, b]));
    assert.fail("expected single-stream audit to fail");
  } catch (err) {
    assert.ok(err instanceof AuditError);
    assert.equal((err as AuditError).code, "BOS_FLAG_INVALID");
    assert.equal((err as AuditError).pageIndex, 3);
  }
});

/* ------------------------------- helpers ------------------------------- */

function packetPayload(packets: Uint8Array[]): { segments: Uint8Array; body: Uint8Array } {
  const lacing = lacePackets(packets);
  return { segments: Uint8Array.from(lacing.segments), body: lacing.body };
}

function pageOffset(buf: Uint8Array, wanted: number): number {
  let off = 0;
  let idx = 0;
  while (idx < wanted) {
    const nseg = buf[off + 26]!;
    const bodyLen = buf
      .subarray(off + 27, off + 27 + nseg)
      .reduce((a, b) => a + b, 0);
    off = off + 27 + nseg + bodyLen;
    idx += 1;
  }
  return off;
}

function writeGranule(buf: Uint8Array, pageStart: number, value: bigint): void {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    buf[pageStart + 6 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Recompute every page CRC after a semantic mutation. */
function fixCrcs(buf: Uint8Array): Uint8Array {
  let off = 0;
  while (off < buf.length) {
    const nseg = buf[off + 26]!;
    const bodyLen = buf
      .subarray(off + 27, off + 27 + nseg)
      .reduce((a, b) => a + b, 0);
    const end = off + 27 + nseg + bodyLen;
    buf[off + 22] = 0;
    buf[off + 23] = 0;
    buf[off + 24] = 0;
    buf[off + 25] = 0;
    const crc = oggCrc32(buf.subarray(off, end));
    buf[off + 22] = crc & 0xff;
    buf[off + 23] = (crc >>> 8) & 0xff;
    buf[off + 24] = (crc >>> 16) & 0xff;
    buf[off + 25] = (crc >>> 24) & 0xff;
    off = end;
  }
  return buf;
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
