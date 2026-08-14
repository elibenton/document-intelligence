import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const labels = {
  light: "Light theme",
  dark: "Dark theme",
  system: "System theme",
} as const;

/**
 * Single-button theme switch. Shows the active mode and cycles
 * light → dark → system on click.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme } = useTheme();
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={`${labels[theme]} — click to change`}
      aria-label={`${labels[theme]}. Click to change theme.`}
      className={cn(
        "p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0",
        className
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
