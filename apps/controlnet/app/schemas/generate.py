from marshmallow import Schema, fields, validate, validates, validates_schema, \
    ValidationError, pre_load

from ..constants import (
    DEFAULT_NEGATIVE_PROMPT,
    DEFAULT_NUM_INFERENCE_STEPS,
    DEFAULT_CONTROLNET_CONDITIONING_SCALE,
    DEFAULT_CONTROL_GUIDANCE_START,
    DEFAULT_CONTROL_GUIDANCE_END,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    DEFAULT_SAMPLER,
    DEFAULT_GUIDANCE_SCALE,
    DEFAULT_MODEL_KEY,
    QR_CONTENT_MAX_LENGTH,
    VALID_PIPELINES,
    DEFAULT_PIPELINE,
    VALID_SCAN_STRICTNESS,
    DEFAULT_SCAN_STRICTNESS,
)
from ..presets import STYLE_PRESET_NAMES, DEFAULT_STYLE_PRESET
from ..utils.model_downloader import MODEL_REGISTRY

VALID_SAMPLERS = [
    'ddim', 'pndm', 'lms', 'euler', 'euler_a',
    'dpm++_2m', 'dpm++_2m_karras', 'dpm++_sde', 'dpm++_sde_karras',
    'heun', 'dpm_2', 'dpm_2_a', 'unipc', 'deis', 'dpm_fast',
]

VALID_MODELS = list(MODEL_REGISTRY.keys())


class _V2PipelineFields:
    """Optional v2-pipeline fields shared by the invocation schemas (plan 008).

    All optional; absent values produce exact v1 behavior. Do not change the
    existing v1 bounds in the schemas below (plan 006 owns them).
    """
    pipeline = fields.String(
        missing=DEFAULT_PIPELINE, validate=validate.OneOf(VALID_PIPELINES))
    qr_content = fields.String(
        missing=None, validate=validate.Length(min=1, max=QR_CONTENT_MAX_LENGTH))
    style_preset = fields.String(
        missing=DEFAULT_STYLE_PRESET, validate=validate.OneOf(STYLE_PRESET_NAMES))
    scan_strictness = fields.String(
        missing=DEFAULT_SCAN_STRICTNESS, validate=validate.OneOf(VALID_SCAN_STRICTNESS))


class _CommonValidators:
    """Shared field-level validators mixed into both schemas."""

    @validates('controlnet_conditioning_scale')
    def validate_controlnet_conditioning_scale(self, value):
        if len(value) != 2:
            raise ValidationError('controlnet_conditioning_scale must be a list of two numbers.')

    @validates('control_guidance_start')
    def validate_control_guidance_start(self, value):
        if len(value) != 2:
            raise ValidationError('control_guidance_start must be a list of two numbers.')

    @validates('control_guidance_end')
    def validate_control_guidance_end(self, value):
        if len(value) != 2:
            raise ValidationError('control_guidance_end must be a list of two numbers.')

    @validates('height')
    def validate_height(self, value):
        if value % 8 != 0:
            raise ValidationError('Height must be divisible by 8.')
        if value < 512:
            raise ValidationError('Height must be at least 512 pixels.')
        if value > 1024:
            raise ValidationError('Height cannot exceed 1024 pixels.')

    @validates('width')
    def validate_width(self, value):
        if value % 8 != 0:
            raise ValidationError('Width must be divisible by 8.')
        if value < 512:
            raise ValidationError('Width must be at least 512 pixels.')
        if value > 1024:
            raise ValidationError('Width cannot exceed 1024 pixels.')

    @validates('sampler')
    def validate_sampler(self, value):
        if value.lower() not in VALID_SAMPLERS:
            raise ValidationError(f'Sampler must be one of: {", ".join(VALID_SAMPLERS)}')

    @validates('guidance_scale')
    def validate_guidance_scale(self, value):
        if value < 1.0 or value > 20.0:
            raise ValidationError('guidance_scale must be between 1.0 and 20.0')

    @validates('seed')
    def validate_seed(self, value):
        if value is not None and (value < 0 or value > 2**32):
            raise ValidationError('Seed must be between 0 and 2^32')

    @validates('model')
    def validate_model(self, value):
        if value and value.lower() not in VALID_MODELS:
            raise ValidationError(f'Model must be one of: {", ".join(VALID_MODELS)}')


def _validate_qr_urls(urls):
    """Shared QR-URL list validation (after normalisation to list)."""
    if len(urls) < 1 or len(urls) > 3:
        raise ValidationError('base_qr_code must contain between 1 and 3 URLs.')
    for url in urls:
        if not isinstance(url, str) or len(url.strip()) == 0:
            raise ValidationError('Each QR code URL must be a non-empty string.')


class GenerateImageSchema(_CommonValidators, Schema):
    """Schema for validating image generation requests. Defaults from app.constants."""
    prompt = fields.String(required=True)
    base_qr_code = fields.List(fields.String(), required=True, validate=validate.Length(min=1, max=3))
    num_images_per_prompt = fields.Integer(missing=None, validate=validate.Range(min=1, max=3))
    negative_prompt = fields.String(missing=DEFAULT_NEGATIVE_PROMPT)
    num_inference_steps = fields.Integer(missing=DEFAULT_NUM_INFERENCE_STEPS)
    controlnet_conditioning_scale = fields.List(fields.Float, missing=DEFAULT_CONTROLNET_CONDITIONING_SCALE)
    control_guidance_start = fields.List(fields.Float, missing=DEFAULT_CONTROL_GUIDANCE_START)
    control_guidance_end = fields.List(fields.Float, missing=DEFAULT_CONTROL_GUIDANCE_END)
    height = fields.Integer(missing=DEFAULT_HEIGHT)
    width = fields.Integer(missing=DEFAULT_WIDTH)
    device = fields.String(missing=None)
    sampler = fields.String(missing=DEFAULT_SAMPLER)
    guidance_scale = fields.Float(missing=DEFAULT_GUIDANCE_SCALE)
    model = fields.String(missing=DEFAULT_MODEL_KEY)
    seed = fields.Integer(missing=None)
    guess_mode = fields.Boolean(missing=False)
    prompt_enhancement = fields.Boolean(missing=False)

    @validates('base_qr_code')
    def validate_base_qr_code(self, value):
        _validate_qr_urls(value)

    @validates('device')
    def validate_device(self, value):
        if value and value not in ['auto', 'cpu', 'mps', 'cuda', None]:
            raise ValidationError('Device must be one of: auto, cpu, mps, cuda')


class InvocationRequestSchema(_CommonValidators, _V2PipelineFields, Schema):
    """Schema for the SageMaker /invocations endpoint.

    Accepts ``base_qr_code`` as either a single URL string or a list of URLs
    (normalised to a list before validation).  When ``num_images_per_prompt``
    is omitted it defaults to the length of ``base_qr_code``.

    v2-pipeline fields (pipeline/qr_content/style_preset/scan_strictness)
    come from ``_V2PipelineFields``; absent means exact v1 behavior.
    """
    prompt = fields.String(required=True)
    base_qr_code = fields.Field(required=True)
    num_images_per_prompt = fields.Integer(missing=None, validate=validate.Range(min=1, max=3))
    negative_prompt = fields.String(missing=DEFAULT_NEGATIVE_PROMPT)
    num_inference_steps = fields.Integer(
        missing=DEFAULT_NUM_INFERENCE_STEPS, validate=validate.Range(min=1, max=100))
    controlnet_conditioning_scale = fields.List(fields.Float, missing=DEFAULT_CONTROLNET_CONDITIONING_SCALE)
    control_guidance_start = fields.List(fields.Float, missing=DEFAULT_CONTROL_GUIDANCE_START)
    control_guidance_end = fields.List(fields.Float, missing=DEFAULT_CONTROL_GUIDANCE_END)
    height = fields.Integer(missing=DEFAULT_HEIGHT)
    width = fields.Integer(missing=DEFAULT_WIDTH)
    sampler = fields.String(missing=DEFAULT_SAMPLER)
    guidance_scale = fields.Float(missing=DEFAULT_GUIDANCE_SCALE)
    model = fields.String(missing=DEFAULT_MODEL_KEY)
    seed = fields.Integer(missing=None)
    guess_mode = fields.Boolean(missing=False)
    prompt_enhancement = fields.Boolean(missing=False)

    @pre_load
    def normalise_base_qr_code(self, data, **kwargs):
        """Coerce a single URL string into a list so downstream code is uniform."""
        qr = data.get('base_qr_code')
        if isinstance(qr, str):
            data['base_qr_code'] = [qr]
        return data

    @validates('base_qr_code')
    def validate_base_qr_code(self, value):
        if not isinstance(value, list):
            raise ValidationError('base_qr_code must be a string URL or list of URLs.')
        _validate_qr_urls(value)

    @validates_schema
    def default_num_images(self, data, **kwargs):
        """Default num_images_per_prompt to len(base_qr_code) when not provided."""
        if data.get('num_images_per_prompt') is None:
            data['num_images_per_prompt'] = len(data.get('base_qr_code', []) or [])


class SageMakerRequestSchema(_CommonValidators, _V2PipelineFields, Schema):
    """Schema for validating SageMaker async generation requests.

    v2-pipeline fields (pipeline/qr_content/style_preset/scan_strictness)
    come from ``_V2PipelineFields``; absent means exact v1 behavior.
    """
    prompt = fields.String(required=True, validate=validate.Length(min=1, max=1000))
    base_qr_code = fields.List(fields.String(), validate=validate.Length(min=1, max=3))
    num_images_per_prompt = fields.Integer(validate=validate.Range(min=1, max=3))
    negative_prompt = fields.String(validate=validate.Length(max=1000))
    num_inference_steps = fields.Integer(validate=validate.Range(min=1, max=100))
    controlnet_conditioning_scale = fields.List(fields.Float())
    control_guidance_start = fields.List(fields.Float())
    control_guidance_end = fields.List(fields.Float())
    height = fields.Integer(validate=validate.OneOf([512, 768, 1024]))
    width = fields.Integer(validate=validate.OneOf([512, 768, 1024]))
    sampler = fields.String()
    guidance_scale = fields.Float(validate=validate.Range(min=1.0, max=20.0))
    model = fields.String()
    seed = fields.Integer(validate=validate.Range(min=0, max=2**32))
    guess_mode = fields.Boolean()
    prompt_enhancement = fields.Boolean()