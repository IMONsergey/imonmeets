import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  parseTurnTlsEndpoint,
  installMediaProbe,
  collectMediaStats,
  collectSafeMediaDiagnostic,
  mediaProofIsValid,
} from "./external-media-policy.mjs";

const expectedURL = "turns:turn.fixture.invalid:443?transport=tcp";
const expectedURLs = [expectedURL, "turns:turn.fixture.invalid:443"];
const decode = (value) => JSON.parse(JSON.stringify(value));

test("requires an explicit endpoint and retains TLS443 without a legacy fallback", () => {
  assert.deepEqual(parseTurnTlsEndpoint(expectedURL), {
    host: "turn.fixture.invalid",
    port: 443,
    allowedTurnUrls: expectedURLs,
  });
  assert.throws(() => parseTurnTlsEndpoint());
  assert.throws(() => parseTurnTlsEndpoint(""));
});

test("legacy5349 is available only when explicitly selected", () => {
  assert.deepEqual(
    parseTurnTlsEndpoint("turns:turn.fixture.invalid:5349?transport=tcp"),
    {
      host: "turn.fixture.invalid",
      port: 5349,
      allowedTurnUrls: [
        "turns:turn.fixture.invalid:5349?transport=tcp",
        "turns:turn.fixture.invalid:5349",
      ],
    },
  );
});

test("validates scheme, hostname, TCP transport and the expected service port", () => {
  for (const input of [
    "turn:turn.fixture.invalid:443?transport=tcp",
    "turns:turn.fixture.invalid:443?transport=udp",
    "turns:turn.fixture.invalid:8443?transport=tcp",
    "turns:user:private-token@turn.fixture.invalid:443?transport=tcp",
    "turns:turn.fixture.invalid:443?transport=tcp&token=private-token",
    "turns:turn.fixture.invalid:443?transport=tcp#private-token",
    "turns:bad..hostname:443?transport=tcp",
    "turns:-hostname.invalid:443?transport=tcp",
    "turns:999.999.999.999:443?transport=tcp",
    "turns:turn.fixture.invalid:443?transport=tcp\n",
    "turns:[invalid]:443?transport=tcp",
  ]) {
    assert.throws(
      () => parseTurnTlsEndpoint(input),
      (error) => {
        assert(!error.message.includes("private-token"));
        return true;
      },
    );
  }
  assert.equal(
    parseTurnTlsEndpoint("turns:[2001:db8::1]:443?transport=tcp").host,
    "[2001:db8::1]",
  );
  assert.equal(
    parseTurnTlsEndpoint("turns:TURN.FIXTURE.INVALID:443").host,
    "turn.fixture.invalid",
  );
});

function install(relayOnly) {
  class NativePeer {
    constructor(configuration) {
      this.configuration = configuration;
    }
    setConfiguration(configuration) {
      this.configuration = configuration;
    }
    getConfiguration() {
      return this.configuration;
    }
  }
  const window = { RTCPeerConnection: NativePeer };
  vm.runInNewContext(`(${installMediaProbe.toString()})(input)`, {
    window,
    input: { relayOnly, allowedTurnUrls: expectedURLs },
  });
  return window;
}

test("constructor and later setConfiguration permit only the exact TLS443 endpoint", () => {
  const window = install(true);
  const mixed = {
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    iceServers: [
      {
        urls: [
          "stun:turn.fixture.invalid:3478",
          "turns:turn.fixture.invalid:5349?transport=tcp",
          "turns:other.fixture.invalid:443?transport=tcp",
          "turns:turn.fixture.invalid:443?transport=udp",
          expectedURL,
        ],
        username: "fixture-user",
        credential: "fixture-secret",
      },
    ],
  };
  const peer = new window.RTCPeerConnection(mixed);
  assert.deepEqual(decode(peer.getConfiguration()), {
    iceTransportPolicy: "relay",
    bundlePolicy: "max-bundle",
    iceServers: [
      {
        urls: [expectedURL],
        username: "fixture-user",
        credential: "fixture-secret",
      },
    ],
  });
  peer.setConfiguration({
    iceServers: [{ urls: "turns:turn.fixture.invalid:5349?transport=tcp" }],
  });
  assert.deepEqual(decode(peer.getConfiguration()), {
    iceTransportPolicy: "relay",
    iceServers: [],
  });
  peer.setConfiguration({
    iceServers: [{ urls: "turns:turn.fixture.invalid:443" }],
  });
  assert.deepEqual(decode(peer.getConfiguration().iceServers), [
    { urls: ["turns:turn.fixture.invalid:443"] },
  ]);
  assert.equal(mixed.iceServers[0].urls.length, 5);
});

test("normal ICE is unchanged while every created peer is observed", () => {
  const window = install(false);
  const source = {
    iceTransportPolicy: "all",
    iceServers: [{ urls: "stun:fixture.invalid:3478" }],
  };
  const peer = new window.RTCPeerConnection(source);
  assert.equal(peer.getConfiguration(), source);
  assert.equal(window.__imonRTCPeers[0], peer);
});

const goodProof = () => ({
  audioBytes: 2048,
  videoFrames: 30,
  connectedPeers: 1,
  missingSelectedPairs: 0,
  policies: ["relay"],
  pairs: [
    {
      localType: "relay",
      relayProtocol: "tls",
      expectedTurnTLS: true,
      bytesSent: 4096,
      bytesReceived: 2048,
    },
  ],
});

test("relay acceptance requires received media and a nonempty selected expected TLS route", () => {
  assert.equal(mediaProofIsValid(goodProof(), true), true);
  const prflx = goodProof();
  prflx.pairs[0].localType = "prflx";
  prflx.pairs[0].relayProtocol = "tcp";
  assert.equal(mediaProofIsValid(prflx, true), true);
  for (const mutate of [
    (proof) => {
      proof.policies = [];
    },
    (proof) => {
      proof.pairs = [];
    },
    (proof) => {
      proof.connectedPeers = 0;
    },
    (proof) => {
      proof.connectedPeers = 2;
    },
    (proof) => {
      proof.audioBytes = 0;
    },
    (proof) => {
      proof.videoFrames = 0;
    },
    (proof) => {
      proof.audioBytes = Infinity;
    },
    (proof) => {
      proof.missingSelectedPairs = 1;
    },
    (proof) => {
      proof.policies[0] = "all";
    },
    (proof) => {
      proof.pairs[0].expectedTurnTLS = false;
    },
    (proof) => {
      proof.pairs[0].localType = "host";
    },
    (proof) => {
      proof.pairs[0].relayProtocol = "udp";
    },
    (proof) => {
      proof.pairs[0].bytesReceived = 0;
    },
  ]) {
    const proof = goodProof();
    mutate(proof);
    assert.equal(mediaProofIsValid(proof, true), false);
  }
});

test("normal ICE still requires received audio, decoded frames and selected pairs", () => {
  const proof = goodProof();
  proof.policies = ["all"];
  proof.pairs[0] = {
    localType: "host",
    relayProtocol: "unknown",
    expectedTurnTLS: false,
    bytesSent: 100,
    bytesReceived: 100,
  };
  assert.equal(mediaProofIsValid(proof, false), true);
  proof.pairs = [];
  assert.equal(mediaProofIsValid(proof, false), false);
});

function peerFixture({
  selectedUrl = expectedURL,
  state = "succeeded",
  selectedId = "pair",
  extra = [],
} = {}) {
  return {
    connectionState: "connected",
    iceConnectionState: "connected",
    iceGatheringState: "complete",
    getConfiguration: () => ({
      iceTransportPolicy: "relay",
      iceServers: [{ urls: [expectedURL], credential: "private-credential" }],
    }),
    getStats: async () =>
      new Map([
        [
          "transport",
          {
            id: "transport",
            type: "transport",
            selectedCandidatePairId: selectedId,
          },
        ],
        [
          "pair",
          {
            id: "pair",
            type: "candidate-pair",
            state,
            localCandidateId: "local",
            remoteCandidateId: "remote",
            bytesSent: 4096,
            bytesReceived: 2048,
          },
        ],
        [
          "local",
          {
            id: "local",
            type: "local-candidate",
            candidateType: "relay",
            relayProtocol: "tls",
            url: selectedUrl,
            address: "192.0.2.1",
          },
        ],
        [
          "remote",
          {
            id: "remote",
            type: "remote-candidate",
            protocol: "udp",
            port: 50000,
            address: "192.0.2.2",
          },
        ],
        [
          "audio",
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 2048,
          },
        ],
        [
          "video",
          {
            id: "video",
            type: "inbound-rtp",
            kind: "video",
            framesDecoded: 30,
          },
        ],
        ...extra,
      ]),
  };
}

async function collect(peers) {
  return decode(
    await vm.runInNewContext(`(${collectMediaStats.toString()})(input)`, {
      window: { __imonRTCPeers: peers },
      input: { allowedTurnUrls: expectedURLs },
    }),
  );
}

test("collects only the transport-selected candidate pair and retains no raw URLs or IPs", async () => {
  const stats = await collect([
    peerFixture({
      extra: [
        [
          "unselected",
          {
            type: "candidate-pair",
            state: "succeeded",
            localCandidateId: "decoy",
            remoteCandidateId: "remote",
          },
        ],
        [
          "decoy",
          {
            type: "local-candidate",
            candidateType: "host",
            url: "turns:private-token@bad.invalid:443",
          },
        ],
      ],
    }),
  ]);
  assert.equal(mediaProofIsValid(stats, true), true);
  assert.equal(stats.pairs.length, 1);
  for (const value of [
    "private-token",
    "private-credential",
    "turns:",
    "192.0.2.",
    "fixture.invalid",
  ]) {
    assert.equal(JSON.stringify(stats).includes(value), false);
  }
});

test("a matching unselected candidate cannot rescue a wrong selected endpoint", async () => {
  for (const selectedUrl of [
    "turns:turn.fixture.invalid:5349?transport=tcp",
    "turns:other.fixture.invalid:443?transport=tcp",
    "turns:turn.fixture.invalid:443?transport=udp",
    "turn:turn.fixture.invalid:443?transport=tcp",
  ]) {
    const stats = await collect([
      peerFixture({
        selectedUrl,
        extra: [
          [
            "decoy",
            {
              type: "local-candidate",
              candidateType: "relay",
              relayProtocol: "tls",
              url: expectedURL,
            },
          ],
        ],
      }),
    ]);
    assert.equal(mediaProofIsValid(stats, true), false);
  }
});

test("missing or failed selected pairs refuse media acceptance", async () => {
  for (const options of [{ selectedId: "missing" }, { state: "failed" }]) {
    const stats = await collect([peerFixture(options)]);
    assert.equal(mediaProofIsValid(stats, true), false);
    assert.equal(stats.missingSelectedPairs, 1);
  }
  assert.equal(mediaProofIsValid(await collect([]), true), false);
});

test("failure diagnostics are bounded state fields and never inspect meeting text or URLs", () => {
  const peers = Array.from({ length: 100 }, () => peerFixture());
  peers[0].connectionState = "private-token";
  const diagnostic = vm.runInNewContext(
    `(${collectSafeMediaDiagnostic.toString()})()`,
    {
      window: { __imonRTCPeers: peers },
      get document() {
        throw new Error("Meeting DOM must not be read");
      },
    },
  );
  assert.equal(diagnostic.peerCount, 100);
  assert.equal(diagnostic.peers.length, 16);
  assert.equal(diagnostic.peers[0].connection, "unknown");
  assert.equal(diagnostic.truncated, true);
  for (const value of [
    "private-token",
    "private-credential",
    "turns:",
    "fixture.invalid",
  ]) {
    assert.equal(JSON.stringify(diagnostic).includes(value), false);
  }
});
