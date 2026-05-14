#!/usr/bin/env bash
# Generate a fresh RSA-2048 keypair for Chrome Web Store "Verified CRX uploads".
#
# Run this ONCE per extension. After opt-in:
#   - The PRIVATE key (.keys/tokenxiety.pem) signs every future CRX upload.
#     Anyone who has this key can push malicious updates that Chrome will
#     silently accept as authentic. Back it up to 1Password / Keychain /
#     a hardware token and protect it like a production secret.
#   - The PUBLIC key (.keys/tokenxiety-public.pem) is what you paste into
#     the Chrome Web Store dev console under "Opt in to verified CRX uploads".
#     It's safe to publish.
#
# .keys/ is gitignored at the repo, exclude, and pattern level (*.pem, *.crx),
# so the private key cannot enter git via a normal `git add`.

set -euo pipefail

DIR=".keys"
KEY="$DIR/tokenxiety.pem"
PUB="$DIR/tokenxiety-public.pem"

mkdir -p "$DIR"
chmod 700 "$DIR"

if [ -f "$KEY" ]; then
  echo "❌  A private key already exists at $KEY"
  echo "    Refusing to overwrite — that would brick your Web Store updates."
  echo "    Move or delete it deliberately first if you really need a new one."
  exit 1
fi

# umask makes any newly-created file 600 by default during this script run.
umask 077

openssl genrsa -out "$KEY" 2048 2>/dev/null
openssl rsa -in "$KEY" -pubout -out "$PUB" 2>/dev/null
chmod 600 "$KEY"
chmod 644 "$PUB"

# Compute the extension's CRX ID (first 16 bytes of SHA-256(SPKI), rebased
# to a-p alphabet — that's Chrome's stable extension-ID derivation).
CRX_ID=$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p -c 32 \
  | tr '0-9a-f' 'a-p')

cat <<EOF

✅  Generated RSA-2048 keypair
    private:    $KEY    (chmod 600 — KEEP SECRET, back up to 1Password)
    public:     $PUB
    extension:  $CRX_ID

============================================================
PASTE THIS PUBLIC KEY (entire block, including BEGIN/END lines)
into the Chrome Web Store "Verified CRX upload" form:
============================================================
EOF
cat "$PUB"
cat <<'EOF'

============================================================
NEXT STEPS
============================================================
  1. Open https://chrome.google.com/webstore/devconsole
  2. Your item → Package → "Opt in to verified CRX uploads"
  3. Paste the PEM block above (including BEGIN/END lines)
  4. Save / confirm — this is a ONE-WAY decision. After this:
       a. You can no longer upload raw .zip files.
       b. Every future upload must be a CRX signed by this key.
  5. From now on, build releases with:
       npm run release    # build zip + sign CRX → dist/tokenxiety.crx
  6. Back up .keys/tokenxiety.pem to 1Password / Keychain TODAY.
     If you lose it you must email Chrome Web Store support to
     recover update access.
EOF
