import { useState } from "react";
import { AlertCircle } from "lucide-react";

interface SafeImageProps {
  src?: string;
  alt: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * SafeImage component that validates URLs and shows a placeholder if the image fails to load
 * or if the URL is invalid
 */
export default function SafeImage({
  src,
  alt,
  className = "w-10 h-14 object-cover rounded",
  fallbackClassName = "w-10 h-14 bg-slate-200 rounded flex items-center justify-center",
}: SafeImageProps) {
  const [hasError, setHasError] = useState(false);

  // Validate URL - only allow http://, https://, or app-relative paths
  const isValidUrl = (url?: string): boolean => {
    if (!url) return false;
    try {
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const isValid = isValidUrl(src);

  if (!isValid || hasError) {
    return (
      <div className={fallbackClassName}>
        <AlertCircle className="w-4 h-4 text-slate-400" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setHasError(true)}
    />
  );
}
