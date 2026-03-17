import { DocumentList } from "@/components/documents/DocumentList";
import { EntityList } from "@/components/entities/EntityList";
import { Separator } from "@/components/ui/separator";

export default function HomePage() {
  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-4">
        <h1 className="text-xl font-bold">Document Intelligence</h1>
        <p className="text-sm text-muted-foreground">
          Upload PDFs, extract entities, uncover connections.
        </p>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/3 border-r p-4 overflow-y-auto">
          <DocumentList />
        </div>
        <Separator orientation="vertical" />
        <div className="w-1/3 border-r p-4 overflow-y-auto">
          <EntityList type="person" title="People" />
        </div>
        <Separator orientation="vertical" />
        <div className="w-1/3 p-4 overflow-y-auto">
          <EntityList type="organization" title="Organizations" />
        </div>
      </div>
    </div>
  );
}
