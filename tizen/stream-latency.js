(function (global) {
  "use strict";

  // Where the time goes between Sunshine sending a frame and the TV showing it, as far as the
  // TV can see. The TV cannot see the PC's capture and encode time, so every figure here
  // starts when the frame leaves the PC.
  //
  // - Network: half the round trip, the usual one-way estimate.
  // - Jitter buffer, decode: averages over the last sample window, from getStats().
  // - To screen: from the last packet of a frame arriving to the frame being composited,
  //   measured per frame by requestVideoFrameCallback. This is the one that counts drawing.
  //   A TV without that API falls back to arrival-to-decoded, and says so.
  // - Total: network plus to screen. Average: the mean of every total this session.

  // A presented-frame measurement outside this range is a clock glitch, not a latency.
  const MAX_PLAUSIBLE_MS = 2000;

  function create() {
    let previous;
    let previousTimestamp;
    let presented;
    let totals;

    function reset() {
      previous = {
        packetsReceived: 0,
        packetsLost: 0,
        framesReceived: 0,
        framesDropped: 0,
        framesDecoded: 0,
        totalDecodeTime: 0,
        jitterBufferDelay: 0,
        jitterBufferEmittedCount: 0,
        totalProcessingDelay: 0,
      };
      previousTimestamp = null;
      presented = { sum: 0, count: 0, max: 0, supported: false };
      totals = { sum: 0, count: 0 };
    }

    // Called from requestVideoFrameCallback with its metadata.
    function recordPresentedFrame(metadata) {
      if (!metadata || typeof metadata.receiveTime !== "number" || metadata.receiveTime <= 0) {
        return;
      }
      const shownAt = typeof metadata.expectedDisplayTime === "number"
        ? metadata.expectedDisplayTime
        : metadata.presentationTime;
      if (typeof shownAt !== "number") {
        return;
      }
      const elapsed = shownAt - metadata.receiveTime;
      if (elapsed < 0 || elapsed > MAX_PLAUSIBLE_MS) {
        return;
      }
      presented.supported = true;
      presented.sum += elapsed;
      presented.count += 1;
      presented.max = Math.max(presented.max, elapsed);
    }

    function number(report, name) {
      return report && typeof report[name] === "number" ? report[name] : null;
    }

    // Change of a cumulative counter since the last sample. A counter that went backwards
    // belongs to a new receiver, so the whole value is the change.
    function delta(report, name) {
      const value = number(report, name);
      if (value === null) {
        return null;
      }
      const change = value - previous[name];
      previous[name] = value;
      return change < 0 ? value : change;
    }

    function ratio(numerator, denominator, scale) {
      return numerator !== null && denominator !== null && denominator > 0
        ? (numerator * scale) / denominator
        : null;
    }

    function sample(inboundVideo, roundTripSeconds) {
      const sessionReceived = number(inboundVideo, "packetsReceived");
      const sessionLost = number(inboundVideo, "packetsLost");
      const packetsReceived = delta(inboundVideo, "packetsReceived");
      const packetsLost = delta(inboundVideo, "packetsLost");
      const framesReceived = delta(inboundVideo, "framesReceived");
      const framesDropped = delta(inboundVideo, "framesDropped");
      const framesDecoded = delta(inboundVideo, "framesDecoded");
      const decodeTime = delta(inboundVideo, "totalDecodeTime");
      const bufferDelay = delta(inboundVideo, "jitterBufferDelay");
      const emitted = delta(inboundVideo, "jitterBufferEmittedCount");
      const processingDelay = delta(inboundVideo, "totalProcessingDelay");

      // Frames that arrived per second, over the time the reports themselves cover.
      const timestamp = number(inboundVideo, "timestamp");
      const elapsedSeconds = timestamp !== null && previousTimestamp !== null
        && timestamp > previousTimestamp ? (timestamp - previousTimestamp) / 1000 : null;
      previousTimestamp = timestamp;
      const receivedFps = ratio(framesReceived, elapsedSeconds, 1);

      const roundTripMs = typeof roundTripSeconds === "number" ? roundTripSeconds * 1000 : null;
      const networkMs = roundTripMs === null ? null : roundTripMs / 2;
      const jitterBufferMs = ratio(bufferDelay, emitted, 1000);
      const decodeMs = ratio(decodeTime, framesDecoded, 1000);
      const processingMs = ratio(processingDelay, emitted, 1000);
      const displayMs = presented.count > 0 ? presented.sum / presented.count : null;
      const displayMaxMs = presented.count > 0 ? presented.max : null;
      const displaySupported = presented.supported;
      presented.sum = 0;
      presented.count = 0;
      presented.max = 0;

      // Drawing included when the TV reports it; otherwise as far as the decoder.
      const tvMs = displayMs !== null ? displayMs : processingMs;
      let totalMs = null;
      if (tvMs !== null) {
        totalMs = tvMs + (networkMs || 0);
        totals.sum += totalMs;
        totals.count += 1;
      }

      const lostShare = packetsLost !== null && packetsReceived !== null
        ? ratio(packetsLost, packetsReceived + packetsLost, 100)
        : null;
      const sessionLostShare = sessionLost !== null && sessionReceived !== null
        ? ratio(sessionLost, sessionReceived + sessionLost, 100)
        : null;

      return {
        roundTripMs: roundTripMs,
        networkMs: networkMs,
        jitterBufferMs: jitterBufferMs,
        decodeMs: decodeMs,
        processingMs: processingMs,
        displayMs: displayMs,
        displayMaxMs: displayMaxMs,
        includesDisplay: displayMs !== null || displaySupported,
        totalMs: totalMs,
        averageTotalMs: totals.count > 0 ? totals.sum / totals.count : null,
        packetLossPercent: lostShare === null ? null : Math.max(0, lostShare),
        sessionPacketLossPercent: sessionLostShare === null ? null : Math.max(0, sessionLostShare),
        framesDroppedPercent: ratio(framesDropped, framesReceived, 100),
        receivedFps: receivedFps,
      };
    }

    reset();
    return { reset: reset, recordPresentedFrame: recordPresentedFrame, sample: sample };
  }

  // The round trip of the candidate pair carrying the stream, in seconds, or null.
  function roundTripSeconds(reports) {
    let selectedPairId = null;
    const pairs = {};
    let nominated = null;
    reports.forEach(function (report) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      } else if (report.type === "candidate-pair") {
        pairs[report.id] = report;
        if (report.nominated && report.state === "succeeded" && !nominated) {
          nominated = report;
        }
      }
    });
    const pair = (selectedPairId && pairs[selectedPairId]) || nominated;
    return pair && typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime : null;
  }

  global.StreamLatency = { create: create, roundTripSeconds: roundTripSeconds };
}(window));
