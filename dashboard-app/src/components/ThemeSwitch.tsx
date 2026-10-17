/**
 * local/ui — System / Light / Dark. Renders nothing when no `ThemeControllerContext` is provided
 * (component tests render `App` without `main.tsx`).
 */
import { ToggleButtonGroup, ToggleIconButton } from "@launchpad-ui/components";
import { THEME_PREFERENCES, type ThemePreference } from "../theme/theme-controller.js";
import { useThemePreference } from "../theme/theme-context.js";

const LABELS: Record<ThemePreference, string> = { system: "Use system theme", default: "Light theme", dark: "Dark theme" };
const ICONS = { system: "device-desktop", default: "theme-light", dark: "theme-dark" } as const;

export function ThemeSwitch() {
  const { controller, preference } = useThemePreference();
  if (!controller || !preference) return null;
  return (
    <ToggleButtonGroup
      aria-label="theme"
      className="bt-theme-switch"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[preference]}
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        if (typeof next === "string" && (THEME_PREFERENCES as readonly string[]).includes(next)) controller.setPreference(next as ThemePreference);
      }}
    >
      {THEME_PREFERENCES.map((p) => (
        <ToggleIconButton key={p} id={p} icon={ICONS[p]} size="small" variant="minimal" aria-label={LABELS[p]} />
      ))}
    </ToggleButtonGroup>
  );
}
