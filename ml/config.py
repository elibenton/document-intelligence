"""Configuration for the ML pipeline."""

# OCR settings
OCR_DPI = 300  # DPI for PDF to image conversion (Chandra default)
OCR_METHOD = "hf"  # "hf" (HuggingFace) or "vllm"

# NER settings
NER_LABELS_DEFAULT = ["person", "organization"]
NER_CONFIDENCE_THRESHOLD = 0.5

# Entity resolution settings
ENTITY_SIMILARITY_THRESHOLD = 0.92  # Jaro-Winkler threshold for merging
