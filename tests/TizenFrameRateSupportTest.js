"use strict";

const assert = require("assert");

global.window = global;
require("../tizen/frame-rate-support.js");
const FrameRateSupport = global.FrameRateSupport;

const modes = [
  { width: 1920, height: 1080, fps: 60, frameRates: [30, 60, 90, 120], codecs: ["h264", "hevc"], defaultBitrateKbps: 20000 },
  { width: 3840, height: 2160, fps: 60, frameRates: [30, 60, 90, 120], codecs: ["hevc"], defaultBitrateKbps: 50000 },
];

// A decoder that sustains 120 fps up to 1080p and 60 fps at 4K, and rejects WebRTC-type queries.
function samsungLikeDecoder(queries) {
  return {
    decodingInfo: function (config) {
      queries.push(config.type);
      if (config.type === "webrtc") {
        return Promise.reject(new TypeError("unsupported type"));
      }
      const video = config.video;
      const limit = video.width * video.height > 1920 * 1080 ? 60 : 120;
      const smooth = video.framerate <= limit;
      return Promise.resolve({ supported: smooth, smooth: smooth, powerEfficient: smooth });
    },
  };
}

(async function () {
  assert.deepStrictEqual(FrameRateSupport.frameRatesOf({ fps: 60 }), [60],
    "a server from before frame-rate selection offers its single fps");
  assert.deepStrictEqual(FrameRateSupport.frameRatesOf(modes[0]), [30, 60, 90, 120]);

  const silent = FrameRateSupport.create({ mediaCapabilities: undefined });
  assert.strictEqual(await silent.probe(modes), false, "a TV without Media Capabilities announces nothing");
  assert.strictEqual(silent.maximumRate(modes[0], "h264"), null, "so the user chooses the frame rate");

  const yesToEverything = FrameRateSupport.create({
    mediaCapabilities: { decodingInfo: function () { return Promise.resolve({ supported: true, smooth: true }); } },
  });
  assert.strictEqual(await yesToEverything.probe(modes), false,
    "a TV that accepts 4K at 240 fps is not weighing the frame rate, so its answers are ignored");
  assert.strictEqual(yesToEverything.maximumRate(modes[1], "hevc"), null);

  const queries = [];
  const samsung = FrameRateSupport.create({ mediaCapabilities: samsungLikeDecoder(queries) });
  assert.strictEqual(await samsung.probe(modes), true, "a TV that weighs the frame rate announces its maximums");
  assert.ok(queries.indexOf("media-source") >= 0, "a TV that rejects WebRTC-type queries is asked about Media Source");
  assert.strictEqual(samsung.maximumRate(modes[0], "h264"), 120, "1080p runs at the TV's 120 fps");
  assert.strictEqual(samsung.maximumRate(modes[0], "hevc"), 120);
  assert.strictEqual(samsung.maximumRate(modes[1], "hevc"), 60, "4K stays at what the TV sustains there");
  assert.strictEqual(samsung.maximumRate(modes[1], "av1"), null, "a codec that was not asked about announces nothing");

  console.log("Tizen frame rate support tests passed");
}()).catch(function (error) {
  console.error(error);
  process.exit(1);
});
