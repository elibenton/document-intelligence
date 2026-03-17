"""Pure Python GLiNER 2 wrapper. No Modal imports — portable to local deployment."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class EntityMention:
    text: str  # Surface form in the document
    label: str  # Entity type: "person", "organization", etc.
    start: int  # Character offset in the page text
    end: int  # Character offset end
    score: float  # Confidence score
    page_number: int
    bbox: Optional[dict] = None  # Will be populated by span-to-bbox mapping


class NERService:
    """Wraps GLiNER for zero-shot named entity recognition."""

    def __init__(self):
        self.model = None

    def load_model(self):
        """Load GLiNER model into memory."""
        from gliner import GLiNER

        self.model = GLiNER.from_pretrained("urchade/gliner_multi_pii-v1")

    def run_ner(
        self,
        texts: list[str],
        labels: list[str],
        page_numbers: list[int],
        threshold: float = 0.5,
    ) -> list[EntityMention]:
        """Run zero-shot NER on a list of page texts.

        Args:
            texts: List of page texts (one per page)
            labels: Entity type labels to extract (e.g., ["person", "organization"])
            page_numbers: Corresponding page numbers for each text
            threshold: Minimum confidence score to include

        Returns:
            List of EntityMention objects across all pages
        """
        if self.model is None:
            self.load_model()

        all_mentions = []

        for text, page_num in zip(texts, page_numbers):
            if not text.strip():
                continue

            # GLiNER returns list of dicts with text, label, start, end, score
            entities = self.model.predict_entities(
                text, labels, threshold=threshold
            )

            for ent in entities:
                all_mentions.append(
                    EntityMention(
                        text=ent["text"],
                        label=ent["label"],
                        start=ent["start"],
                        end=ent["end"],
                        score=ent["score"],
                        page_number=page_num,
                    )
                )

        return all_mentions
