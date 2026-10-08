// Wake-on-LAN sender and PC discovery for the Tizen client.
//
// A Tizen web application cannot send a UDP datagram from JavaScript. Samsung's Tizen Sockets
// extension exposes POSIX sockets to WebAssembly instead, but refuses them on the browser main
// thread, so every request runs on its own detached pthread and its outcome is posted back to
// the main thread: Module.onWakeResult(requestId, sentCount, errorCode) for a wake, and
// Module.onDiscoveryReply(requestId, address, json) then Module.onDiscoveryDone(requestId,
// replyCount, errorCode) for a discovery.
//
// The Wake-on-LAN destinations follow BrightCraft Moonlight Tizen's implementation.

#include <arpa/inet.h>
#include <emscripten.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

enum {
    MacAddressSize = 6,
    MagicPacketSize = 6 + 16 * MacAddressSize,
    WakeOnLanPort = 9,
    DiscoveryReplyLimit = 512,
    DiscoveryMaxReplies = 16,
    DiscoveryPollMs = 200,
};

typedef struct {
    int requestId;
    unsigned char macAddress[MacAddressSize];
    char unicastAddress[INET_ADDRSTRLEN];
} WakeRequest;

typedef struct {
    int sent;
    int error;
} SendResult;

static void recordSend(SendResult* result, ssize_t bytes)
{
    if (bytes == MagicPacketSize) {
        result->sent += 1;
    } else if (result->error == 0) {
        result->error = bytes < 0 ? errno : EIO;
    }
}

static void sendIpv4(const unsigned char* packet, const char* unicastAddress, SendResult* result)
{
    const int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        result->error = errno;
        return;
    }

    struct sockaddr_in destination;
    memset(&destination, 0, sizeof(destination));
    destination.sin_family = AF_INET;
    destination.sin_port = htons(WakeOnLanPort);

    // The limited broadcast reaches a sleeping PC whose address has aged out of every ARP cache.
    const int broadcast = 1;
    if (setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast)) == 0) {
        destination.sin_addr.s_addr = htonl(INADDR_BROADCAST);
        recordSend(result, sendto(sock, packet, MagicPacketSize, 0,
                                  (const struct sockaddr*)&destination, sizeof(destination)));
    } else if (result->error == 0) {
        result->error = errno;
    }

    // Unicast to the Gateway's last address still arrives on networks that drop broadcasts,
    // for as long as the TV (or the router) remembers which MAC address owns that IP.
    if (unicastAddress[0] != '\0'
        && inet_pton(AF_INET, unicastAddress, &destination.sin_addr) == 1) {
        recordSend(result, sendto(sock, packet, MagicPacketSize, 0,
                                  (const struct sockaddr*)&destination, sizeof(destination)));
    }
    close(sock);
}

static void sendIpv6(const unsigned char* packet, SendResult* result)
{
    const int sock = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        return;
    }
    // Some access points filter IPv4 broadcast but still forward the all-nodes multicast group.
    struct sockaddr_in6 destination;
    memset(&destination, 0, sizeof(destination));
    destination.sin6_family = AF_INET6;
    destination.sin6_port = htons(WakeOnLanPort);
    if (inet_pton(AF_INET6, "ff02::1", &destination.sin6_addr) == 1) {
        recordSend(result, sendto(sock, packet, MagicPacketSize, 0,
                                  (const struct sockaddr*)&destination, sizeof(destination)));
    }
    close(sock);
}

static void* sendWakeRequest(void* argument)
{
    WakeRequest* request = (WakeRequest*)argument;

    unsigned char packet[MagicPacketSize];
    memset(packet, 0xFF, MacAddressSize);
    for (int repetition = 1; repetition <= 16; ++repetition) {
        memcpy(packet + repetition * MacAddressSize, request->macAddress, MacAddressSize);
    }

    SendResult result = {0, 0};
    sendIpv4(packet, request->unicastAddress, &result);
    sendIpv6(packet, &result);

    MAIN_THREAD_ASYNC_EM_ASM({ Module["onWakeResult"]($0, $1, $2); },
                             request->requestId, result.sent, result.error);
    free(request);
    return NULL;
}

// Returns 0 when the request was queued; its outcome arrives through Module.onWakeResult.
EMSCRIPTEN_KEEPALIVE int wol_send(int requestId,
                                  const unsigned char* macAddress,
                                  const char* unicastAddress)
{
    WakeRequest* request = (WakeRequest*)calloc(1, sizeof(WakeRequest));
    if (request == NULL) {
        return ENOMEM;
    }
    request->requestId = requestId;
    memcpy(request->macAddress, macAddress, MacAddressSize);
    if (unicastAddress != NULL) {
        strncpy(request->unicastAddress, unicastAddress, sizeof(request->unicastAddress) - 1);
    }

    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    const int status = pthread_create(&thread, &attributes, sendWakeRequest, request);
    pthread_attr_destroy(&attributes);
    if (status != 0) {
        free(request);
        return status;
    }
    return 0;
}

typedef struct {
    int requestId;
    int port;
    int timeoutMs;
} DiscoveryRequest;

static long long monotonicMs(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

// Broadcasts one discovery request and reports every reply until the timeout. Sunshine-Web-RTC
// answers from the address the TV should connect to, so that address comes with each reply.
static void* runDiscovery(void* argument)
{
    DiscoveryRequest* request = (DiscoveryRequest*)argument;
    static const char query[] = "{\"version\":2,\"type\":\"discover\"}";
    int error = 0;
    int replies = 0;

    const int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        error = errno;
    } else {
        struct sockaddr_in destination;
        memset(&destination, 0, sizeof(destination));
        destination.sin_family = AF_INET;
        destination.sin_port = htons((unsigned short)request->port);
        destination.sin_addr.s_addr = htonl(INADDR_BROADCAST);

        const int broadcast = 1;
        // A short receive timeout lets the loop notice the deadline without a reply.
        struct timeval wait = { 0, DiscoveryPollMs * 1000 };
        if (setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast)) != 0
            || setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &wait, sizeof(wait)) != 0
            || sendto(sock, query, sizeof(query) - 1, 0,
                      (const struct sockaddr*)&destination, sizeof(destination)) < 0) {
            error = errno;
        } else {
            const long long deadline = monotonicMs() + request->timeoutMs;
            char reply[DiscoveryReplyLimit + 1];
            while (monotonicMs() < deadline && replies < DiscoveryMaxReplies) {
                struct sockaddr_in source;
                socklen_t sourceLength = sizeof(source);
                const ssize_t size = recvfrom(sock, reply, DiscoveryReplyLimit, 0,
                                              (struct sockaddr*)&source, &sourceLength);
                if (size <= 0) {
                    continue;
                }
                reply[size] = '\0';
                char address[INET_ADDRSTRLEN];
                if (inet_ntop(AF_INET, &source.sin_addr, address, sizeof(address)) == NULL) {
                    continue;
                }
                // Synchronous, so the buffers stay valid while the main thread reads them.
                MAIN_THREAD_EM_ASM({ Module["onDiscoveryReply"]($0, UTF8ToString($1), UTF8ToString($2)); },
                                   request->requestId, address, reply);
                replies += 1;
            }
        }
        close(sock);
    }

    MAIN_THREAD_ASYNC_EM_ASM({ Module["onDiscoveryDone"]($0, $1, $2); },
                             request->requestId, replies, error);
    free(request);
    return NULL;
}

// Returns 0 when the discovery was started; replies arrive through Module.onDiscoveryReply.
EMSCRIPTEN_KEEPALIVE int net_discover(int requestId, int port, int timeoutMs)
{
    DiscoveryRequest* request = (DiscoveryRequest*)calloc(1, sizeof(DiscoveryRequest));
    if (request == NULL) {
        return ENOMEM;
    }
    request->requestId = requestId;
    request->port = port;
    request->timeoutMs = timeoutMs;

    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    const int status = pthread_create(&thread, &attributes, runDiscovery, request);
    pthread_attr_destroy(&attributes);
    if (status != 0) {
        free(request);
        return status;
    }
    return 0;
}
