"""Pure Python Chandra OCR wrapper. No Modal imports — portable to local deployment."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TextBlock:
    text: str
    bbox: dict  # {"x": float, "y": float, "width": float, "height": float} normalized 0-1
    block_type: str  # "text", "table", "heading", etc.
    confidence: Optional[float] = None


@dataclass
class PageResult:
    page_number: int
    markdown_text: str
    width: float  # original page width in pixels at OCR DPI
    height: float  # original page height in pixels at OCR DPI
    text_blocks: list[TextBlock] = field(default_factory=list)


class OCRService:
    """Wraps Chandra OCR with a clean interface."""

    def __init__(self, method: str = "hf", cache_dir: str = "/models/chandra"):
        self.method = method
        self.cache_dir = cache_dir
        self.manager = None

    def load_model(self):
        """Load Chandra model into memory. Call once at container start."""
        from chandra.model import InferenceManager

        self.manager = InferenceManager(method=self.method)

    def run_ocr(self, pdf_bytes: bytes) -> list[PageResult]:
        """Run OCR on a PDF. Returns structured results per page.

        This is the interface boundary — everything downstream sees PageResult,
        never Chandra-specific types.
        """
        if self.manager is None:
            self.load_model()

        from chandra.input import load_pdf_images

        import tempfile
        import os

        # Chandra's load_pdf_images expects a file path
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            tmp_path = f.name

        try:
            images = load_pdf_images(tmp_path)
            results = self.manager.generate(images)
        finally:
            os.unlink(tmp_path)

        page_results = []
        for i, result in enumerate(results):
            page_result = self._normalize_result(result, page_number=i + 1)
            page_results.append(page_result)

        return page_results

    def _normalize_result(self, result, page_number: int) -> PageResult:
        """Normalize Chandra's output into our standard PageResult format.

        Chandra outputs markdown, HTML (with bbox visualization), and structured
        JSON. The exact JSON schema may vary between versions, so this method
        handles the normalization defensively.
        """
        markdown_text = result.markdown if hasattr(result, "markdown") else str(result)

        # Get page dimensions from the result or the image
        width = getattr(result, "image_width", 0) or getattr(result, "width", 0)
        height = getattr(result, "image_height", 0) or getattr(result, "height", 0)

        # Extract text blocks with bounding boxes from structured output
        text_blocks = []

        # Try to get structured blocks from the JSON output
        json_data = None
        if hasattr(result, "json") and result.json:
            json_data = result.json if isinstance(result.json, dict) else None
        elif hasattr(result, "to_dict"):
            json_data = result.to_dict()

        if json_data and isinstance(json_data, dict):
            blocks = json_data.get("blocks", json_data.get("children", []))
            for block in blocks:
                text_block = self._extract_block(block, width, height)
                if text_block:
                    text_blocks.append(text_block)

        # If no structured blocks found, create a single block for the whole page
        if not text_blocks and markdown_text.strip():
            text_blocks.append(
                TextBlock(
                    text=markdown_text,
                    bbox={"x": 0, "y": 0, "width": 1, "height": 1},
                    block_type="text",
                )
            )

        # If dimensions are 0, use defaults (Letter size at 200 DPI)
        if width == 0:
            width = 1700
        if height == 0:
            height = 2200

        return PageResult(
            page_number=page_number,
            markdown_text=markdown_text,
            width=width,
            height=height,
            text_blocks=text_blocks,
        )

    def _extract_block(
        self, block: dict, page_width: float, page_height: float
    ) -> Optional[TextBlock]:
        """Extract a single text block from Chandra's JSON structure.

        Chandra blocks have: {type, bbox: [x1,y1,x2,y2], lines: [{text, conf}]}
        """
        # Text may be top-level or nested in lines
        text = block.get("text", block.get("content", "")).strip()
        if not text:
            # Chandra nests text in lines array
            lines = block.get("lines", [])
            if lines:
                text = "\n".join(l.get("text", "") for l in lines).strip()
        if not text:
            return None

        # Try multiple bbox formats Chandra might use
        bbox_raw = block.get("bbox", block.get("bounding_box", block.get("polygon")))
        if bbox_raw is None:
            return None

        bbox = self._normalize_bbox(bbox_raw, page_width, page_height)
        if bbox is None:
            return None

        block_type = block.get("type", block.get("block_type", "text")).lower()
        # Confidence may be on the block or averaged from lines
        confidence = block.get("confidence", block.get("score"))
        if confidence is None:
            lines = block.get("lines", [])
            confs = [l.get("conf", l.get("confidence")) for l in lines if l.get("conf") or l.get("confidence")]
            if confs:
                confidence = sum(confs) / len(confs)

        return TextBlock(
            text=text,
            bbox=bbox,
            block_type=block_type,
            confidence=confidence,
        )

    def _normalize_bbox(
        self, bbox_raw, page_width: float, page_height: float
    ) -> Optional[dict]:
        """Normalize bounding box to 0-1 coordinates relative to page dimensions.

        Handles multiple input formats:
        - [x1, y1, x2, y2] pixel coords
        - {"x": ..., "y": ..., "width": ..., "height": ...}
        - [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] polygon
        """
        if page_width == 0 or page_height == 0:
            return None

        if isinstance(bbox_raw, list):
            if len(bbox_raw) == 4 and all(isinstance(v, (int, float)) for v in bbox_raw):
                # [x1, y1, x2, y2] format
                x1, y1, x2, y2 = bbox_raw
                return {
                    "x": x1 / page_width,
                    "y": y1 / page_height,
                    "width": (x2 - x1) / page_width,
                    "height": (y2 - y1) / page_height,
                }
            elif len(bbox_raw) >= 4 and all(isinstance(v, list) for v in bbox_raw):
                # Polygon format [[x1,y1], [x2,y2], ...]
                xs = [p[0] for p in bbox_raw]
                ys = [p[1] for p in bbox_raw]
                x1, x2 = min(xs), max(xs)
                y1, y2 = min(ys), max(ys)
                return {
                    "x": x1 / page_width,
                    "y": y1 / page_height,
                    "width": (x2 - x1) / page_width,
                    "height": (y2 - y1) / page_height,
                }
        elif isinstance(bbox_raw, dict):
            if "x" in bbox_raw and "width" in bbox_raw:
                # Already in our format — just normalize if pixel coords
                x = bbox_raw["x"]
                y = bbox_raw["y"]
                w = bbox_raw["width"]
                h = bbox_raw["height"]
                # If values > 1, they're pixel coordinates
                if x > 1 or y > 1 or w > 1 or h > 1:
                    return {
                        "x": x / page_width,
                        "y": y / page_height,
                        "width": w / page_width,
                        "height": h / page_height,
                    }
                return {"x": x, "y": y, "width": w, "height": h}

        return None
