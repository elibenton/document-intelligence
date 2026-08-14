import DocumentPage from "@/pages/DocumentPage";

/**
 * The document viewer is a fixed-height workspace of its own, so it sits
 * outside the footer shell and supplies the page's <main> itself.
 *
 * A wrapper rather than an edit to DocumentPage: that component returns from
 * three places, so wrapping it there would mean the same element pasted three
 * times.
 */
export default function DocumentRoute() {
  return (
    <main id="main" className="flex-1 min-h-0">
      <DocumentPage />
    </main>
  );
}
