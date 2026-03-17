import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { useUpload } from "@/hooks/useUpload";

export function UploadButton() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading } = useUpload();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type === "application/pdf") {
        await upload(file);
      }
    }

    // Reset input so the same file can be uploaded again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        size="sm"
      >
        {isUploading ? "Uploading..." : "Upload PDFs"}
      </Button>
    </>
  );
}
