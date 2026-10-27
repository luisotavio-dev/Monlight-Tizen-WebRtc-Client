#pragma once

#include "media/MediaSender.h"

#include <functional>
#include <memory>
#include <string_view>

namespace rtc {
class RtpPacketizationConfig;
class RtpPacketizer;
class Track;
}

namespace gateway {

inline constexpr std::string_view WebRtcColorSpaceExtensionUri =
    "http://www.webrtc.org/experiments/rtp-hdrext/color-space";
inline constexpr int PreferredWebRtcColorSpaceExtensionId = 9;
inline constexpr std::string_view WebRtcPlayoutDelayExtensionUri =
    "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay";
inline constexpr int PreferredWebRtcPlayoutDelayExtensionId = 6;

class WebRtcMediaSender final : public MediaSender {
public:
    WebRtcMediaSender(std::shared_ptr<rtc::Track> videoTrack,
                      std::shared_ptr<rtc::Track> audioTrack,
                      VideoCodec videoCodec);

    void sendVideoAccessUnit(VideoCodec codec,
                             std::span<const std::uint8_t> accessUnit,
                             std::uint32_t rtpTimestamp) override;
    void sendOpusPacket(std::span<const std::uint8_t> packet,
                        std::uint32_t rtpTimestamp) override;

private:
    std::shared_ptr<rtc::Track> videoTrack_;
    std::shared_ptr<rtc::Track> audioTrack_;
    VideoCodec videoCodec_;
};

std::shared_ptr<rtc::RtpPacketizer> makeVideoRtpPacketizer(
    VideoCodec codec,
    const std::shared_ptr<rtc::RtpPacketizationConfig>& rtpConfiguration);
void configureHdrRtpColorSpace(
    const std::shared_ptr<rtc::RtpPacketizationConfig>& rtpConfiguration,
    int negotiatedExtensionId);
void disableRtpColorSpace(
    const std::shared_ptr<rtc::RtpPacketizationConfig>& rtpConfiguration);
// Zero playout delay: the receiver shows each frame as soon as it is decoded instead of
// holding it for its jitter estimate. An ID of 0 disables the extension.
void configureRtpPlayoutDelay(
    const std::shared_ptr<rtc::RtpPacketizationConfig>& rtpConfiguration,
    int negotiatedExtensionId);

} // namespace gateway
