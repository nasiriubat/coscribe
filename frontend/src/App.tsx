import { lazy } from "react";
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { StageProgress } from "@/components/stage-progress";
import { RouteError } from "@/components/load-error";
// Eager: everything needed for the first paint (sign-in, the library, the public pages).
import { LoginPage } from "@/pages/login";
import { ResetPasswordPage } from "@/pages/reset-password";
import { LibraryPage, ProfilesPage } from "@/pages/library";
import { PublicPageView } from "@/pages/public-page";
import { LandingPage } from "@/pages/landing";
import { useSite } from "@/lib/site";

// Lazy: the workspace and admin screens. This keeps the editor (CodeMirror), the diagram
// renderer (Mermaid) and the Markdown/KaTeX preview out of the initial bundle; each loads
// only when its screen is first opened, behind the Suspense boundary in AppShell.
const named = <T,>(p: Promise<Record<string, T>>, key: string) => p.then((m) => ({ default: m[key] as T }));
const ProjectHomePage = lazy(() => named(import("@/pages/project-home"), "ProjectHomePage"));
const SourcesPage = lazy(() => named(import("@/pages/sources"), "SourcesPage"));
const PlaybookPage = lazy(() => named(import("@/pages/playbook"), "PlaybookPage"));
const DesignPage = lazy(() => named(import("@/pages/design"), "DesignPage"));
const InterviewPage = lazy(() => named(import("@/pages/interview"), "InterviewPage"));
const OutlinePage = lazy(() => named(import("@/pages/outline"), "OutlinePage"));
const SpecPage = lazy(() => named(import("@/pages/spec"), "SpecPage"));
const StudioPage = lazy(() => named(import("@/pages/studio"), "StudioPage"));
const ReferencesPage = lazy(() => named(import("@/pages/references"), "ReferencesPage"));
const FiguresPage = lazy(() => named(import("@/pages/figures"), "FiguresPage"));
const ExportPage = lazy(() => named(import("@/pages/export"), "ExportPage"));
const ReviewPage = lazy(() => named(import("@/pages/review"), "ReviewPage"));
const ProfilePage = lazy(() => named(import("@/pages/profile-page"), "ProfilePage"));
const AccountPage = lazy(() => named(import("@/pages/account"), "AccountPage"));
const AdminLayout = lazy(() => named(import("@/pages/admin/layout"), "AdminLayout"));
const ProvidersPage = lazy(() => named(import("@/pages/admin/providers"), "ProvidersPage"));
const ModelsPage = lazy(() => named(import("@/pages/admin/models"), "ModelsPage"));
const KindsPage = lazy(() => named(import("@/pages/admin/kinds"), "KindsPage"));
const HouseStylePage = lazy(() => named(import("@/pages/admin/house-style"), "HouseStylePage"));
const UsersPage = lazy(() => named(import("@/pages/admin/users"), "UsersPage"));
const UsagePage = lazy(() => named(import("@/pages/admin/usage"), "UsagePage"));
const PagesPage = lazy(() => named(import("@/pages/admin/site"), "PagesPage"));
const SiteTab = lazy(() => named(import("@/pages/admin/site"), "SiteTab"));
const StoragePage = lazy(() => named(import("@/pages/admin/storage"), "StoragePage"));
const StudyPage = lazy(() => named(import("@/pages/admin/study"), "StudyPage"));

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}

/** Wraps every project stage page with the guided "Step N of M" progress strip. */
function ProjectLayout() {
  return (
    <>
      <StageProgress />
      <Outlet />
    </>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <AppShell />;
}

function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}

function PublicOnly() {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (user) return <Navigate to={user.must_change_password ? "/account" : "/"} replace />;
  return <Outlet />;
}

/** Root for visitors: the configured homepage page, or the sign-in page. */
function Root() {
  const { user, loading } = useAuth();
  const site = useSite();
  if (loading) return <Splash />;
  if (user) return <Navigate to={user.must_change_password ? "/account" : "/library"} replace />;
  if (site.homepage === "login") return <Navigate to="/login" replace />;
  if (site.homepage && site.homepage !== "landing") return <PublicPageView slug={site.homepage} />;
  return <LandingPage />;
}

const router = createBrowserRouter([
  { path: "/", element: <Root />, errorElement: <RouteError /> },
  { path: "/landing", element: <LandingPage /> },
  { path: "/p/:slug", element: <PublicPageView /> },
  {
    element: <PublicOnly />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/reset-password", element: <ResetPasswordPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: "/library", element: <LibraryPage /> },
      { path: "/profiles", element: <ProfilesPage /> },
      { path: "/profiles/:slug", element: <ProfilePage /> },
      {
        path: "/projects/:slug",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <ProjectHomePage /> },
          { path: "sources", element: <SourcesPage /> },
          { path: "playbook", element: <PlaybookPage /> },
          { path: "design", element: <DesignPage /> },
          { path: "interview", element: <InterviewPage /> },
          { path: "outline", element: <OutlinePage /> },
          { path: "spec", element: <SpecPage /> },
          { path: "studio", element: <StudioPage /> },
          { path: "references", element: <ReferencesPage /> },
          { path: "figures", element: <FiguresPage /> },
          { path: "export", element: <ExportPage /> },
          { path: "review", element: <ReviewPage /> },
        ],
      },
      { path: "/account", element: <AccountPage /> },
      {
        element: <RequireAdmin />,
        children: [
          {
            path: "/admin",
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="providers" replace /> },
              { path: "providers", element: <ProvidersPage /> },
              { path: "models", element: <ModelsPage /> },
              { path: "kinds", element: <KindsPage /> },
              { path: "house-style", element: <HouseStylePage /> },
              { path: "users", element: <UsersPage /> },
              { path: "usage", element: <UsagePage /> },
              { path: "storage", element: <StoragePage /> },
              { path: "study", element: <StudyPage /> },
              { path: "site", element: <SiteTab /> },
              { path: "pages", element: <PagesPage /> },
            ],
          },
        ],
      },
      { path: "*", element: <Navigate to="/library" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
