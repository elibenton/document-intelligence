import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Form as FormPrimitive } from "@base-ui/react/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Labelled form fields with their error messages wired up.
 *
 * This exists so screens never hand-write the association between a label, an
 * input and its error text. Base UI's Field owns `htmlFor`/`id`, `aria-invalid`
 * and `aria-describedby`; `Input` already styles the `aria-invalid:` states it
 * sets, so the two were built to meet — they just hadn't been introduced.
 *
 * `Form` takes an `errors` object keyed by field `name`, which is the shape a
 * server hands back. A bare `<FieldError />` renders whatever arrived under its
 * field's name; `match` narrows to a client-side ValidityState instead.
 */
function Field({
  className,
  ...props
}: React.ComponentProps<typeof FieldPrimitive.Root>) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof FieldPrimitive.Label>) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

/**
 * The field-aware input. Base UI's standalone `Input` does not read Field
 * context, so the control has to come from `Field.Control` — rendered as our
 * styled `Input` so there is still one place that decides what an input looks
 * like.
 */
function FieldControl({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <FieldPrimitive.Control
      data-slot="field-control"
      render={<Input className={className} />}
      {...props}
    />
  );
}

function FieldError({
  className,
  ...props
}: React.ComponentProps<typeof FieldPrimitive.Error>) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn("text-xs text-destructive", className)}
      {...props}
    />
  );
}

function FieldDescription({
  className,
  ...props
}: React.ComponentProps<typeof FieldPrimitive.Description>) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function Form({
  className,
  ...props
}: React.ComponentProps<typeof FormPrimitive>) {
  return (
    <FormPrimitive
      data-slot="form"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}

export { Form, Field, FieldLabel, FieldControl, FieldError, FieldDescription };
