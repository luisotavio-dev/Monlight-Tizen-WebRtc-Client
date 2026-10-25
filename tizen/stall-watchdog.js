(function (global) {
  "use strict";

  // Notices a picture that has stopped while video keeps arriving, and says what to do about it.
  //
  // The TV's WebRTC stack is supposed to ask for a keyframe on its own (a PLI) when it cannot
  // decode, but a picture can also stop without the decoder failing: frames decode and are
  // never shown, and nothing in the stack asks for anything. Seen from the couch both are a
  // black screen with the audio still playing, lasting until the next keyframe the host
  // happens to send for some unrelated reason. So the app watches for itself, escalating:
  // first it asks the host for a keyframe, which cures a decoder waiting on a missing
  // reference; then, if the picture still does not move, it re-attaches the stream to the
  // video element, which rebuilds the renderer behind it.
  //
  // A counter is only trusted once it has been seen advancing. A TV that never reports one
  // would otherwise look permanently stalled, and the watchdog would turn a healthy stream
  // into one that is re-attached every few seconds.

  const STALL_MS = 1000;
  const KEYFRAME_RETRY_MS = 1000;
  const REATTACH_AFTER_MS = 2500;
  const REATTACH_RETRY_MS = 5000;

  function isCount(value) {
    return typeof value === "number" && isFinite(value);
  }

  function StallWatchdog() {
    this.reset();
  }

  StallWatchdog.prototype.reset = function () {
    this.previous = null;
    this.decodedTrusted = false;
    this.presentedTrusted = false;
    this.stalledSince = null;
    this.stallCounted = false;
    this.lastKeyframeAt = null;
    this.lastReattachAt = null;
    this.stalls = 0;
    this.keyframeRequests = 0;
    this.reattachments = 0;
    this.lastStallMs = 0;
  };

  // sample: { time, bytesReceived, framesDecoded, framesPresented }, any counter may be
  // missing. Returns { action: "none" | "keyframe" | "reattach", stalledMs, decoding }.
  StallWatchdog.prototype.sample = function (sample) {
    const previous = this.previous;
    this.previous = sample;
    if (!previous || !isCount(sample.time) || sample.time <= previous.time) {
      return { action: "none", stalledMs: 0, decoding: true };
    }
    const advanced = function (name) {
      return isCount(sample[name]) && isCount(previous[name]) && sample[name] > previous[name];
    };
    const decodedAdvanced = advanced("framesDecoded");
    const presentedAdvanced = advanced("framesPresented");
    this.decodedTrusted = this.decodedTrusted || decodedAdvanced;
    this.presentedTrusted = this.presentedTrusted || presentedAdvanced;
    const decoding = !this.decodedTrusted || decodedAdvanced;
    const presenting = !this.presentedTrusted || presentedAdvanced;

    if (decoding && presenting) {
      if (this.stalledSince !== null && this.stallCounted) {
        this.lastStallMs = sample.time - this.stalledSince;
      }
      this.stalledSince = null;
      this.stallCounted = false;
      this.lastKeyframeAt = null;
      this.lastReattachAt = null;
      return { action: "none", stalledMs: 0, decoding: true };
    }
    // Nothing arriving is the network's or the host's doing, and neither a keyframe request
    // nor a new renderer would bring the picture back.
    if (!advanced("bytesReceived")) {
      return { action: "none", stalledMs: 0, decoding: decoding };
    }
    if (this.stalledSince === null) {
      this.stalledSince = previous.time;
    }
    const stalledMs = sample.time - this.stalledSince;
    if (stalledMs < STALL_MS) {
      return { action: "none", stalledMs: stalledMs, decoding: decoding };
    }
    if (!this.stallCounted) {
      this.stallCounted = true;
      this.stalls += 1;
    }
    if (stalledMs >= REATTACH_AFTER_MS
      && (this.lastReattachAt === null || sample.time - this.lastReattachAt >= REATTACH_RETRY_MS)) {
      // The app asks for a keyframe along with every re-attachment, so it restarts that clock.
      this.lastReattachAt = sample.time;
      this.lastKeyframeAt = sample.time;
      this.reattachments += 1;
      return { action: "reattach", stalledMs: stalledMs, decoding: decoding };
    }
    if (this.lastKeyframeAt === null || sample.time - this.lastKeyframeAt >= KEYFRAME_RETRY_MS) {
      this.lastKeyframeAt = sample.time;
      this.keyframeRequests += 1;
      return { action: "keyframe", stalledMs: stalledMs, decoding: decoding };
    }
    return { action: "none", stalledMs: stalledMs, decoding: decoding };
  };

  StallWatchdog.prototype.counters = function () {
    return {
      stalls: this.stalls,
      keyframeRequests: this.keyframeRequests,
      reattachments: this.reattachments,
      lastStallMs: this.lastStallMs,
      stalled: this.stallCounted,
    };
  };

  global.StallWatchdog = {
    create: function () { return new StallWatchdog(); },
    STALL_MS: STALL_MS,
    KEYFRAME_RETRY_MS: KEYFRAME_RETRY_MS,
    REATTACH_AFTER_MS: REATTACH_AFTER_MS,
    REATTACH_RETRY_MS: REATTACH_RETRY_MS,
  };
}(window));
