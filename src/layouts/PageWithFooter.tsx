import { Outlet } from "react-router";
import { SiteFooter } from "@/components/SiteFooter";

/** Every page but the document viewer sits in this shell. */
export default function PageWithFooter() {
  return (
    <>
      <div className="flex-1">
        <Outlet />
      </div>
      <SiteFooter />
    </>
  );
}
