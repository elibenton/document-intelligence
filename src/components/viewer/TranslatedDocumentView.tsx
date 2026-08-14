import { Languages } from "lucide-react";
import { languageDirection, languageName } from "@/lib/languages";

interface TranslatedPage {
  pageNumber: number;
  text: string;
  targetLanguageCode: string;
}

export function TranslatedDocumentView({
  pages,
}: {
  pages: TranslatedPage[];
}) {
  const targetLanguageCode = pages[0]?.targetLanguageCode;

  return (
    <div className="h-full w-full overflow-y-auto bg-muted/20 px-4 py-8 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Languages className="size-4" />
          <span>Translated to {languageName(targetLanguageCode)}</span>
        </div>
        {pages.map((page) => (
          <article
            key={page.pageNumber}
            dir={languageDirection(page.targetLanguageCode)}
            className="rounded-lg border bg-card px-6 py-5 shadow-sm"
          >
            <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Page {page.pageNumber + 1}
            </p>
            <div className="whitespace-pre-wrap text-base leading-7 text-foreground">
              {page.text}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
