// Pure acceptance policy and serializable browser probes. No network calls.
export function parseTurnTlsEndpoint(value) {
  const invalid = () =>
    new Error(
      "Set MEDIA_TEST_TURN_TLS_URL to an explicit turns:host:443?transport=tcp endpoint (5349 only for an intentional legacy check)",
    );
  if (typeof value !== "string" || value.length > 320 || value.trim() !== value)
    throw invalid();
  const match =
    /^turns:(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(443|5349)(?:\?transport=tcp)?$/i.exec(
      value,
    );
  if (!match) throw invalid();
  let host;
  try {
    host = new URL(`https://${match[1]}`).hostname;
  } catch {
    throw invalid();
  }
  if (
    !host.startsWith("[") &&
    (host.length > 253 ||
      !host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  )
    throw invalid();
  const port = Number(match[2]);
  const base = `turns:${host}:${port}`;
  // A turns URI without a transport parameter also selects TLS over TCP.
  return { host, port, allowedTurnUrls: [`${base}?transport=tcp`, base] };
}

// Kept self-contained because Playwright serializes this function into the page.
export function installMediaProbe({ relayOnly, allowedTurnUrls }) {
  window.__imonRTCPeers = [];
  const Native = window.RTCPeerConnection;
  const configure = (source = {}) => {
    if (!relayOnly) return source;
    return {
      ...source,
      iceTransportPolicy: "relay",
      iceServers: (source.iceServers || []).flatMap((server) => {
        const urls = (
          Array.isArray(server.urls) ? server.urls : [server.urls]
        ).filter(
          (url) =>
            typeof url === "string" &&
            allowedTurnUrls.includes(url.toLowerCase()),
        );
        return urls.length ? [{ ...server, urls }] : [];
      }),
    };
  };
  window.RTCPeerConnection = new Proxy(Native, {
    construct(Target, args) {
      const peer = new Target(configure(args[0]));
      const setConfiguration = peer.setConfiguration.bind(peer);
      peer.setConfiguration = (next) => setConfiguration(configure(next));
      window.__imonRTCPeers.push(peer);
      return peer;
    },
  });
}

export async function collectMediaStats({ allowedTurnUrls }) {
  const output = {
    audioBytes: 0,
    videoFrames: 0,
    connectedPeers: 0,
    missingSelectedPairs: 0,
    pairs: [],
    policies: [],
  };
  const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  const category = (value, allowed) =>
    allowed.includes(value) ? value : "unknown";
  const peers = window.__imonRTCPeers || [];
  if (peers.length > 64)
    throw new Error("Unexpected peer count in external media proof");
  for (const peer of peers) {
    if (peer.connectionState !== "connected") continue;
    output.connectedPeers++;
    output.policies.push(
      category(peer.getConfiguration().iceTransportPolicy, ["all", "relay"]),
    );
    const reports = await peer.getStats();
    let selected = 0;
    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio")
        output.audioBytes += count(report.bytesReceived);
      if (report.type === "inbound-rtp" && report.kind === "video")
        output.videoFrames += count(report.framesDecoded);
      if (report.type !== "transport" || !report.selectedCandidatePairId)
        return;
      const pair = reports.get(report.selectedCandidatePairId);
      const local = reports.get(pair?.localCandidateId);
      const remote = reports.get(pair?.remoteCandidateId);
      if (
        pair?.type !== "candidate-pair" ||
        pair.state !== "succeeded" ||
        !local ||
        !remote
      )
        return;
      selected++;
      output.pairs.push({
        localType: category(local.candidateType, [
          "host",
          "srflx",
          "prflx",
          "relay",
        ]),
        relayProtocol: category(local.relayProtocol, ["tls", "tcp", "udp"]),
        expectedTurnTLS:
          typeof local.url === "string" &&
          allowedTurnUrls.includes(local.url.toLowerCase()),
        remoteProtocol: category(remote.protocol, ["udp", "tcp"]),
        bytesSent: count(pair.bytesSent),
        bytesReceived: count(pair.bytesReceived),
      });
    });
    if (!selected) output.missingSelectedPairs++;
    if (output.pairs.length > 128)
      throw new Error(
        "Unexpected selected route count in external media proof",
      );
  }
  return output;
}

export function mediaProofIsValid(stats, relayOnly) {
  const positive = (value) => Number.isFinite(value) && value > 0;
  if (
    !stats ||
    !positive(stats.audioBytes) ||
    !positive(stats.videoFrames) ||
    !Number.isSafeInteger(stats.connectedPeers) ||
    stats.connectedPeers < 1 ||
    stats.missingSelectedPairs !== 0 ||
    !Array.isArray(stats.policies) ||
    stats.policies.length !== stats.connectedPeers ||
    !Array.isArray(stats.pairs) ||
    stats.pairs.length < stats.connectedPeers ||
    !stats.pairs.every(
      (pair) => positive(pair.bytesSent) && positive(pair.bytesReceived),
    )
  )
    return false;
  if (!relayOnly) return true;
  return (
    stats.policies.every((policy) => policy === "relay") &&
    stats.pairs.every(
      (pair) =>
        ["relay", "prflx"].includes(pair.localType) &&
        ["tls", "tcp"].includes(pair.relayProtocol) &&
        pair.expectedTurnTLS === true,
    )
  );
}

export function collectSafeMediaDiagnostic() {
  const peers = window.__imonRTCPeers || [];
  const category = (value, allowed) =>
    allowed.includes(value) ? value : "unknown";
  return {
    peerCount: peers.length,
    truncated: peers.length > 16,
    peers: peers.slice(0, 16).map((peer) => ({
      connection: category(peer.connectionState, [
        "new",
        "connecting",
        "connected",
        "disconnected",
        "failed",
        "closed",
      ]),
      ice: category(peer.iceConnectionState, [
        "new",
        "checking",
        "connected",
        "completed",
        "disconnected",
        "failed",
        "closed",
      ]),
      gathering: category(peer.iceGatheringState, [
        "new",
        "gathering",
        "complete",
      ]),
      iceServerCount: (peer.getConfiguration().iceServers || []).length,
    })),
  };
}
