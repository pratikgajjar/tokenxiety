#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["cryptography>=42"]
# ///
"""
Pack a Chrome extension directory (or a built .zip) into a signed CRX v3 file.

Spec reference: chromium/components/crx_file/crx3.proto and crx3.cc.

CRX v3 file layout:

    char     magic[4]            // "Cr24"
    uint32   version             // 3                       (little-endian)
    uint32   header_size         // bytes in `header`       (little-endian)
    bytes    header[header_size] // proto-encoded CrxFileHeader
    bytes    zip[]               // the zipped extension contents

Signature is RSA-PKCS#1 v1.5 with SHA-256 over:

    "CRX3 SignedData\\0"
    + little-endian uint32 (len(signed_header_data))
    + signed_header_data
    + zip_data

`signed_header_data` is a proto-encoded SignedData message whose only
populated field (crx_id) is the first 16 bytes of SHA-256 over the
SubjectPublicKeyInfo DER bytes of the public key. That same 16 bytes,
re-encoded into Chrome's a–p alphabet, is the extension's stable ID.

Usage:
    uv run scripts/pack-crx.py <ext-dir-or-zip> <out.crx> <private-key.pem>
"""
from __future__ import annotations

import hashlib
import io
import os
import struct
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
EXCLUDE_PREFIX = ("._",)
EXCLUDE_SUFFIX = (".swp", ".swo")


def is_excluded(name: str) -> bool:
    return (
        name in EXCLUDE_NAMES
        or name.startswith(EXCLUDE_PREFIX)
        or name.endswith(EXCLUDE_SUFFIX)
    )


def varint(n: int) -> bytes:
    """Protobuf base-128 varint encoding."""
    out = bytearray()
    while n > 0x7f:
        out.append((n & 0x7f) | 0x80)
        n >>= 7
    out.append(n & 0x7f)
    return bytes(out)


def proto_bytes(field: int, value: bytes) -> bytes:
    """Length-delimited (wire type 2) field encoding."""
    tag = (field << 3) | 2
    return varint(tag) + varint(len(value)) + value


def zip_extension_dir(src: Path) -> bytes:
    """Build a deterministic, junk-free zip of the extension directory."""
    buf = io.BytesIO()
    top = src.name
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src):
            dirs[:] = sorted(d for d in dirs if not is_excluded(d))
            for name in sorted(files):
                if is_excluded(name):
                    continue
                p = Path(root) / name
                arc = f"{top}/{p.relative_to(src).as_posix()}"
                zf.write(p, arc)
    return buf.getvalue()


def crx_id_to_alphabet(crx_id: bytes) -> str:
    """Map 16 bytes of SHA-256(SPKI) hex into Chrome's a-p extension ID."""
    return "".join("abcdefghijklmnop"[b >> 4] + "abcdefghijklmnop"[b & 0xF] for b in crx_id)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(f"usage: {argv[0]} <ext-dir-or-zip> <out.crx> <private-key.pem>", file=sys.stderr)
        return 2

    src = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve()
    key_path = Path(argv[3]).resolve()

    if not src.exists():
        print(f"source not found: {src}", file=sys.stderr)
        return 1
    if not key_path.exists():
        print(f"private key not found: {key_path}", file=sys.stderr)
        print("  run: npm run sign:keygen", file=sys.stderr)
        return 1

    # 1. Zip the extension (either pack the dir or reuse an existing zip)
    if src.is_dir():
        zip_data = zip_extension_dir(src)
    else:
        zip_data = src.read_bytes()

    # 2. Load the RSA private key and derive its SubjectPublicKeyInfo DER bytes
    pem = key_path.read_bytes()
    private_key = serialization.load_pem_private_key(pem, password=None)
    if not hasattr(private_key, "sign"):
        print("private key does not support signing", file=sys.stderr)
        return 1

    pub_der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    # 3. Compute the 16-byte crx_id (first 16 bytes of SHA-256 over SPKI DER)
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    ext_id = crx_id_to_alphabet(crx_id)

    signed_header_data = proto_bytes(1, crx_id)  # SignedData.crx_id

    # 4. Build the blob that gets signed
    signed_blob = (
        b"CRX3 SignedData\0"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_data
    )

    # 5. RSA-SHA256 PKCS#1 v1.5 signature
    signature = private_key.sign(
        signed_blob,
        padding.PKCS1v15(),
        hashes.SHA256(),
    )

    # 6. CrxFileHeader = repeated AsymmetricKeyProof sha256_with_rsa (field 2)
    #                    + bytes signed_header_data (field 10000)
    proof = proto_bytes(1, pub_der) + proto_bytes(2, signature)
    header = proto_bytes(2, proof) + proto_bytes(10000, signed_header_data)

    # 7. Write the CRX
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with out.open("wb") as f:
        f.write(b"Cr24")                          # magic
        f.write(struct.pack("<I", 3))             # version
        f.write(struct.pack("<I", len(header)))   # header_size
        f.write(header)                           # CrxFileHeader proto
        f.write(zip_data)                         # zip payload

    size = out.stat().st_size
    print(f"wrote {out} ({size:,} bytes)")
    print(f"  extension id: {ext_id}")
    print(f"  zip payload:  {len(zip_data):,} bytes")
    print(f"  signature:    {len(signature)} bytes RSA-2048 PKCS#1 v1.5 SHA-256")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
