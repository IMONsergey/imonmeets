FROM haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3

# A disposable fixture derivative, never a deployment replacement. The runner
# supplies only the seven allowlisted source files as its build context.
USER root
RUN mkdir /fixture-provenance
RUN haproxy -vv > /fixture-provenance/base-haproxy-version.txt
RUN sha256sum /usr/local/sbin/haproxy > /fixture-provenance/base-haproxy.sha256
RUN find /lib /usr/lib -type f -exec sha256sum {} + > /fixture-provenance/base-library-files.sha256
RUN apk add --no-cache python3 openssl nodejs

COPY scripts/prepare-edge-vps-ingress.mjs scripts/prepare-ingress443.mjs scripts/ingress-nginx-tls.mjs scripts/verify-edge-vps-loopback.py /work/scripts/
COPY compose.edge-vps-ingress.yml /work/compose.edge-vps-ingress.yml
COPY tools/edge-vps-loopback/image-provenance.py /fixture-provenance/image-provenance.py
RUN python3 /fixture-provenance/image-provenance.py
RUN chmod -R a+rX /work /fixture-provenance

USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python3", "/work/scripts/verify-edge-vps-loopback.py"]
