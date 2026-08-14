import { Navigate, Outlet } from "react-router";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { Spinner } from "@/components/ui/spinner";

/**
 * /signin and /signup, which are the two paths that mean something different
 * depending on the answer. Already signed in, they are just home.
 */
export default function SignedOutOnly() {
  return (
    <>
      <AuthLoading>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </AuthLoading>
      <Unauthenticated>
        <Outlet />
      </Unauthenticated>
      <Authenticated>
        <Navigate to="/" replace />
      </Authenticated>
    </>
  );
}
