(function (global) {
  "use strict";

  // Asks the TV's own decoder which frame rates it can sustain, so a stream never runs faster
  // than the TV can show it. Samsung exposes no "panel refresh rate" API to web apps; Media
  // Capabilities is the closest thing the TV announces, and only when it actually weighs the
  // frame rate. A TV that says yes to 4K at 240 fps is not weighing it, and its answers are
  // ignored: the user then picks the frame rate.

  const IMPLAUSIBLE_RATE = 240;

  // Media Source descriptions for when the TV does not understand WebRTC-type queries.
  const MEDIA_SOURCE_TYPES = {
    h264: 'video/mp4; codecs="avc1.640033"',
    hevc: 'video/mp4; codecs="hvc1.2.4.L156.B0"',
    av1: 'video/mp4; codecs="av01.0.13M.10"',
  };
  const WEBRTC_TYPES = { h264: "video/H264", hevc: "video/H265", av1: "video/AV1" };

  function create(options) {
    const mediaCapabilities = options.mediaCapabilities;
    const log = options.log || function () {};
    let announced = false;
    let maximums = {};
    let queryType = "webrtc";

    function key(mode, codec) {
      return String(mode.width) + "x" + String(mode.height) + ":" + codec;
    }

    function query(codec, width, height, framerate, bitrate) {
      const config = {
        type: queryType,
        video: {
          contentType: (queryType === "webrtc" ? WEBRTC_TYPES : MEDIA_SOURCE_TYPES)[codec],
          width: width,
          height: height,
          bitrate: bitrate,
          framerate: framerate,
        },
      };
      return Promise.resolve(mediaCapabilities.decodingInfo(config)).then(function (info) {
        return Boolean(info && info.supported && info.smooth);
      });
    }

    // Chooses the query type the TV understands: WebRTC when it accepts it, else Media Source.
    function chooseQueryType() {
      return query("h264", 1280, 720, 60, 12000000).catch(function () {
        queryType = "media-source";
        return query("h264", 1280, 720, 60, 12000000);
      });
    }

    function highestRate(mode, codec) {
      const rates = frameRatesOf(mode).slice().sort(function (a, b) { return b - a; });
      const bitrate = (mode.defaultBitrateKbps || 20000) * 1000;
      return rates.reduce(function (found, rate) {
        return found.then(function (best) {
          return best !== null ? best : query(codec, mode.width, mode.height, rate, bitrate)
            .then(function (smooth) { return smooth ? rate : null; }, function () { return null; });
        });
      }, Promise.resolve(null));
    }

    // Resolves once every mode and codec has been asked; until then nothing is announced.
    function probe(modes) {
      announced = false;
      maximums = {};
      if (!mediaCapabilities || typeof mediaCapabilities.decodingInfo !== "function") {
        log("Frame rate: the TV announces no decoder capabilities; the frame rate is selectable");
        return Promise.resolve(false);
      }
      return chooseQueryType().then(function () {
        return query("hevc", 3840, 2160, IMPLAUSIBLE_RATE, 50000000).catch(function () { return true; });
      }).then(function (acceptsAnything) {
        if (acceptsAnything) {
          log("Frame rate: the TV's decoder answers do not depend on the frame rate; the frame rate is selectable");
          return false;
        }
        const pairs = [];
        modes.forEach(function (mode) {
          (mode.codecs || []).forEach(function (codec) {
            pairs.push({ mode: mode, codec: codec });
          });
        });
        return Promise.all(pairs.map(function (pair) {
          return highestRate(pair.mode, pair.codec).then(function (rate) {
            if (rate !== null) {
              maximums[key(pair.mode, pair.codec)] = rate;
            }
          });
        })).then(function () {
          announced = Object.keys(maximums).length > 0;
          log("Frame rate: TV maximums (" + queryType + ") " + JSON.stringify(maximums));
          return announced;
        });
      }).catch(function (error) {
        log("Frame rate: decoder query failed (" + (error && error.message ? error.message : error) + ")");
        announced = false;
        return false;
      });
    }

    // The TV's highest smooth rate for a mode and codec, or null when the TV announces none.
    function maximumRate(mode, codec) {
      if (!announced || !mode) {
        return null;
      }
      const value = maximums[key(mode, codec)];
      return typeof value === "number" ? value : null;
    }

    return { probe: probe, maximumRate: maximumRate, isAnnounced: function () { return announced; } };
  }

  // A server from before frame-rate selection sends one fps per mode.
  function frameRatesOf(mode) {
    if (mode && Array.isArray(mode.frameRates) && mode.frameRates.length > 0) {
      return mode.frameRates.filter(function (rate) { return Number.isInteger(rate) && rate > 0; });
    }
    return [mode && Number.isInteger(mode.fps) ? mode.fps : 60];
  }

  global.FrameRateSupport = { create: create, frameRatesOf: frameRatesOf, IMPLAUSIBLE_RATE: IMPLAUSIBLE_RATE };
}(window));
