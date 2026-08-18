import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { Languages } from "lucide-react";
import { api } from "../../convex/_generated/api";
import ClipperTokenSettings from "@/components/settings/ClipperTokenSettings";
import ProviderAlert from "@/components/settings/ProviderAlert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { INTERFAZE_LANGUAGES, languageName } from "@/lib/languages";
import { PageShell, SectionHeading } from "@/components/ui/page-shell";
import { useConfirm } from "@/components/ui/use-confirm";

export default function SettingsPage() {
  const isAdmin = useQuery(api.authz.isAdmin);
  const settings = useQuery(api.settings.get);
  const updateDefaultLanguage = useMutation(api.settings.updateDefaultLanguage);
  const [languageDraft, setLanguageDraft] = useState("en");
  const [savingLanguage, setSavingLanguage] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (settings?.defaultLanguageCode) {
      setLanguageDraft(settings.defaultLanguageCode);
    }
  }, [settings?.defaultLanguageCode]);

  async function saveLanguage() {
    if (savingLanguage || languageDraft === settings?.defaultLanguageCode) return;

    const confirmed = await confirm({
      title: `Change the default language to ${languageName(languageDraft)}?`,
      body: "This retranslates the existing archive in the background and will incur additional API cost. Original source text is preserved.",
      confirmLabel: "Change language",
    });
    if (!confirmed) return;

    setSavingLanguage(true);
    try {
      await updateDefaultLanguage({ languageCode: languageDraft });
    } finally {
      setSavingLanguage(false);
    }
  }

  return (
    <PageShell
      title="Settings"
      subtitle="Your reading language, and whether the AI providers are healthy. Document types and entity types live in each project's settings."
      back={{ to: "/", label: "Back to projects" }}
      width="prose"
    >
      <>
        {/* Provider health — loud when a provider is down or out of credits */}
        <ProviderAlert />

        <SectionHeading>Language</SectionHeading>
        <div className="rounded-lg border bg-card p-4 mb-8">
          <div className="flex items-start gap-3">
            <Languages className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <label htmlFor="default-language" className="text-sm font-medium">
                Default language
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                New documents in another language are translated automatically.
                Existing documents update in the background when this changes.
              </p>
              {settings === undefined ? (
                <Skeleton className="mt-3 h-9 w-full max-w-sm" />
              ) : (
                <div className="mt-3 flex max-w-md items-center gap-2">
                  <select
                    id="default-language"
                    value={languageDraft}
                    onChange={(event) => setLanguageDraft(event.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
                  >
                    {INTERFAZE_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.name} ({language.code})
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={
                      savingLanguage ||
                      languageDraft === settings.defaultLanguageCode
                    }
                    onClick={() => void saveLanguage()}
                  >
                    {savingLanguage ? "Saving…" : "Save"}
                  </Button>
                </div>
              )}
              {settings && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Current default: {languageName(settings.defaultLanguageCode)}
                </p>
              )}
            </div>
          </div>
        </div>

        <SectionHeading>Web clipper</SectionHeading>
        <ClipperTokenSettings />

        {/* Tidiness only — the server is the gate. A non-admin who types
            /admin gets a thrown error either way. */}
        {isAdmin && (
          <p className="text-sm text-muted-foreground">
            <Link to="/admin" className="font-medium text-foreground underline">
              Deployment usage and queue controls
            </Link>{" "}
            — spend by operation and by day, the API log, and processing
            pause/resume.
          </p>
        )}
      </>
    </PageShell>
  );
}
