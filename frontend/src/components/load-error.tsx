import { Link, useRouteError } from "react-router-dom";
import { FileQuestion, RotateCcw, WifiOff } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";

/** A project page that could not load: says whether the project is gone or the request failed, and offers the way out. */
export function ProjectLoadError({ query }: { query: { error: unknown; isFetching: boolean; refetch: () => unknown } }) {
  if (!query.error) return <Skeleton className="h-64" />;
  const gone = query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403);
  if (gone) {
    return (
      <EmptyState
        icon={<FileQuestion />}
        title="This project does not exist"
        description="It may have been deleted, or the link belongs to someone else's project."
        action={
          <Link to="/library">
            <Button variant="secondary">Back to the Library</Button>
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<WifiOff />}
      title="Could not load this page"
      description="The server did not answer. Your work is saved on it; check the connection and try again."
      action={
        <Button variant="secondary" onClick={() => void query.refetch()} loading={query.isFetching}>
          <RotateCcw className="h-4 w-4" /> Try again
        </Button>
      }
    />
  );
}

/** Shown when a page crashes or its code cannot be fetched (for example after an update). */
export function RouteError() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <EmptyState
        className="max-w-md border-solid bg-card"
        icon={<RotateCcw />}
        title="This page stopped working"
        description="Nothing you saved is lost. Reloading usually fixes it; if the app was just updated, a reload fetches the new version."
        action={
          <div className="flex gap-2">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <a href="/library">
              <Button variant="secondary">Back to the Library</Button>
            </a>
          </div>
        }
      />
    </div>
  );
}
