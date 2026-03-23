import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useUpload() {
  const generateUploadUrl = useMutation(api.upload.generateUploadUrl);
  const createDocument = useMutation(api.upload.createDocument);
  const [isUploading, setIsUploading] = useState(false);

  async function upload(file: File) {
    setIsUploading(true);
    try {
      const url = await generateUploadUrl();
      const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await result.json();
      const documentId = await createDocument({
        name: file.name,
        storageId,
        mimeType: file.type,
      });
      return documentId;
    } finally {
      setIsUploading(false);
    }
  }

  return { upload, isUploading };
}
