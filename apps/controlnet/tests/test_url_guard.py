"""Unit tests for the SSRF / resource-exhaustion guards in
``app/utils/url_guard.py`` (plan 005).

``url_guard`` is deliberately stdlib-only, so it is loaded here directly from
its file path — no ``app`` package import, no torch/diffusers/Flask needed.
Pillow is used only by the tests themselves to build and verify a tiny PNG
for the data-URL round-trip.

Run (only needs pytest + Pillow, no GPU / container deps):

    cd apps/controlnet && python3 -m pytest tests/test_url_guard.py -q

DNS is never hit: ``socket.getaddrinfo`` is monkeypatched in every
``_assert_public_host`` test.
"""

import base64
import importlib.util
import socket
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

URL_GUARD_PATH = (
    Path(__file__).resolve().parent.parent / "app" / "utils" / "url_guard.py"
)

_spec = importlib.util.spec_from_file_location("url_guard", URL_GUARD_PATH)
url_guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_guard)


def _fake_getaddrinfo(*ips):
    """Build a getaddrinfo stand-in returning one record per IP."""

    def fake(hostname, port, *args, **kwargs):
        results = []
        for ip in ips:
            family = socket.AF_INET6 if ":" in ip else socket.AF_INET
            sockaddr = (ip, 0, 0, 0) if family == socket.AF_INET6 else (ip, 0)
            results.append((family, socket.SOCK_STREAM, 6, "", sockaddr))
        return results

    return fake


class TestAssertPublicHost:
    @pytest.mark.parametrize(
        "ip",
        [
            "127.0.0.1",  # loopback
            "10.0.0.1",  # RFC1918 private
            "172.16.0.1",  # RFC1918 private
            "192.168.1.1",  # RFC1918 private
            "169.254.169.254",  # link-local: cloud instance metadata
            "224.0.0.1",  # multicast
            "::1",  # IPv6 loopback
            "fd00::1",  # IPv6 unique-local (private)
            "fe80::1",  # IPv6 link-local
        ],
    )
    def test_rejects_non_public_addresses(self, monkeypatch, ip):
        monkeypatch.setattr(
            url_guard.socket, "getaddrinfo", _fake_getaddrinfo(ip)
        )
        with pytest.raises(ValueError, match="non-public address"):
            url_guard._assert_public_host("evil.example.com")

    def test_accepts_public_address(self, monkeypatch):
        monkeypatch.setattr(
            url_guard.socket, "getaddrinfo", _fake_getaddrinfo("93.184.216.34")
        )
        url_guard._assert_public_host("example.com")  # must not raise

    def test_rejects_when_any_record_is_private(self, monkeypatch):
        # DNS-rebinding shape: one public A record plus one private one.
        monkeypatch.setattr(
            url_guard.socket,
            "getaddrinfo",
            _fake_getaddrinfo("93.184.216.34", "10.0.0.1"),
        )
        with pytest.raises(ValueError, match="non-public address"):
            url_guard._assert_public_host("rebind.example.com")

    def test_resolution_failure_propagates(self, monkeypatch):
        def boom(hostname, port, *args, **kwargs):
            raise socket.gaierror("no such host")

        monkeypatch.setattr(url_guard.socket, "getaddrinfo", boom)
        with pytest.raises(socket.gaierror):
            url_guard._assert_public_host("does-not-resolve.example.com")


class TestAssertHttpsUrl:
    @pytest.mark.parametrize(
        "url",
        [
            "http://example.com/qr.png",  # non-https scheme
            "file:///etc/passwd",  # local file scheme
            "ftp://example.com/qr.png",
            "https://",  # no hostname
            "not-a-url",
        ],
    )
    def test_rejects_non_https_or_hostless(self, url):
        with pytest.raises(ValueError, match="Invalid or non-https URL"):
            url_guard._assert_https_url(url)

    def test_accepts_https_and_returns_parse_result(self):
        parsed = url_guard._assert_https_url(
            "https://bucket.s3.eu-west-1.amazonaws.com/user-qr-codes/qr.png"
        )
        assert parsed.hostname == "bucket.s3.eu-west-1.amazonaws.com"


class TestReadCapped:
    def test_returns_joined_bytes_under_cap(self):
        assert url_guard._read_capped(iter([b"abc", b"def"])) == b"abcdef"

    def test_raises_and_stops_reading_once_over_cap(self, monkeypatch):
        monkeypatch.setattr(url_guard, "_MAX_DOWNLOAD_BYTES", 10)
        consumed = []

        def stream():
            for chunk in (b"12345", b"67890", b"OVER", b"NEVER-REACHED"):
                consumed.append(chunk)
                yield chunk

        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            url_guard._read_capped(stream())
        # The cap streams: iteration stops at the offending chunk instead of
        # buffering the rest of the body.
        assert consumed == [b"12345", b"67890", b"OVER"]


class TestDecodeDataUrl:
    @staticmethod
    def _png_data_url(size=(3, 3)):
        img = Image.new("RGB", size, (255, 0, 0))
        buf = BytesIO()
        img.save(buf, format="PNG")
        payload = base64.b64encode(buf.getvalue()).decode()
        return f"data:image/png;base64,{payload}"

    def test_decodes_small_png_that_opens_as_image(self):
        data = url_guard._decode_data_url(self._png_data_url())
        image = Image.open(BytesIO(data)).convert("RGB")
        assert image.size == (3, 3)

    def test_rejects_payload_over_cap(self, monkeypatch):
        monkeypatch.setattr(url_guard, "_MAX_DOWNLOAD_BYTES", 16)
        with pytest.raises(ValueError, match="QR data URL too large"):
            url_guard._decode_data_url(self._png_data_url())
