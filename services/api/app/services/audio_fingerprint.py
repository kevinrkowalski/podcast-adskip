from __future__ import annotations

import hashlib
from pathlib import Path


def file_fingerprints(path: Path) -> tuple[str, str]:
    """Return SHA-256 and MD5 content fingerprints using bounded memory."""
    sha256 = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as audio_file:
        for chunk in iter(lambda: audio_file.read(1024 * 1024), b""):
            sha256.update(chunk)
            md5.update(chunk)
    return sha256.hexdigest(), md5.hexdigest()


def sha256_file(path: Path) -> str:
    """Return the SHA-256 digest of a file without loading it all into memory."""
    return file_fingerprints(path)[0]
