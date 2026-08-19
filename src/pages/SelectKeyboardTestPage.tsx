import { useState } from "react";
import { Select } from "@/components/ui/select";

/** Throwaway harness for the keyboard pass — never committed. */
export default function SelectKeyboardTestPage() {
  const [value, setValue] = useState("b");
  return (
    <div className="mx-auto max-w-md p-8">
      <button type="button" id="before">
        before
      </button>
      <label htmlFor="test-select" className="mt-4 block text-sm font-medium">
        Test select
      </label>
      <Select
        id="test-select"
        value={value}
        onValueChange={setValue}
        items={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
        ]}
        className="mt-2 w-full"
      />
      <button type="button" id="after" className="mt-4">
        after
      </button>
      <p className="mt-4 text-sm">value: {value}</p>
    </div>
  );
}
