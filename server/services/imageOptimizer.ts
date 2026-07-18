// Image optimization for newly-uploaded media (novel covers, banners):
// validates the buffer is actually a decodable raster image, resizes it down
// to a sane max footprint, and re-encodes it as WebP to cut bandwidth before
// it goes to R2 (see r2Storage.ts). Never upscales a smaller source image.
import sharp from "sharp";

export class ImageOptimizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageOptimizeError";
  }
}

export interface OptimizeImageOptions {
  /** Max width in px - the image is downscaled (never upscaled) to fit,
   *  preserving aspect ratio. */
  maxWidth: number;
  /** Max height in px, same downscale-only behavior as maxWidth. */
  maxHeight: number;
  /** WebP quality, 1-100. */
  quality?: number;
}

export interface OptimizedImage {
  buffer: Buffer;
  contentType: "image/webp";
  width: number;
  height: number;
}

// Shared presets - the single source of truth for both the live upload
// endpoints (admin.novels.uploadCover / admin.banners.uploadImage in
// routers.ts) and scripts/migrate-media-to-r2.ts, so a migrated image is
// always optimized identically to a freshly-uploaded one.
export const NOVEL_COVER_PRESET: OptimizeImageOptions = { maxWidth: 1000, maxHeight: 1500 };
export const BANNER_IMAGE_PRESET: OptimizeImageOptions = { maxWidth: 1920, maxHeight: 800 };

/**
 * Decode, resize, and re-encode an uploaded image buffer as WebP. Throws
 * ImageOptimizeError (never a raw sharp error) if the buffer isn't a
 * decodable image at all, so callers can turn it into a clear 400 instead of
 * a generic 500.
 */
export async function optimizeImageToWebp(
  input: Buffer,
  options: OptimizeImageOptions
): Promise<OptimizedImage> {
  const { maxWidth, maxHeight, quality = 82 } = options;

  let pipeline = sharp(input, { failOn: "none" });

  try {
    await pipeline.metadata();
  } catch (error: any) {
    throw new ImageOptimizeError("ไฟล์ที่อัปโหลดไม่ใช่รูปภาพที่รองรับ หรือไฟล์เสียหาย");
  }

  try {
    const result = await pipeline
      .rotate() // apply EXIF orientation before resizing, then strip metadata
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: result.data,
      contentType: "image/webp",
      width: result.info.width,
      height: result.info.height,
    };
  } catch (error: any) {
    throw new ImageOptimizeError(`ไม่สามารถแปลงรูปภาพเป็น WebP ได้: ${error?.message || "unknown error"}`);
  }
}
