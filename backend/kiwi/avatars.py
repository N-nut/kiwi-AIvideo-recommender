"""Decode bounded raster input and store only a fresh, metadata-free JPEG."""
import base64
import binascii
from io import BytesIO
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from .auth import problem

MAX_IMAGE_BYTES = 16_000


def prepare_avatar(encoded):
    try:
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("size")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP"]) as source:
                if source.width > 1024 or source.height > 1024 or getattr(source, "n_frames", 1) != 1:
                    raise ValueError("dimensions")
                source.load()
                source = ImageOps.exif_transpose(source).convert("RGBA")
                # Alpha is flattened explicitly; EXIF/ICC/text are never saved.
                background = Image.new("RGBA", source.size, "#f0f3e9")
                background.alpha_composite(source)
                square = ImageOps.fit(background.convert("RGB"), (256, 256), method=Image.Resampling.LANCZOS)
                output = BytesIO()
                square.save(output, "JPEG", quality=85, optimize=True)
                return output.getvalue()
    except (ValueError, binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise problem(422, "invalid_avatar", "照片无法读取，请重新选择 JPG、PNG 或 WebP 图片", ["avatar_image"]) from None
