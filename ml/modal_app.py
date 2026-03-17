"""Modal app definition. This is the ONLY file with Modal-specific imports.

All ML logic lives in the pure Python service classes (ocr_service.py, etc.).
To run locally, replace this with a FastAPI server calling the same services.
"""

import modal

app = modal.App("document-intelligence")

# Image with all Python deps
ml_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "chandra-ocr",
        "gliner",
        "rapidfuzz",
        "httpx",
        "Pillow",
        "fastapi[standard]",
    )
    .add_local_file("ocr_service.py", "/root/ocr_service.py")
    .add_local_file("ner_service.py", "/root/ner_service.py")
    .add_local_file("entity_resolution.py", "/root/entity_resolution.py")
    .add_local_file("pipeline.py", "/root/pipeline.py")
    .add_local_file("config.py", "/root/config.py")
)

# Persistent volume for caching model weights
model_volume = modal.Volume.from_name("docint-models", create_if_missing=True)


@app.cls(
    gpu="A10G",
    image=ml_image,
    volumes={"/models": model_volume},
    timeout=600,
    container_idle_timeout=300,
)
class DocumentProcessor:
    """Runs the full OCR -> NER -> dedup pipeline on a GPU."""

    @modal.enter()
    def load_models(self):
        import sys
        sys.path.insert(0, "/root")

        from ocr_service import OCRService
        from ner_service import NERService

        self.ocr_service = OCRService(method="hf")
        self.ocr_service.load_model()

        self.ner_service = NERService()
        self.ner_service.load_model()

    @modal.method()
    def process(self, pdf_bytes: bytes, document_id: str, convex_site_url: str):
        import sys
        sys.path.insert(0, "/root")

        from pipeline import process_document

        process_document(
            pdf_bytes=pdf_bytes,
            document_id=document_id,
            convex_site_url=convex_site_url,
            ocr_service=self.ocr_service,
            ner_service=self.ner_service,
        )


@app.function(image=ml_image, timeout=300)
@modal.web_endpoint(method="POST")
def process_endpoint(item: dict):
    """HTTP endpoint that Convex calls to trigger document processing."""
    import httpx

    document_id = item["documentId"]
    pdf_url = item["pdfUrl"]
    convex_site_url = item["convexSiteUrl"]

    # Download the PDF from Convex storage
    resp = httpx.get(pdf_url, timeout=120, follow_redirects=True)
    resp.raise_for_status()
    pdf_bytes = resp.content

    # Process on GPU
    processor = DocumentProcessor()
    processor.process.remote(pdf_bytes, document_id, convex_site_url)

    return {"status": "processing"}


@app.function(image=ml_image, timeout=300)
@modal.web_endpoint(method="POST")
def custom_ner_endpoint(item: dict):
    """HTTP endpoint for on-demand custom NER extraction."""
    import sys
    sys.path.insert(0, "/root")

    from ner_service import NERService
    from entity_resolution import resolve_entities
    import httpx

    label = item["label"]
    texts = item["texts"]
    document_ids = item["documentIds"]
    page_numbers = item["pageNumbers"]
    convex_site_url = item["convexSiteUrl"]
    threshold = item.get("threshold", 0.5)

    ner_service = NERService()
    ner_service.load_model()

    mentions = ner_service.run_ner(texts, [label], page_numbers, threshold=threshold)
    clusters = resolve_entities(mentions)

    # Group mentions by document
    # page_numbers and document_ids are parallel arrays
    doc_page_map = {}
    for i, (doc_id, page_num) in enumerate(zip(document_ids, page_numbers)):
        doc_page_map[(doc_id, page_num)] = True

    # Post results for each unique document
    unique_docs = set(document_ids)
    for doc_id in unique_docs:
        doc_entities = []
        for cluster in clusters:
            doc_mentions = [
                {
                    "pageNumber": mentions[i].page_number,
                    "text": mentions[i].text,
                    "confidence": mentions[i].score,
                }
                for i in cluster.mention_indices
                if document_ids[page_numbers.index(mentions[i].page_number)] == doc_id
            ]
            if doc_mentions:
                doc_entities.append({
                    "canonicalName": cluster.canonical_name,
                    "type": f"custom:{label}",
                    "aliases": cluster.aliases,
                    "isCustom": True,
                    "mentions": doc_mentions,
                })

        if doc_entities:
            payload = {"documentId": doc_id, "entities": doc_entities}
            resp = httpx.post(
                f"{convex_site_url}/ingest/ner", json=payload, timeout=60
            )
            resp.raise_for_status()

    return {"status": "completed", "entitiesFound": len(clusters)}
