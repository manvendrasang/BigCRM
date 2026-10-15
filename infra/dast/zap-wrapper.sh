#!/bin/sh
#
# ZAP wrapper: trust the DAST terminator's certificate, then run the baseline.
#
# Two things must happen inside one container, so this wrapper exists:
#
# 1. The terminator presents a self-signed certificate. ZAP acts as a MITM
# proxy, which means it must itself trust the upstream certificate or it
# refuses the connection with "ZAP failed to access". Importing our CA into
# the JVM truststore is what lets the scan proceed; without it the scan
# never reaches a single endpoint and the report is empty.
#
# 2. The scan target must be reachable by the name in the certificate. The
# container is run with --network host, so `localhost:8443` resolves to the
# terminator AND matches the certificate's SAN.
#
# Invoked by infra/scripts/dast-scan.sh with TARGET and CERT already set.

set -eu

: "${TARGET:?TARGET must be set, e.g. https://localhost:8443}"
: "${CERT:?CERT must be the path to the terminator's certificate}"

# The image's own cacerts is root-owned and read-only, so import into a copy
# and point the JVM at it. `JAVA_HOME` differs by base image, hence the glob;
# `/usr/lib/jvm/*/jre/...` is deliberately absent because Debian OpenJDK has no
# `jre` segment, which is exactly the path that silently never matched before.
TRUST=/tmp/trust.jks
imported=""
for store in "${JAVA_HOME:-}/lib/security/cacerts" /usr/lib/jvm/*/lib/security/cacerts; do
 [ -f "$store" ] || continue
 cp "$store" "$TRUST" 2>/dev/null || continue
 if keytool -importcert -noprompt -trustcacerts \
 -alias bigcrm-dast -file "$CERT" -keystore "$TRUST" -storepass changeit \
 >/dev/null 2>&1; then
 imported="$TRUST"
 break
 fi
done

if [ -n "$imported" ]; then
 echo " trusted terminator CA (copied from the image truststore)"
 # _JAVA_OPTIONS is read by every JVM on launch, which is what lets this reach
 # the forked daemon. Without it ZAP terminates TLS against a certificate it
 # does not trust and reports "failed to access" -- an empty scan that looks
 # exactly like a passing one.
 export _JAVA_OPTIONS="-Djavax.net.ssl.trustStore=${imported} -Djavax.net.ssl.trustStorePassword=changeit"
else
 echo " ERROR: could not import the terminator CA; aborting rather than" >&2
 echo " emitting an empty report that could be mistaken for a clean scan." >&2
 exit 3
fi

exec /zap/zap-baseline.py \
 -t "$TARGET" \
 ${CONTEXT:+-n "$CONTEXT"} \
 -r zap-baseline.html \
 -w zap-baseline.md \
 -J zap-baseline.json \
 -I -l WARN -T 30 -m 5
