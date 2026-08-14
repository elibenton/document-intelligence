import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Form,
  Field,
  FieldLabel,
  FieldControl,
  FieldError,
} from "@/components/ui/field";
import { AuthLayout } from "@/components/auth/AuthLayout";

/**
 * Signing in runs through `authClient`, never through a Convex mutation:
 * Convex functions talk over a websocket and cannot set the session cookie.
 *
 * Server-side failures arrive as a message rather than a field, so they go into
 * Form's `errors` keyed by the field they are about — Base UI renders them
 * through the matching `<FieldError />` and wires `aria-describedby` itself.
 */
export default function SignInPage() {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  return (
    <AuthLayout
      title="Log in"
      footer={
        <>
          No account?{" "}
          <Link to="/signup" className="font-medium text-foreground underline">
            Sign up
          </Link>
        </>
      }
    >
      <Form
        errors={errors}
        onFormSubmit={async (values) => {
          setErrors({});
          setSubmitting(true);
          const { error } = await authClient.signIn.email({
            email: String(values.email ?? ""),
            password: String(values.password ?? ""),
          });
          setSubmitting(false);
          if (error) {
            // Better Auth deliberately does not say which of the two was wrong,
            // so the message hangs on the password field — the one worth
            // retyping.
            setErrors({ password: error.message ?? "Could not log in" });
            return;
          }
          void navigate("/");
        }}
      >
        <Field name="email">
          <FieldLabel>Email</FieldLabel>
          <FieldControl
            type="email"
            name="email"
            autoComplete="email"
            required
          />
          <FieldError />
        </Field>

        <Field name="password">
          <FieldLabel>Password</FieldLabel>
          <FieldControl
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
          <FieldError />
        </Field>

        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </Button>
      </Form>
    </AuthLayout>
  );
}
