import test from "node:test";
import assert from "node:assert/strict";
import { communityEmoteFromRow, parseMediaUpload, parseRange } from "./media.js";

test("media upload validation accepts matching bounded image bytes", () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const parsed = parseMediaUpload({ purpose: "avatar", name: "avatar.png", contentType: "image/png", dataBase64: pngSignature.toString("base64") }, 1024);
  assert.equal(parsed.input.purpose, "avatar");
  assert.deepEqual(parsed.bytes, pngSignature);
  assert.throws(() => parseMediaUpload({ purpose: "avatar", name: "avatar.png", contentType: "image/jpeg", dataBase64: pngSignature.toString("base64") }, 1024), /bad_request/);
});

test("message uploads allow opaque ciphertext and sniffed displayable media", () => {
  const bytes = Buffer.from("ciphertext");
  assert.equal(parseMediaUpload({ purpose: "message", name: "clip.enc", contentType: "application/octet-stream", dataBase64: bytes.toString("base64") }, 100).bytes.length, bytes.length);
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "clip.mp4", contentType: "video/mp4", dataBase64: bytes.toString("base64") }, 100), /bad_request/);
  const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.equal(parseMediaUpload({ purpose: "message", name: "clip.mp4", contentType: "video/mp4", dataBase64: mp4.toString("base64") }, 100).input.contentType, "video/mp4");

  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  assert.equal(parseMediaUpload({ purpose: "message", name: "clip.webm", contentType: "video/webm; codecs=vp9", dataBase64: webm.toString("base64") }, 100).input.contentType, "video/webm");
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "wrong.webm", contentType: "video/webm", dataBase64: mp4.toString("base64") }, 100), /bad_request/);
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "wrong.mp4", contentType: "video/mp4", dataBase64: webm.toString("base64") }, 100), /bad_request/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(parseMediaUpload({ purpose: "message", name: "image.png", contentType: "image/png", dataBase64: png.toString("base64") }, 100).input.contentType, "image/png");
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
  assert.equal(parseMediaUpload({ purpose: "message", name: "sound.wav", contentType: "audio/wav", dataBase64: wav.toString("base64") }, 100).input.contentType, "audio/wav");
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "script.html", contentType: "text/html", dataBase64: Buffer.from("<script></script>").toString("base64") }, 100), /bad_request/);
});

test("video signatures must be complete enough to identify their container", () => {
  const truncatedMp4 = Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  const invalidWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa2, 0, 0, 0, 0]);
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "truncated.mp4", contentType: "video/mp4", dataBase64: truncatedMp4.toString("base64") }, 100), /bad_request/);
  assert.throws(() => parseMediaUpload({ purpose: "message", name: "invalid.webm", contentType: "video/webm", dataBase64: invalidWebm.toString("base64") }, 100), /bad_request/);
});

test("single byte ranges are normalized and bounded", () => {
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.throws(() => parseRange("bytes=100-101", 100), /bad_request/);
  assert.throws(() => parseRange("bytes=0-1,4-5", 100), /bad_request/);
});

test("community emote responses keep the emote and media object identities distinct", () => {
  const emote = communityEmoteFromRow({
    emote_id: "11111111-1111-4111-8111-111111111111",
    media_id: "22222222-2222-4222-8222-222222222222",
    name: "gaben",
    content_type: "image/webp",
    width: 128,
    height: 128,
    ready_at: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(emote.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(emote.media.id, "22222222-2222-4222-8222-222222222222");
  assert.notEqual(emote.id, emote.media.id);
});
