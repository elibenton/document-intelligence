"""Fuzzy entity deduplication using Jaro-Winkler similarity. No Modal imports."""

from dataclasses import dataclass, field
from rapidfuzz.distance import JaroWinkler

from config import ENTITY_SIMILARITY_THRESHOLD


@dataclass
class EntityCluster:
    canonical_name: str
    entity_type: str
    aliases: list[str] = field(default_factory=list)
    mention_indices: list[int] = field(default_factory=list)  # indices into the mentions list


def resolve_entities(
    mentions: list,  # list of EntityMention
    threshold: float = ENTITY_SIMILARITY_THRESHOLD,
) -> list[EntityCluster]:
    """Group entity mentions into clusters by fuzzy name matching.

    Uses Jaro-Winkler similarity within each entity type.
    The most frequent surface form becomes the canonical name.
    """
    # Group mentions by type
    by_type: dict[str, list[tuple[int, str]]] = {}
    for i, mention in enumerate(mentions):
        by_type.setdefault(mention.label, []).append((i, mention.text))

    clusters = []

    for entity_type, indexed_mentions in by_type.items():
        # Build clusters greedily
        type_clusters: list[EntityCluster] = []

        for idx, surface_form in indexed_mentions:
            matched = False
            for cluster in type_clusters:
                # Compare against canonical name and all aliases
                names_to_check = [cluster.canonical_name] + cluster.aliases
                for name in names_to_check:
                    sim = JaroWinkler.normalized_similarity(
                        surface_form.lower(), name.lower()
                    )
                    if sim >= threshold:
                        cluster.mention_indices.append(idx)
                        if surface_form != cluster.canonical_name and surface_form not in cluster.aliases:
                            cluster.aliases.append(surface_form)
                        matched = True
                        break
                if matched:
                    break

            if not matched:
                type_clusters.append(
                    EntityCluster(
                        canonical_name=surface_form,
                        entity_type=entity_type,
                        mention_indices=[idx],
                    )
                )

        # Re-elect canonical name as the most frequent surface form
        for cluster in type_clusters:
            all_forms = [mentions[i].text for i in cluster.mention_indices]
            from collections import Counter

            most_common = Counter(all_forms).most_common(1)[0][0]
            if most_common != cluster.canonical_name:
                old = cluster.canonical_name
                cluster.canonical_name = most_common
                cluster.aliases = [a for a in cluster.aliases if a != most_common]
                if old not in cluster.aliases:
                    cluster.aliases.append(old)

        clusters.extend(type_clusters)

    return clusters
