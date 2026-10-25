"use strict";

const assert = require("assert");

global.window = global;
require("../tizen/stall-watchdog.js");
const StallWatchdog = global.StallWatchdog;

// Feeds one sample every 500 ms, as the app does, and returns the actions taken.
function run(watchdog, samples) {
  return samples.map(function (sample, index) {
    return watchdog.sample(Object.assign({ time: index * 500 }, sample)).action;
  });
}

function healthy(index) {
  return { bytesReceived: index * 1000, framesDecoded: index * 30, framesPresented: index * 30 };
}

// A healthy stream is never touched.
{
  const watchdog = StallWatchdog.create();
  const actions = run(watchdog, [0, 1, 2, 3, 4, 5, 6, 7].map(healthy));
  assert.deepStrictEqual(actions, ["none", "none", "none", "none", "none", "none", "none", "none"]);
  assert.strictEqual(watchdog.counters().stalls, 0);
}

// A decoder that stops while video arrives gets a keyframe after a second, again every
// second, and the renderer re-attached once the stall reaches 2.5 s.
{
  const watchdog = StallWatchdog.create();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 10; index += 1) {
    samples.push({ bytesReceived: index * 1000, framesDecoded: 30, framesPresented: 30 });
  }
  const actions = run(watchdog, samples);
  // The stall starts at the last healthy sample (500 ms): 1 s at 1500 ms, 2.5 s at 3000 ms.
  assert.deepStrictEqual(actions,
    ["none", "none", "none", "keyframe", "none", "keyframe", "reattach", "none", "keyframe", "none"]);
  const counters = watchdog.counters();
  assert.strictEqual(counters.stalls, 1, "one stall, however many actions it took");
  assert.strictEqual(counters.keyframeRequests, 3);
  assert.strictEqual(counters.reattachments, 1);
  assert.strictEqual(counters.stalled, true);
  assert.strictEqual(watchdog.sample({ time: 5000, bytesReceived: 20000, framesDecoded: 60, framesPresented: 60 }).action, "none");
  assert.strictEqual(watchdog.counters().stalled, false, "the picture moving again ends the stall");
  assert.strictEqual(watchdog.counters().lastStallMs, 4500);
}

// Frames that decode but never reach the screen are a stall too, reported as decoding.
{
  const watchdog = StallWatchdog.create();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 5; index += 1) {
    samples.push({ bytesReceived: index * 1000, framesDecoded: index * 30, framesPresented: 30 });
  }
  let verdict = null;
  samples.forEach(function (sample, index) {
    const result = watchdog.sample(Object.assign({ time: index * 500 }, sample));
    if (result.action !== "none") {
      verdict = result;
    }
  });
  assert.strictEqual(verdict.action, "keyframe");
  assert.strictEqual(verdict.decoding, true);
}

// Nothing arriving is not the TV's stall to recover.
{
  const watchdog = StallWatchdog.create();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 10; index += 1) {
    samples.push({ bytesReceived: 1000, framesDecoded: 30, framesPresented: 30 });
  }
  assert.ok(run(watchdog, samples).every(function (action) { return action === "none"; }));
  assert.strictEqual(watchdog.counters().stalls, 0);
}

// A counter the TV never advances is ignored rather than read as a permanent stall.
{
  const watchdog = StallWatchdog.create();
  const samples = [];
  for (let index = 0; index < 10; index += 1) {
    samples.push({ bytesReceived: index * 1000, framesDecoded: index * 30, framesPresented: 0 });
  }
  assert.ok(run(watchdog, samples).every(function (action) { return action === "none"; }),
    "a presented-frame counter stuck from the start is never trusted");
  const missing = StallWatchdog.create();
  const unreported = [];
  for (let index = 0; index < 10; index += 1) {
    unreported.push({ bytesReceived: index * 1000 });
  }
  assert.ok(run(missing, unreported).every(function (action) { return action === "none"; }),
    "a TV reporting no frame counters at all is never acted on");
}

// reset() forgets a previous session's stall and counters.
{
  const watchdog = StallWatchdog.create();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 6; index += 1) {
    samples.push({ bytesReceived: index * 1000, framesDecoded: 30, framesPresented: 30 });
  }
  run(watchdog, samples);
  assert.ok(watchdog.counters().stalls > 0);
  watchdog.reset();
  assert.deepStrictEqual(watchdog.counters(),
    { stalls: 0, keyframeRequests: 0, reattachments: 0, lastStallMs: 0, stalled: false });
  assert.strictEqual(watchdog.sample({ time: 0, bytesReceived: 0, framesDecoded: 0 }).action, "none");
}

console.log("TizenStallWatchdogTest passed");
