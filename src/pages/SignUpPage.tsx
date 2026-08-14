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
  FieldDescription,
} from "@/components/ui/field";
import { AuthLayout } from "@/components/auth/AuthLayout";

/** Better Auth's own minimum; stated up front rather than after a failed try. */
const MIN_PASSWORD_LENGTH = 8;

export default function SignUpPage() {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  return (
    <AuthLayout
      title="Create an account"
      footer={
        <>
          Already have one?{" "}
          <Link to="/signin" className="font-medium text-foreground underline">
            Log in
          </Link>
        </>
      }
    >
      <Form
        errors={errors}
        onFormSubmit={async (values) => {
          setErrors({});
          setSubmitting(true);
          const { error } = await authClient.signUp.email({
            name: String(values.name ?? ""),
            email: String(values.email ?? ""),
            password: String(values.password ?? ""),
          });
          setSubmitting(false);
          if (error) {
            // An existing address is the one failure worth pointing at a
            // specific field; everything else is about the password.
            const field = error.code === "USER_ALREADY_EXISTS" ? "email" : "password";
            setErrors({ [field]: error.message ?? "Could not create account" });
            return;
          }
          void navigate("/");
        }}
      >
        <Field name="name">
          <FieldLabel>Name</FieldLabel>
          <FieldControl name="name" autoComplete="name" required />
          <FieldError />
        </Field>

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
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <FieldDescription>
            At least {MIN_PASSWORD_LENGTH} characters.
          </FieldDescription>
          <FieldError />
        </Field>

        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </Form>
    </AuthLayout>
  );
}
