"use strict";

const assert = require("assert");

global.window = global;
require("../tizen/stream-latency.js");
const StreamLatency = global.StreamLatency;

function close(actual, expected, message) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6,
    (message || "value") + ": expected " + expected + ", got " + actual);
}

const latency = StreamLatency.create();

latency.recordPresentedFrame({ receiveTime: 1000, expectedDisplayTime: 1020, presentationTime: 1015 });
latency.recordPresentedFrame({ receiveTime: 2000, expectedDisplayTime: 2030 });
latency.recordPresentedFrame({ receiveTime: 0, expectedDisplayTime: 3000 });
latency.recordPresentedFrame({ receiveTime: 4000, expectedDisplayTime: 3990 });
latency.recordPresentedFrame({ receiveTime: 5000, expectedDisplayTime: 9000 });
latency.recordPresentedFrame(null);

let summary = latency.sample({
  packetsReceived: 990,
  packetsLost: 10,
  framesReceived: 100,
  framesDropped: 2,
  framesDecoded: 98,
  totalDecodeTime: 0.49,
  jitterBufferDelay: 1.0,
  jitterBufferEmittedCount: 100,
  totalProcessingDelay: 1.5,
  timestamp: 10000,
}, 0.004);

close(summary.roundTripMs, 4, "round trip");
close(summary.networkMs, 2, "one way is half the round trip");
close(summary.jitterBufferMs, 10, "jitter buffer per frame");
close(summary.decodeMs, 5, "decode per frame");
close(summary.processingMs, 15, "arrival to decoded per frame");
close(summary.displayMs, 25, "arrival to screen ignores frames without a receive time and implausible ones");
close(summary.displayMaxMs, 30, "worst frame to screen");
assert.strictEqual(summary.includesDisplay, true);
close(summary.totalMs, 27, "total is network plus to screen");
close(summary.averageTotalMs, 27);
close(summary.packetLossPercent, 1, "lost packets as a share of all sent");
close(summary.sessionPacketLossPercent, 1);
close(summary.framesDroppedPercent, 2);
assert.strictEqual(summary.receivedFps, null, "the first sample has no interval to measure the frame rate over");

summary = latency.sample({
  packetsReceived: 1990,
  packetsLost: 10,
  framesReceived: 200,
  framesDropped: 2,
  framesDecoded: 198,
  totalDecodeTime: 0.99,
  jitterBufferDelay: 1.5,
  jitterBufferEmittedCount: 200,
  totalProcessingDelay: 2.5,
  timestamp: 12000,
}, 0.004);
close(summary.receivedFps, 50, "a hundred frames in two seconds");
close(summary.packetLossPercent, 0, "the window only counts its own losses");
close(summary.sessionPacketLossPercent, 0.5, "the session counts all of them");
close(summary.jitterBufferMs, 5);
assert.strictEqual(summary.displayMs, null, "no frame was presented in the window");
assert.strictEqual(summary.includesDisplay, true, "but the TV does report presented frames");
close(summary.totalMs, 12, "so the window falls back to arrival to decoded");
close(summary.averageTotalMs, 19.5, "the average covers the whole session");

summary = latency.sample({ packetsReceived: 50, packetsLost: 0, framesReceived: 5, framesDecoded: 5 }, null);
close(summary.packetLossPercent, 0, "a counter that went backwards belongs to a new receiver");
assert.strictEqual(summary.roundTripMs, null, "no round trip, no network estimate");
assert.strictEqual(summary.networkMs, null);

latency.reset();
summary = latency.sample(null, null);
assert.strictEqual(summary.totalMs, null, "a reset session has nothing to report");
assert.strictEqual(summary.averageTotalMs, null);
assert.strictEqual(summary.includesDisplay, false);
assert.strictEqual(summary.packetLossPercent, null);

function reports(list) {
  return { forEach: function (callback) { list.forEach(callback); } };
}
assert.strictEqual(StreamLatency.roundTripSeconds(reports([
  { type: "transport", selectedCandidatePairId: "b" },
  { type: "candidate-pair", id: "a", nominated: true, state: "succeeded", currentRoundTripTime: 0.1 },
  { type: "candidate-pair", id: "b", nominated: true, state: "succeeded", currentRoundTripTime: 0.003 },
])), 0.003, "the transport's selected pair is the one carrying the stream");
assert.strictEqual(StreamLatency.roundTripSeconds(reports([
  { type: "candidate-pair", id: "a", nominated: false, state: "succeeded", currentRoundTripTime: 0.1 },
  { type: "candidate-pair", id: "b", nominated: true, state: "succeeded", currentRoundTripTime: 0.002 },
])), 0.002, "without a transport report the nominated pair is");
assert.strictEqual(StreamLatency.roundTripSeconds(reports([])), null);

console.log("Tizen stream latency tests passed");
