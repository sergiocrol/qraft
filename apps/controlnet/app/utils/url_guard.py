"""Stdlib-only guards for fetching user-supplied QR image URLs (plan 005).

``inference.py`` fetches every ``base_qr_code`` URL server-side from inside
the SageMaker VPC, which makes that call a classic SSRF sink (e.g. the
169.254.169.254 instance-metadata endpoint) and a memory-exhaustion sink
(unbounded download). The helpers here enforce, at that sink:

- ``https``-only URLs with a hostname (``_assert_https_url``);
- DNS resolution refusing private / loopback / link-local / reserved /
  multicast addresses (``_assert_public_host``);
- a hard byte cap on both streamed downloads (``_read_capped``) and
  ``data:image`` payloads (``_decode_data_url``).

This module deliberately depends only on the standard library so the guards
can be unit-tested on hosts without the container's GPU stack
(torch/diffusers); see ``tests/test_url_guard.py``.

Known limitation (accepted for this threat model): ``_assert_public_host``
resolves DNS once, then ``requests.get`` resolves again — a TOCTOU window in
which a malicious authoritative DNS server could rebind the name to a private
IP between the two lookups. A fully airtight fix would pin the resolved IP
into the connection (custom requests transport adapter); revisit if the
endpoint ever becomes broadly network-reachable.
"""

import base64
import ipaddress
import socket
from urllib.parse import urlparse

# Hard cap on the bytes accepted for one QR image, whether fetched over the
# network or embedded in a data URL.
_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024  # 8 MB


def _assert_public_host(hostname):
    """Resolve *hostname* and refuse any non-public address.

    Raises ``ValueError`` if any resolved address is private, loopback,
    link-local (e.g. the 169.254.169.254 cloud-metadata endpoint), reserved
    or multicast. Resolution failures (``socket.gaierror``) propagate and are
    wrapped with URL context by the caller.
    """
    infos = socket.getaddrinfo(hostname, None)
    for _family, _type, _proto, _canonname, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        ):
            raise ValueError(
                f"Refusing to fetch QR from non-public address: {hostname}"
            )


def _assert_https_url(url):
    """Require an ``https`` URL with a hostname; return the parse result."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"Invalid or non-https URL: {url}")
    return parsed


def _read_capped(chunk_iter):
    """Accumulate an ``iter_content``-style byte stream into one bytes value.

    Raises ``ValueError`` as soon as the running total exceeds
    ``_MAX_DOWNLOAD_BYTES``, without buffering the rest of the body.
    """
    chunks, total = [], 0
    for chunk in chunk_iter:
        total += len(chunk)
        if total > _MAX_DOWNLOAD_BYTES:
            raise ValueError("QR image exceeds maximum allowed size")
        chunks.append(chunk)
    return b"".join(chunks)


def _decode_data_url(url):
    """Decode the base64 payload of a ``data:image/...`` URL.

    Enforces the same byte cap as network fetches and returns the raw image
    bytes for the caller to decode with Pillow.
    """
    _, encoded = url.split(",", 1)
    data = base64.b64decode(encoded)
    if len(data) > _MAX_DOWNLOAD_BYTES:
        raise ValueError("QR data URL too large")
    return data
