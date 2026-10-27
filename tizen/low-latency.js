(function (global) {
  "use strict";

  // Two things the TV's WebRTC stack does by default that a game stream does not want.
  //
  // 1. Lip sync. Sunshine sends audio and video in one media stream, and WebRTC then holds
  //    every video frame back until the audio playing next to it catches up. The audio jitter
  //    buffer is the deeper of the two, so the picture inherits its delay. Moonlight never
  //    syncs the two either: in a game, a late picture costs more than a few milliseconds of
  //    audio drift. Moving the audio into a stream of its own ends the sync.
  // 2. The video jitter buffer. It aims for smooth playback and grows with any jitter it sees.
  //    Asking for no extra delay keeps it at what the network actually needs.

  const AUDIO_STREAM_SUFFIX = "-audio";

  // Renames the media stream of every audio section in an offer, so audio and video no longer
  // share a sync group. An offer without stream ids is returned unchanged.
  function separateAudioSync(sdp) {
    if (typeof sdp !== "string") {
      return sdp;
    }
    const newline = sdp.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    let inAudio = false;
    return sdp.split(newline).map(function (line) {
      if (line.indexOf("m=") === 0) {
        inAudio = line.indexOf("m=audio") === 0;
        return line;
      }
      if (!inAudio) {
        return line;
      }
      return line
        .replace(/^(a=msid:)(\S+)/, function (match, prefix, stream) {
          return prefix + renamed(stream);
        })
        .replace(/^(a=ssrc:\d+ msid:)(\S+)/, function (match, prefix, stream) {
          return prefix + renamed(stream);
        });
    }).join(newline);
  }

  function renamed(stream) {
    // "-" is the "no stream" id; there is nothing to sync and nothing to rename.
    if (stream === "-" || stream.slice(-AUDIO_STREAM_SUFFIX.length) === AUDIO_STREAM_SUFFIX) {
      return stream;
    }
    return stream + AUDIO_STREAM_SUFFIX;
  }

  // Asks a receiver for the shortest jitter buffer it allows. Newer Chromium takes
  // jitterBufferTarget in milliseconds; the TVs on older Chromium only know playoutDelayHint,
  // in seconds. Returns which one was applied, or null when the TV has neither.
  function minimizeReceiverDelay(receiver) {
    if (!receiver) {
      return null;
    }
    try {
      if ("jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = 0;
        return "jitterBufferTarget";
      }
      if ("playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = 0;
        return "playoutDelayHint";
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  global.LowLatency = {
    separateAudioSync: separateAudioSync,
    minimizeReceiverDelay: minimizeReceiverDelay,
  };
}(window));
