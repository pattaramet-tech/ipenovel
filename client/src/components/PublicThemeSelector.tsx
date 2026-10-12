import { useEffect, useRef } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePublicTheme } from "@/contexts/PublicThemeContext";
import type { PublicThemePreference } from "@/lib/publicTheme";

const OPTIONS: {
  preference: PublicThemePreference;
  labelKey: string;
  ariaLabel: string;
  Icon: typeof Sun;
}[] = [
  { preference: "light", labelKey: "nav.theme.light", ariaLabel: "Light, สว่าง", Icon: Sun },
  { preference: "dark", labelKey: "nav.theme.dark", ariaLabel: "Dark, มืด", Icon: Moon },
  { preference: "system", labelKey: "nav.theme.system", ariaLabel: "System, ตามระบบ", Icon: Monitor },
];

type PublicThemeSelectorProps = {
  variant: "desktop" | "mobile";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenMenu: () => void;
  showMenu: boolean;
  rootRef?: React.Ref<HTMLDivElement>;
  menuItemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  onMenuKeyDown: (event: React.KeyboardEvent) => void;
};

export default function PublicThemeSelector({
  variant,
  open,
  onOpenChange,
  onOpenMenu,
  showMenu,
  rootRef,
  menuItemRefs,
  onMenuKeyDown,
}: PublicThemeSelectorProps) {
  const { t, language } = useLanguage();
  const { preference, resolved, setPreference } = usePublicTheme();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = variant === "desktop" ? "ipe-theme-menu" : "ipe-theme-menu-mobile";

  useEffect(() => {
    if (!open || !showMenu) return;
    const checkedIndex = OPTIONS.findIndex((option) => option.preference === preference);
    const target = menuItemRefs.current[checkedIndex >= 0 ? checkedIndex : 0];
    target?.focus();
  }, [open, showMenu, preference, menuItemRefs]);

  const preferenceLabel =
    preference === "system"
      ? t("nav.theme.system")
      : preference === "dark"
        ? t("nav.theme.dark")
        : t("nav.theme.light");
  const resolvedLabel =
    resolved === "dark" ? t("nav.theme.dark") : t("nav.theme.light");
  const triggerAriaLabel =
    language === "th"
      ? `ธีม, ${preferenceLabel}, แสดงผล ${resolvedLabel}`
      : `Theme, ${preferenceLabel}, currently ${resolvedLabel}`;

  const selectPreference = (next: PublicThemePreference) => {
    setPreference(next);
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-ipe-theme-toggle
        className="ipe-nav-link flex items-center justify-center min-w-10 min-h-10 w-10 h-10 rounded-full transition"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerAriaLabel}
        onClick={() => {
          if (!open) onOpenMenu();
          onOpenChange(!open);
        }}
      >
        {preference === "dark" ? (
          <Moon className="w-5 h-5" aria-hidden />
        ) : preference === "system" ? (
          <Monitor className="w-5 h-5" aria-hidden />
        ) : (
          <Sun className="w-5 h-5" aria-hidden />
        )}
      </button>
      {open && showMenu && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("nav.theme.menu")}
          onKeyDown={onMenuKeyDown}
          className={
            variant === "desktop"
              ? "ipe-nav-dropdown absolute right-0 top-full mt-2 min-w-[200px] rounded-xl p-1 z-50"
              : "ipe-nav-dropdown absolute right-0 top-full mt-2 min-w-[200px] rounded-xl p-1 z-50"
          }
        >
          {OPTIONS.map((option, index) => {
            const checked = preference === option.preference;
            return (
              <button
                key={option.preference}
                ref={(node) => {
                  menuItemRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                aria-label={option.ariaLabel}
                tabIndex={checked ? 0 : -1}
                className={`ipe-nav-dropdown-item flex items-center gap-2 w-full text-left px-3 py-2 text-sm transition ${
                  checked ? "ipe-nav-link-active" : ""
                }`}
                onClick={() => selectPreference(option.preference)}
              >
                <option.Icon className="w-4 h-4" aria-hidden />
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type ThemeMenuKeyDownHandler = (event: React.KeyboardEvent) => void;

export function createThemeMenuKeyDownHandler(
  open: boolean,
  onOpenChange: (open: boolean) => void,
  menuItemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
  triggerSelector: string,
): ThemeMenuKeyDownHandler {
  return (event: React.KeyboardEvent) => {
    if (!open) return;
    const items = menuItemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const focusItem = (index: number) => {
      const target = items[index];
      if (target) target.focus();
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(currentIndex < 0 ? 0 : (currentIndex + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && items.includes(active)) {
        active.click();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      document.querySelector<HTMLButtonElement>(triggerSelector)?.focus();
    }
  };
}
