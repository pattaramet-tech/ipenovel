import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export default function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage();

  return (
    <div className="flex items-center gap-1 bg-muted rounded-full p-1 relative">
      {/* Sliding indicator background */}
      <div
        className={cn(
          "absolute top-1 bottom-1 w-1/2 bg-background rounded-full transition-all duration-300 ease-out shadow-sm",
          language === "th" ? "left-1" : "left-1/2"
        )}
      />

      {/* Thai button */}
      <button
        onClick={() => setLanguage("th")}
        className={cn(
          "relative z-10 flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-200",
          language === "th"
            ? "text-foreground font-semibold"
            : "text-muted-foreground hover:text-foreground"
        )}
        title="ไทย"
        aria-label="Switch to Thai"
      >
        <span className="text-lg">🇹🇭</span>
      </button>

      {/* English button */}
      <button
        onClick={() => setLanguage("en")}
        className={cn(
          "relative z-10 flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-200",
          language === "en"
            ? "text-foreground font-semibold"
            : "text-muted-foreground hover:text-foreground"
        )}
        title="English"
        aria-label="Switch to English"
      >
        <span className="text-lg">🇬🇧</span>
      </button>
    </div>
  );
}
