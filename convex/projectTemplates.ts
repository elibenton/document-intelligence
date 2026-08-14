/**
 * What a new project starts out believing.
 *
 * A template is the three things a project has to decide before it reads a
 * single document: the categories Analyze sorts into, the entity types the
 * graph pass looks for beyond people and organizations, and how citations are
 * formatted. Every one of them is editable afterwards from project settings —
 * a template is a starting point, not a mode.
 *
 * Pure data with no server imports, so the new-project dialog and
 * `projects.create` read the same definitions rather than keeping two copies
 * that drift. (A second copy of the Analyze schema is how web clips quietly
 * stopped extracting; this file exists so that cannot happen here.)
 */

/** The citation styles a project can pick. See src/lib/citation/. */
export const CITATION_STYLES = ["numeric", "chicago", "mla", "apa"] as const;
export type CitationStyle = (typeof CITATION_STYLES)[number];

/** Absent `projects.citationStyle` means this — nothing to backfill. */
export const DEFAULT_CITATION_STYLE: CitationStyle = "numeric";

export const CITATION_STYLE_LABELS: Record<CitationStyle, string> = {
  numeric: "Numbered sources",
  chicago: "Chicago (notes & bibliography)",
  mla: "MLA",
  apa: "APA",
};

/**
 * No `key` field: the key is derived from the label by the same slugify
 * `documentCategories.create` uses, so a seeded category and a hand-added one
 * are keyed by one rule rather than two that can disagree. The four
 * investigative labels slugify back to the exact keys every existing document
 * already stores ("legal", "government", "business", "published"), which is
 * what makes dropping the field safe.
 */
export interface TemplateCategory {
  label: string;
  /** Told to Analyze verbatim as the rule for this bucket. */
  description: string;
  /** Key into CATEGORY_COLOR_PALETTE in src/components/documents/docTypeCategories.ts. */
  color: string;
}

export interface TemplateEntityType {
  label: string;
  /** Told to the graph pass verbatim, so it reads as a definition. */
  description: string;
}

export interface ProjectTemplate {
  key: string;
  label: string;
  /** One line, shown on the template card in the new-project dialog. */
  description: string;
  citationStyle: CitationStyle;
  categories: TemplateCategory[];
  entityTypes: TemplateEntityType[];
}

/**
 * The four categories every document in this deployment was already filed
 * against before templates existed, kept verbatim so choosing this template
 * reproduces the app's previous behavior exactly — including the numbered
 * citations, which is what search has always rendered.
 */
const INVESTIGATIVE_CATEGORIES: TemplateCategory[] = [
  {
    label: "Legal",
    description:
      "Instruments with legal force or filed in a legal proceeding — pleadings, orders, contracts, deeds, subpoenas.",
    color: "violet",
  },
  {
    label: "Government",
    description:
      "Records a public agency produced or received while administering something — permits, inspection reports, agency correspondence, public-records responses.",
    color: "blue",
  },
  {
    label: "Business",
    description:
      "Records internal to a private organization — invoices, memos, financial statements, board minutes, personnel files.",
    color: "amber",
  },
  {
    label: "Published",
    description:
      "Anything issued to a general audience — news articles, press releases, books, academic papers, web pages.",
    color: "teal",
  },
];

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "investigative",
    label: "Investigative journalism",
    description:
      "Mixed public records, filings and reporting. The app's original defaults.",
    citationStyle: "numeric",
    categories: INVESTIGATIVE_CATEGORIES,
    entityTypes: [],
  },
  {
    key: "legal",
    label: "Legal",
    description: "A matter's filings, discovery and correspondence.",
    citationStyle: "chicago",
    categories: [
      {
        label: "Pleadings",
        description:
          "Filings that state a party's position or ask the court to act — complaints, answers, motions, briefs, petitions.",
        color: "violet",
      },
      {
        label: "Orders & judgments",
        description:
          "The court's own output — orders, judgments, rulings, findings, writs, notices of entry.",
        color: "rose",
      },
      {
        label: "Discovery",
        description:
          "Material exchanged between parties — deposition transcripts, interrogatories, requests for production, responses, privilege logs.",
        color: "blue",
      },
      {
        label: "Contracts",
        description:
          "Instruments that create or transfer obligations — agreements, amendments, deeds, assignments, settlements.",
        color: "amber",
      },
      {
        label: "Correspondence",
        description:
          "Letters, emails and memoranda between parties, counsel, or agencies.",
        color: "teal",
      },
      {
        label: "Exhibits",
        description:
          "Material attached to a filing as evidence rather than filed in its own right — attachments, appendices, marked exhibits.",
        color: "slate",
      },
    ],
    entityTypes: [
      {
        label: "Courts",
        description:
          "A court, tribunal or arbitral body that issues or receives filings.",
      },
      {
        label: "Matters",
        description:
          "A case or proceeding, identified by its case name or docket number.",
      },
    ],
  },
  {
    key: "academic",
    label: "Academic research",
    description: "A literature corpus — papers, books, datasets, grey literature.",
    citationStyle: "apa",
    categories: [
      {
        label: "Journal articles",
        description:
          "Peer-reviewed articles published in a journal, with a container title and usually a volume and issue.",
        color: "violet",
      },
      {
        label: "Books & chapters",
        description:
          "Monographs, edited volumes, and individual chapters within them.",
        color: "amber",
      },
      {
        label: "Preprints",
        description:
          "Manuscripts posted to a preprint server before or without peer review — arXiv, bioRxiv, SSRN.",
        color: "blue",
      },
      {
        label: "Datasets",
        description:
          "Data deposits and their documentation — codebooks, data dictionaries, supplementary tables.",
        color: "teal",
      },
      {
        label: "Theses",
        description: "Doctoral dissertations and master's theses.",
        color: "rose",
      },
      {
        label: "Grey literature",
        description:
          "Material issued outside commercial publishing — working papers, technical and institutional reports, conference material, white papers.",
        color: "slate",
      },
    ],
    entityTypes: [
      {
        label: "Methods",
        description:
          "A named method, assay, instrument or protocol a study applies.",
      },
      {
        label: "Datasets",
        description:
          "A named dataset, cohort, corpus or collection a study draws on.",
      },
    ],
  },
  {
    key: "custom",
    label: "Custom",
    description:
      "Start empty and define your own categories and entity types as you go.",
    citationStyle: "numeric",
    categories: [],
    entityTypes: [],
  },
];

export const DEFAULT_TEMPLATE_KEY = "investigative";

export function templateByKey(key: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((template) => template.key === key);
}
