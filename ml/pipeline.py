"""Orchestrator: OCR -> NER -> entity resolution -> callback to Convex.

Pure Python — no Modal imports. Called by modal_app.py.
"""

import httpx

from ocr_service import OCRService, TextBlock
from ner_service import NERService, EntityMention
from entity_resolution import resolve_entities
from config import NER_LABELS_DEFAULT, NER_CONFIDENCE_THRESHOLD


def map_mentions_to_bboxes(
    mentions: list[EntityMention],
    page_text_blocks: dict[int, list[TextBlock]],
    page_texts: dict[int, str],
) -> None:
    """Map NER character spans to text block bounding boxes.

    For each mention, find which text block contains the mention text
    and assign that block's bounding box to the mention.
    Modifies mentions in-place.
    """
    for mention in mentions:
        blocks = page_text_blocks.get(mention.page_number, [])
        if not blocks:
            continue

        # Build cumulative character offset mapping for the page
        # The page text was built by joining block texts with newlines
        page_text = page_texts.get(mention.page_number, "")
        mention_text_lower = mention.text.lower()

        # Try to find the mention text within each block
        for block in blocks:
            if mention_text_lower in block.text.lower():
                mention.bbox = block.bbox
                break


def process_document(
    pdf_bytes: bytes,
    document_id: str,
    convex_site_url: str,
    ocr_service: OCRService,
    ner_service: NERService,
    labels: list[str] = NER_LABELS_DEFAULT,
    ner_threshold: float = NER_CONFIDENCE_THRESHOLD,
) -> None:
    """Run the full OCR -> NER -> dedup pipeline and post results to Convex."""

    # Step 1: OCR
    page_results = ocr_service.run_ocr(pdf_bytes)

    # Post OCR results to Convex
    ocr_payload = {
        "documentId": document_id,
        "pages": [
            {
                "pageNumber": p.page_number,
                "markdownText": p.markdown_text,
                "width": p.width,
                "height": p.height,
                "textBlocks": [
                    {
                        "text": b.text,
                        "bbox": b.bbox,
                        "blockType": b.block_type,
                        "confidence": b.confidence,
                    }
                    for b in p.text_blocks
                ],
            }
            for p in page_results
        ],
    }

    resp = httpx.post(f"{convex_site_url}/ingest/ocr", json=ocr_payload, timeout=60)
    resp.raise_for_status()

    # Step 2: NER
    texts = [p.markdown_text for p in page_results]
    page_numbers = [p.page_number for p in page_results]
    mentions = ner_service.run_ner(texts, labels, page_numbers, threshold=ner_threshold)

    # Step 3: Map mentions to bounding boxes
    page_text_blocks = {p.page_number: p.text_blocks for p in page_results}
    page_texts = {p.page_number: p.markdown_text for p in page_results}
    map_mentions_to_bboxes(mentions, page_text_blocks, page_texts)

    # Step 4: Entity resolution (fuzzy dedup)
    clusters = resolve_entities(mentions)

    # Step 5: Post NER results to Convex
    ner_payload = {
        "documentId": document_id,
        "entities": [
            {
                "canonicalName": cluster.canonical_name,
                "type": cluster.entity_type,
                "aliases": cluster.aliases,
                "isCustom": False,
                "mentions": [
                    {
                        "pageNumber": mentions[i].page_number,
                        "text": mentions[i].text,
                        "confidence": mentions[i].score,
                        "bbox": mentions[i].bbox,
                    }
                    for i in cluster.mention_indices
                ],
            }
            for cluster in clusters
        ],
    }

    resp = httpx.post(f"{convex_site_url}/ingest/ner", json=ner_payload, timeout=60)
    resp.raise_for_status()
