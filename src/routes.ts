import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

/**
 * The route table that App.tsx used to hold as two overlapping <Routes> trees.
 *
 * The auth branch is not expressible here — a table is static, and signed out
 * every path has to render the landing page with the URL preserved — so it
 * lives in AuthGate instead. See docs/react-router-framework-mode-plan.md §1.
 */
export default [
  layout("layouts/AuthGate.tsx", [
    layout("layouts/PageWithFooter.tsx", [
      index("pages/ProjectsPage.tsx"),
      route("p/:slug", "pages/HomePage.tsx"),
      route("p/:slug/settings", "pages/ProjectSettingsPage.tsx"),
      route("p/:slug/timeline", "pages/ProjectTimelinePage.tsx"),
      route("entity/:slug", "pages/EntityPage.tsx"),
      route("search", "pages/SearchPage.tsx"),
      route("settings", "pages/SettingsPage.tsx"),
      // Opened by the clipper extension with ?ext=<its id>; AuthGate supplies
      // the sign-in requirement, the page hands the token to the extension.
      route("clipper/connect", "pages/ClipperConnectPage.tsx"),
      // Gated on the server by adminQuery, not by this route. A non-admin who
      // types the URL gets a thrown error, which is the correct outcome.
      route("admin", "pages/AdminPage.tsx"),
      route("admin/issues", "pages/AdminIssuesPage.tsx"),
      route("*", "pages/NotFoundPage.tsx"),
    ]),
    route("documents/:id", "pages/DocumentRoute.tsx"),
  ]),
  layout("layouts/SignedOutOnly.tsx", [
    route("signin", "pages/SignInPage.tsx"),
    route("signup", "pages/SignUpPage.tsx"),
  ]),
] satisfies RouteConfig;
