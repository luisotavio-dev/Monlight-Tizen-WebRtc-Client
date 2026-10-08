"use strict";

const assert = require("assert");

global.window = global;
require("../tizen/wake-on-lan.js");

const WakeOnLan = global.WakeOnLan;

assert.strictEqual(WakeOnLan.normalizeMacAddress("2c-f0-5d-7b-e6-d0"), "2C:F0:5D:7B:E6:D0",
  "a Windows-style address must be accepted in canonical form");
assert.strictEqual(WakeOnLan.normalizeMacAddress(" 2C:F0:5D:7B:E6:D0 "), "2C:F0:5D:7B:E6:D0",
  "surrounding whitespace must not invalidate an address");
[undefined, null, 42, "", "2C:F0:5D:7B:E6", "2C:F0-5D:7B:E6:D0", "2C:F0:5D:7B:E6:G0",
  "00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "01:00:5E:00:00:01"].forEach(function (value) {
  assert.strictEqual(WakeOnLan.normalizeMacAddress(value), null,
    String(value) + " cannot identify one network adapter");
});

const packet = WakeOnLan.testing.buildMagicPacket("2C:F0:5D:7B:E6:D0");
assert.strictEqual(packet.length, 102, "a magic packet is 6 sync bytes and 16 copies of the MAC");
assert.deepStrictEqual(Array.from(packet.slice(0, 6)), [255, 255, 255, 255, 255, 255],
  "a magic packet must start with the synchronization stream");
for (let repetition = 1; repetition <= 16; repetition += 1) {
  assert.deepStrictEqual(Array.from(packet.slice(repetition * 6, repetition * 6 + 6)),
    [0x2C, 0xF0, 0x5D, 0x7B, 0xE6, 0xD0], "every repetition must carry the target MAC");
}

// A stand-in for the Emscripten module: it records calls and answers the way the pthread does.
function fakeEnvironment(options) {
  const settings = options || {};
  const calls = [];
  const scripts = [];
  const document = {
    head: { appendChild: function (script) { scripts.push(script); setTimeout(function () {
      if (settings.loadFails) {
        script.onerror();
        return;
      }
      global.createWakeOnLanModule = function (runtime) {
        runtime.ccall = function (name, returnType, argumentTypes, args) {
          if (name === "net_discover") {
            calls.push({ name: name, requestId: args[0], port: args[1], timeoutMs: args[2] });
            setTimeout(function () {
              (settings.replies || []).forEach(function (reply) {
                runtime.onDiscoveryReply(args[0], reply.address, reply.text);
              });
              runtime.onDiscoveryDone(args[0], (settings.replies || []).length, settings.discoveryError || 0);
            }, 0);
            return 0;
          }
          calls.push({ name: name, requestId: args[0], mac: Array.from(args[1]), unicast: args[2] });
          if (settings.queueStatus) {
            return settings.queueStatus;
          }
          if (!settings.silent) {
            setTimeout(function () { runtime.onWakeResult(args[0], settings.sent === undefined ? 2 : settings.sent, 101); }, 0);
          }
          return 0;
        };
        setTimeout(function () { runtime.onRuntimeInitialized(); }, 0);
        return runtime;
      };
      script.onload();
    }, 0); } },
    createElement: function () { return {}; },
  };
  return { calls: calls, scripts: scripts, document: document };
}

function rejects(promise, pattern, message) {
  return promise.then(function () {
    assert.fail(message);
  }, function (error) {
    assert.ok(pattern.test(error.message), message + ": " + error.message);
  });
}

async function run() {
  delete global.tizentvwasm;
  const unsupported = WakeOnLan.create({ document: fakeEnvironment().document });
  assert.strictEqual(unsupported.isSupported(), false, "a browser without Tizen sockets cannot wake a PC");
  await rejects(unsupported.wake("2C:F0:5D:7B:E6:D0"), /Samsung TV/, "an unsupported TV must explain why");

  global.tizentvwasm = {};
  global.SharedArrayBuffer = global.SharedArrayBuffer || function () {};
  await rejects(WakeOnLan.create({ document: fakeEnvironment().document }).wake("not a mac"), /not valid/,
    "an invalid address must be rejected before loading the module");

  const environment = fakeEnvironment();
  const sender = WakeOnLan.create({ document: environment.document });
  assert.strictEqual(sender.isSupported(), true, "a TV exposing Tizen sockets must be supported");
  const result = await sender.wake("2c:f0:5d:7b:e6:d0", "192.0.2.10");
  assert.deepStrictEqual(result, { sent: 2 }, "the number of packets sent must reach the caller");
  assert.deepStrictEqual(environment.calls[0], {
    name: "wol_send", requestId: 1, mac: [0x2C, 0xF0, 0x5D, 0x7B, 0xE6, 0xD0], unicast: "192.0.2.10",
  }, "the module must receive the MAC bytes and the Gateway's last address");
  await sender.wake("2C:F0:5D:7B:E6:D0");
  assert.strictEqual(environment.scripts.length, 1, "the module must be loaded once and reused");
  assert.strictEqual(environment.calls[1].unicast, "", "the unicast address is optional");

  await rejects(WakeOnLan.create({ document: fakeEnvironment({ sent: 0 }).document }).wake("2C:F0:5D:7B:E6:D0"),
    /could not be sent \(error 101\)/, "a request that sent nothing must fail with the socket error");
  await rejects(WakeOnLan.create({ document: fakeEnvironment({ queueStatus: 12 }).document }).wake("2C:F0:5D:7B:E6:D0"),
    /error 12/, "a request that could not be queued must fail immediately");

  const flaky = fakeEnvironment({ loadFails: true });
  const retrying = WakeOnLan.create({ document: flaky.document });
  await rejects(retrying.wake("2C:F0:5D:7B:E6:D0"), /could not be loaded/, "a missing module must be reported");
  await rejects(retrying.wake("2C:F0:5D:7B:E6:D0"), /could not be loaded/, "a failed load must be retried");
  assert.strictEqual(flaky.scripts.length, 2, "a failed load must not be cached");

  const reply = JSON.stringify({ version: 2, type: "discovery", name: "PC_Casa", port: 8001, macAddress: "2c-f0-5d-7b-e6-d0" });
  assert.deepStrictEqual(WakeOnLan.parseDiscoveryReply("192.168.1.85", reply),
    { host: "192.168.1.85", port: 8001, name: "PC_Casa", macAddress: "2C:F0:5D:7B:E6:D0" },
    "a discovery reply becomes a PC at the address it came from");
  assert.strictEqual(WakeOnLan.parseDiscoveryReply("192.168.1.85", "{"), null, "malformed replies are ignored");
  assert.strictEqual(WakeOnLan.parseDiscoveryReply("192.168.1.85", JSON.stringify({ version: 1, type: "discovery", port: 8000 })), null,
    "replies from another protocol version are ignored");
  assert.strictEqual(WakeOnLan.parseDiscoveryReply("192.168.1.85", JSON.stringify({ version: 2, type: "discovery", port: 70000 })), null,
    "an invalid port is ignored");
  assert.strictEqual(WakeOnLan.parseDiscoveryReply("fe80::1", reply), null, "only IPv4 sources are PCs to connect to");

  const network = fakeEnvironment({ replies: [
    { address: "192.168.1.85", text: reply },
    { address: "192.168.1.85", text: reply },
    { address: "192.168.1.90", text: JSON.stringify({ version: 2, type: "discovery", name: "Office", port: 8000 }) },
    { address: "192.168.1.91", text: "not json" },
  ] });
  const found = await WakeOnLan.create({ document: network.document }).discover();
  assert.deepStrictEqual(found.map(function (pc) { return pc.host + ":" + pc.port; }), ["192.168.1.85:8001", "192.168.1.90:8000"],
    "every PC that answered is found once, and invalid replies are dropped");
  assert.strictEqual(network.calls[0].port, 8000, "discovery is broadcast to UDP 8000");

  await rejects(WakeOnLan.create({ document: fakeEnvironment({ discoveryError: 13 }).document }).discover(),
    /discovery failed \(error 13\)/, "a discovery whose socket failed reports the error");
  assert.deepStrictEqual(await WakeOnLan.create({ document: fakeEnvironment({}).document }).discover(), [],
    "a network without Sunshine-Web-RTC finds nothing");

  console.log("Tizen Wake-on-LAN tests passed");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
