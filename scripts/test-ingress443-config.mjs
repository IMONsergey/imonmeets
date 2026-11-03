import assert from "node:assert/strict";
import test from "node:test";
import { ingressConfig, renderIngress } from "./prepare-ingress443.mjs";

const valid = {
  INGRESS_PUBLIC_IP: "203.0.113.20",
  VPN_PUBLIC_IP: "203.0.113.21",
  APP_URL: "https://meets.example.test",
  LIVEKIT_URL: "wss://rtc.example.test",
  TURN_PUBLIC_HOST: "turn.example.test",
  LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
  ORIGIN_PROXY_SECRET: "synthetic-private-proxy-secret-20261103",
  LIVEKIT_SIGNALING_AUTH_SECRET: "synthetic-signaling-secret-20261103",
};

test("wildcard address cannot bind across the separately preserved VPN interface", () => {
  for (const key of ["INGRESS_PUBLIC_IP", "VPN_PUBLIC_IP"]) {
    assert.throws(() => ingressConfig({ ...valid, [key]: "0.0.0.0" }), /explicit non-wildcard IPv4/);
  }
  assert.throws(() => ingressConfig({ ...valid, INGRESS_PUBLIC_IP: valid.VPN_PUBLIC_IP }), /different/);
});

test("the generated candidate binds only the explicitly selected address", () => {
  const result = renderIngress(ingressConfig(valid));
  assert.match(result.haproxy, /bind 203\.0\.113\.20:443/);
  assert.match(result.nginx, /listen 203\.0\.113\.20:80/);
  assert.doesNotMatch(result.haproxy + result.nginx, /0\.0\.0\.0|203\.0\.113\.21/);
});
