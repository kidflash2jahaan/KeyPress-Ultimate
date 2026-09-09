#!/usr/bin/env bash
#
# make-selfsigned-cert.sh mints the code-signing certificate KeyPress Ultimate
# releases are signed with, and prints the exact commands to store it in GitHub
# Secrets.
#
# THIS SCRIPT IS NEVER RUN AUTOMATICALLY. Nothing in CI calls it. It refuses to
# run without an explicit output path, and it refuses to run when $CI is set.
# You run it once, by hand, and then probably never again.
#
# IT DOES NOT TOUCH YOUR KEYCHAIN. It shells out to openssl only. No `security
# import`, no `security add-trusted-cert`, no login keychain, no system trust
# store. The private key exists as a file at the path you name and nowhere else.
#
# ---------------------------------------------------------------------------
# Why a self-signed certificate at all
# ---------------------------------------------------------------------------
# When the user grants Accessibility to KeyPress Ultimate, macOS records the
# app's DESIGNATED REQUIREMENT in the TCC database, not its path and not its
# bundle id alone. On the next launch the grant applies only if the app still
# satisfies that requirement.
#
#   ad-hoc signed  ->  designated => identifier "com.keypressultimate.app"
#                                    and cdhash H"<hash of THIS build>"
#   this cert      ->  designated => identifier "com.keypressultimate.app"
#                                    and certificate leaf = H"<cert fingerprint>"
#
# The ad-hoc requirement changes on every single build, so every update looks
# like a brand new program and the user has to re-grant Accessibility, tick the
# checkbox again, and restart the app. Pinning to a certificate we control makes
# the requirement stable for the life of the certificate.
#
# This is NOT notarization and NOT an Apple Developer ID. Gatekeeper still shows
# the one-time "unidentified developer" block on first install; INSTALL.md walks
# the user through Open Anyway. It buys exactly one thing: a stable identity.
#
# ---------------------------------------------------------------------------
# Rotating this certificate resets everyone's Accessibility grant
# ---------------------------------------------------------------------------
# A new certificate is a new designated requirement, so the update after a
# rotation will silently stop working for every existing user until they
# re-grant. Set --days generously (default 20 years) and keep the .p12 backed up
# somewhere you trust. If you must rotate, ship a release whose notes tell users
# to re-approve, and expect support traffic.
set -euo pipefail

CN="KeyPress Ultimate Self-Signed"
ORG="KeyPress Ultimate"
DAYS=7300
OUT=""
PASSWORD=""
REPO=""

usage() {
  cat <<'USAGE'
usage: scripts/make-selfsigned-cert.sh --out <path/to/keypress-signing.p12> [options]

  --out <path>       where to write the .p12  (REQUIRED, must be outside this repo)
  --password <pw>    p12 password             (default: 24 random chars, printed once)
  --cn <name>        certificate common name  (default: "KeyPress Ultimate Self-Signed")
  --days <n>         validity in days         (default: 7300, ~20 years)
  --repo <owner/nm>  repo for the printed `gh secret set` commands
  -h, --help         this text

Writes <path> and <path>.cer, then prints the two `gh secret set` commands that
put it in GitHub Secrets as MAC_CERT_P12 / MAC_CERT_PASSWORD.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --cn) CN="${2:-}"; shift 2 ;;
    --days) DAYS="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "${CI:-}" ]; then
  echo "refusing to run: \$CI is set. This script mints a private key and is meant" >&2
  echo "to be run once, by a human, on a machine you control." >&2
  exit 2
fi

if [ -z "$OUT" ]; then
  echo "error: --out is required (nothing is written by default)." >&2
  echo >&2
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT_DIR="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd -P || true)"
if [ -z "$OUT_DIR" ]; then
  echo "error: directory for --out does not exist: $(dirname "$OUT")" >&2
  exit 2
fi
case "$OUT_DIR/" in
  "$REPO_ROOT"/*)
    echo "error: refusing to write a private key inside the repository." >&2
    echo "       ($OUT_DIR is under $REPO_ROOT)" >&2
    echo "       Pick somewhere outside it, e.g. ~/keypress-signing.p12" >&2
    exit 2 ;;
esac
OUT="$OUT_DIR/$(basename "$OUT")"

if [ -e "$OUT" ]; then
  echo "error: $OUT already exists. Refusing to overwrite a signing key." >&2
  exit 2
fi

GENERATED_PW=0
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -base64 24 | tr -d '\n/+=' | cut -c1-24)"
  GENERATED_PW=1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $CN
O  = $ORG
[v3]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
subjectKeyIdentifier = hash
EOF

echo "==> generating a $DAYS-day self-signed code-signing certificate"
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/openssl.cnf" 2>/dev/null

# -legacy where available: macOS `security import` chokes on the AES-256-CBC /
# PBKDF2 encryption OpenSSL 3 defaults to for PKCS#12.
if openssl pkcs12 -export -help 2>&1 | grep -q -- -legacy; then
  openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$CN" -out "$OUT" -passout "pass:$PASSWORD"
else
  openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$CN" -out "$OUT" -passout "pass:$PASSWORD"
fi
chmod 600 "$OUT"
cp "$WORK/cert.pem" "$OUT.cer"

FPR="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
B64="$(base64 < "$OUT" | tr -d '\n')"
REPO_FLAG=""
[ -n "$REPO" ] && REPO_FLAG=" --repo $REPO"

cat <<EOF

  wrote  $OUT        (private key, never commit this, never share it)
  wrote  $OUT.cer    (public certificate, harmless, keep it for reference)

  common name   $CN
  SHA-1         $FPR
  expires       $(openssl x509 -in "$WORK/cert.pem" -noout -enddate | sed 's/notAfter=//')

  The designated requirement your releases will carry:
    identifier "com.keypressultimate.app" and certificate leaf = H"$FPR"

-------------------------------------------------------------------------------
1. Store it in GitHub Secrets. Run these two commands:

     gh secret set MAC_CERT_P12$REPO_FLAG --body '$B64'

     gh secret set MAC_CERT_PASSWORD$REPO_FLAG --body '$PASSWORD'

   (Or paste the same values by hand at
    Settings -> Secrets and variables -> Actions -> New repository secret.)

2. Nothing else. The release workflow imports MAC_CERT_P12 into a TEMPORARY
   keychain it creates and deletes inside the runner, trusts it for code signing
   there, and signs with it. If either secret is missing the workflow falls back
   to ad-hoc signing with a loud warning, so a release is never blocked.

3. Back up $OUT somewhere safe. Losing it means rotating,
   and rotating resets the Accessibility grant for every existing user.
EOF

if [ "$GENERATED_PW" = "1" ]; then
  cat <<EOF

   The password above was generated just now and is printed ONLY here. Put it in
   the secret (and your password manager) before you close this terminal.
EOF
fi

echo
echo "   Reminder: do not import this into your login keychain to 'test' it."
echo "   Trusting a code-signing root in your own trust store is a real change to"
echo "   your machine's security posture. CI does it in a throwaway VM; you should"
echo "   not do it on your laptop."
echo
