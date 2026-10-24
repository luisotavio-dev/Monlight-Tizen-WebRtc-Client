"use strict";

const assert = require("assert");

global.window = global;
require("../tizen/low-latency.js");
const LowLatency = global.LowLatency;

const offer = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=msid:moonlight video",
  "a=ssrc:1 cname:sunshine",
  "a=ssrc:1 msid:moonlight video",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=msid:moonlight audio",
  "a=ssrc:2 cname:sunshine",
  "a=ssrc:2 msid:moonlight audio",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "",
].join("\r\n");

const separated = LowLatency.separateAudioSync(offer);
assert.ok(separated.indexOf("a=msid:moonlight-audio audio\r\n") >= 0, "the audio section moves to a stream of its own");
assert.ok(separated.indexOf("a=ssrc:2 msid:moonlight-audio audio\r\n") >= 0, "and so does its SSRC description");
assert.ok(separated.indexOf("a=msid:moonlight video\r\n") >= 0, "the video keeps its stream");
assert.ok(separated.indexOf("a=ssrc:1 msid:moonlight video\r\n") >= 0);
assert.strictEqual(separated.split("\r\n").length, offer.split("\r\n").length, "no line is added or lost");
assert.strictEqual(LowLatency.separateAudioSync(separated), separated, "a separated offer stays as it is");
assert.strictEqual(LowLatency.separateAudioSync(offer.replace(/\r\n/g, "\n")),
  separated.replace(/\r\n/g, "\n"), "an offer with bare newlines keeps them");
assert.strictEqual(LowLatency.separateAudioSync("m=audio 9 RTP 111\r\na=msid:- audio"),
  "m=audio 9 RTP 111\r\na=msid:- audio", "a track without a stream has nothing to sync");
assert.strictEqual(LowLatency.separateAudioSync(undefined), undefined);

const modern = { jitterBufferTarget: null, playoutDelayHint: 1 };
assert.strictEqual(LowLatency.minimizeReceiverDelay(modern), "jitterBufferTarget", "newer Chromium takes the target");
assert.strictEqual(modern.jitterBufferTarget, 0);
assert.strictEqual(modern.playoutDelayHint, 1, "and the older hint is left alone");

const older = { playoutDelayHint: undefined };
assert.strictEqual(LowLatency.minimizeReceiverDelay(older), "playoutDelayHint", "older Chromium takes the hint");
assert.strictEqual(older.playoutDelayHint, 0);

assert.strictEqual(LowLatency.minimizeReceiverDelay({}), null, "a TV with neither reports it");
assert.strictEqual(LowLatency.minimizeReceiverDelay(null), null);
const refusing = {};
Object.defineProperty(refusing, "jitterBufferTarget", { get: function () { return null; }, set: function () { throw new RangeError("no"); } });
assert.strictEqual(LowLatency.minimizeReceiverDelay(refusing), null, "a receiver that refuses the value does not stop the stream");

console.log("Tizen low latency tests passed");
