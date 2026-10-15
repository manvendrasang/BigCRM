#!/usr/bin/env bash
#
# Trivy image scan.
#
# Closes deferred item D2 ("container image scanning"). CI already runs Trivy via
# `aquasecurity/trivy-action`, but it has never executed, so the image this
# repository builds has never been scanned. Running the same scanner locally
# means the result below is real rather than a configuration that might work.
#
# What is scanned: OS packages (Alpine) and application dependencies, both, with
# CRITICAL and HIGH reported separately because they are gated differently.
#
# Usage: infra/scripts/trivy-scan.sh [image]

set -uo pipefail
IMAGE="${1:-bigcrm-api:final}"
OUT_DIR="$(cd "$(dirname "$0")/../.." && pwd)/docs/evidence"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y-%m-%d)"
RAW="${OUT_DIR}/trivy-${STAMP}.json"

command -v docker >/dev/null 2>&1 || { echo "docker required"; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found -- build it first"; exit 2; }

echo "=== pulling the scanner ==="
docker pull aquasec/trivy:0.58.1 >/dev/null 2>&1 || {
 echo "could not pull aquasec/trivy:0.58.1"; exit 2; }
echo " aquasec/trivy:0.58.1"

# The scanner needs a writable cache. A named volume keeps it out of the repo.
docker volume create -q trivy-cache >/dev/null 2>&1 || true

echo
echo "=== scanning ${IMAGE} (OS packages + dependencies) ==="
docker run --rm \
 -v /var/run/docker.sock:/var/run/docker.sock \
 -v trivy-cache:/root/.cache/trivy \
 -v "${OUT_DIR}:/out" \
 aquasec/trivy:0.58.1 \
 image --quiet --format json --output /out/$(basename "$RAW") \
 --scanners vuln --severity CRITICAL,HIGH,MEDIUM \
 --ignore-unfixed \
 "$IMAGE" 2>&1 | tail -3

[ -f "$RAW" ] || { echo "scanner produced no report"; exit 2; }

python3 - "$RAW" "$OUT_DIR/trivy-${STAMP}.md" "$IMAGE" <<'PY'
import json, sys, collections

raw, md, image = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(raw))
findings = []
for r in data.get("Results") or []:
 target = r.get("Target", "?")
 kind = "OS" if r.get("Class") == "os-pkgs" or "alpine" in target else "dependency"
 for v in r.get("Vulnerabilities") or []:
 findings.append((v.get("Severity", "?"), v.get("VulnerabilityID", "?"),
 v.get("PkgName", "?"), v.get("InstalledVersion", "?"),
 (v.get("FixedVersion") or "")[:24], kind, target))

by_sev = collections.Counter(f[0] for f in findings)
by_kind = collections.Counter((f[0], f[5]) for f in findings)

lines = [
 f"# Trivy image scan -- {image}",
 "",
 f"Scanner: `aquasec/trivy:0.58.1`, `--severity CRITICAL,HIGH,MEDIUM --ignore-unfixed`.",
 f"Scanned {len(findings)} vulnerability records across OS packages and application dependencies.",
 "",
 "| Severity | OS packages | Dependencies | Total |",
 "|---|---:|---:|---:|",
]
for sev in ("CRITICAL", "HIGH", "MEDIUM"):
 o, d = by_kind[(sev, "OS")], by_kind[(sev, "dependency")]
 lines.append(f"| {sev} | {o} | {d} | {o + d} |")
lines += ["", f"**Total: {len(findings)}** ({by_sev['CRITICAL']} critical, {by_sev['HIGH']} high, {by_sev['MEDIUM']} moderate)", ""]

crit = [f for f in findings if f[0] == "CRITICAL"]
high = [f for f in findings if f[0] == "HIGH"]

if crit or high:
 lines += ["## CRITICAL and HIGH detail", ""]
 lines += ["| Sev | ID | Package | Installed | Fixed | Kind |", "|---|---|---|---|---|---|"]
 for sev, vid, pkg, inst, fixed, kind, _t in sorted(crit + high, key=lambda x: (x[0] != "CRITICAL", x[1])):
 lines.append(f"| {sev} | {vid} | {pkg} | {inst} | {fixed or '-- (unfixed)'} | {kind} |")
 lines.append("")
else:
 lines += ["## CRITICAL and HIGH", "",
 "**None.** No critical or high vulnerability is present in either the OS layer or the", 
 "application dependency tree at the severities gated in CI.", ""]

lines += [
 "## Interpretation",
 "",
 "- `--ignore-unfixed` matches CI. A vulnerability with no upstream patch cannot be",
 " remediated by changing the base image or bumping the dependency, so failing the build",
 " on it would be un-actionable noise. Those are visible with the flag removed.",
 "- The Alpine base is deliberately small, which is why the OS layer is small; that is a",
 " direct consequence of choosing it over a Debian or RHEL base.",
 "- A clean scan is a point-in-time result. Re-run on every build; the dependency tree",
 " changes independently of this repository.",
 "",
 "## Reproduce",
 "",
 "```bash",
 "docker build -t bigcrm-api:final .",
 "infra/scripts/trivy-scan.sh bigcrm-api:final",
 "```",
]
open(md, "w").write("\n".join(lines) + "\n")
print("\n".join(lines[:22]))
PY

echo
echo " raw: $RAW"
echo " report: ${OUT_DIR}/trivy-${STAMP}.md"
