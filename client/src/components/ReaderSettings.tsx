import { useLanguage } from "@/contexts/LanguageContext";
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  PARAGRAPH_SPACING_MAX,
  PARAGRAPH_SPACING_MIN,
  PARAGRAPH_SPACING_STEP,
  type ReaderPreferences,
  type ReaderTheme,
} from "@/hooks/useReaderPreferences";
import styles from "./ReaderSettings.module.css";

interface ReaderSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: ReaderPreferences;
  onChange: <K extends keyof ReaderPreferences>(key: K, value: ReaderPreferences[K]) => void;
  onReset: () => void;
}

export default function ReaderSettings({ isOpen, onClose, preferences, onChange, onReset }: ReaderSettingsProps) {
  const { t } = useLanguage();

  if (!isOpen) return null;

  const themeClass = preferences.theme === "dark" ? styles.dark : preferences.theme === "sepia" ? styles.sepia : "";

  const themeOptions: { value: ReaderTheme; icon: string; labelKey: string }[] = [
    { value: "light", icon: "☀", labelKey: "reader.light" },
    { value: "dark", icon: "◐", labelKey: "reader.dark" },
    { value: "sepia", icon: "◈", labelKey: "reader.sepia" },
  ];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.panel} ${themeClass}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>{t("reader.readingSettings")}</h3>
          <button onClick={onClose} aria-label="ปิด" className={styles.closeButton}>
            ×
          </button>
        </div>

        <div className={styles.body}>
          {/* Font Size */}
          <div className={styles.section}>
            <label className={styles.sectionLabel}>{t("reader.fontSize")}</label>
            <div className={styles.stepper}>
              <button
                onClick={() => onChange("fontSize", Math.max(FONT_SIZE_MIN, preferences.fontSize - FONT_SIZE_STEP))}
                aria-label="ลดขนาดตัวอักษร"
              >
                A−
              </button>
              <span>{preferences.fontSize}px</span>
              <button
                onClick={() => onChange("fontSize", Math.min(FONT_SIZE_MAX, preferences.fontSize + FONT_SIZE_STEP))}
                aria-label="เพิ่มขนาดตัวอักษร"
              >
                A+
              </button>
            </div>
          </div>

          {/* Font Family */}
          <div className={styles.section}>
            <label className={styles.sectionLabel}>{t("reader.fontFamily")}</label>
            <div className={styles.fontGrid}>
              {FONT_FAMILY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`${styles.fontOption} ${preferences.fontFamily === option.value ? styles.active : ""}`}
                  style={option.stack ? { fontFamily: option.stack } : undefined}
                  onClick={() => onChange("fontFamily", option.value)}
                >
                  {option.labelKey.startsWith("reader.") ? t(option.labelKey) : option.labelKey}
                </button>
              ))}
            </div>
          </div>

          {/* Line Height */}
          <div className={styles.section}>
            <label className={styles.sectionLabel}>{t("reader.lineHeight")}</label>
            <div className={styles.stepper}>
              <button
                onClick={() => onChange("lineHeight", Math.max(LINE_HEIGHT_MIN, Math.round((preferences.lineHeight - LINE_HEIGHT_STEP) * 10) / 10))}
                aria-label="ลดระยะห่างบรรทัด"
              >
                −
              </button>
              <span>{preferences.lineHeight.toFixed(1)}</span>
              <button
                onClick={() => onChange("lineHeight", Math.min(LINE_HEIGHT_MAX, Math.round((preferences.lineHeight + LINE_HEIGHT_STEP) * 10) / 10))}
                aria-label="เพิ่มระยะห่างบรรทัด"
              >
                +
              </button>
            </div>
          </div>

          {/* Paragraph Spacing */}
          <div className={styles.section}>
            <label className={styles.sectionLabel}>{t("reader.paragraphSpacing")}</label>
            <div className={styles.stepper}>
              <button
                onClick={() => onChange("paragraphSpacing", Math.max(PARAGRAPH_SPACING_MIN, preferences.paragraphSpacing - PARAGRAPH_SPACING_STEP))}
                aria-label="ลดระยะห่างย่อหน้า"
              >
                −
              </button>
              <span>{preferences.paragraphSpacing}px</span>
              <button
                onClick={() => onChange("paragraphSpacing", Math.min(PARAGRAPH_SPACING_MAX, preferences.paragraphSpacing + PARAGRAPH_SPACING_STEP))}
                aria-label="เพิ่มระยะห่างย่อหน้า"
              >
                +
              </button>
            </div>
          </div>

          {/* Theme */}
          <div className={styles.section}>
            <label className={styles.sectionLabel}>{t("reader.theme")}</label>
            <div className={styles.themeRow}>
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  className={preferences.theme === option.value ? styles.active : ""}
                  onClick={() => onChange("theme", option.value)}
                  title={t(option.labelKey)}
                >
                  {option.icon}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button onClick={onReset} className={styles.resetButton}>
            {t("reader.resetDefaults")}
          </button>
        </div>
      </div>
    </div>
  );
}
