"""Backward-compatible shim — real implementation lives in app.services.inference."""
from app.services.inference import QRControlNetInference, get_model

__all__ = ["QRControlNetInference", "get_model"]
