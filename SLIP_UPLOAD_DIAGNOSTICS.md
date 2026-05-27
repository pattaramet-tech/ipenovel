# Slip File Upload Diagnostics & Error Handling

## Overview

The slip file upload system now includes comprehensive error diagnostics, structured error handling, MIME validation, magic bytes checking, and detailed logging to help identify and resolve upload failures.

## Architecture

### Components

1. **storageErrorHandler.ts** - Structured error handling with diagnostics
   - `StorageUploadError` class for detailed error information
   - MIME type normalization (image/jpg → image/jpeg)
   - Magic bytes validation (JPEG, PNG, PDF)
   - Error mapping to TRPC codes with Thai messages

2. **storage.ts** - Enhanced S3 upload with error handling
   - Structured error catching and reporting
   - 30-second timeout for uploads
   - Credential validation at startup

3. **slipFileUploadService.ts** - Comprehensive file validation
   - MIME type validation and normalization
   - File size validation (max 5MB)
   - Magic bytes verification
   - Order total validation
   - Detailed request logging with sanitization

4. **uploadHealthCheck.ts** - Startup health verification
   - Checks storage configuration at server startup
   - Provides admin diagnostics endpoint

## Error Scenarios & Handling

### 1. Missing Storage Credentials

**Error Code**: `SERVICE_UNAVAILABLE`
**Message**: "ระบบอัปโหลดไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน"

**Root Cause**: `BUILT_IN_FORGE_API_URL` or `BUILT_IN_FORGE_API_KEY` not set

**Diagnostics**:
- Check server logs at startup: `[UploadHealth] ⚠ Storage service is NOT configured`
- Verify environment variables in deployment settings
- Contact admin to configure storage credentials

### 2. Authentication Error (401/403)

**Error Code**: `SERVICE_UNAVAILABLE`
**Message**: "ระบบจัดเก็บไฟล์มีปัญหา กรุณาติดต่อแอดมิน"

**Root Cause**: Invalid or expired API key

**Diagnostics**:
- Server logs: `statusCode: 401 or 403`
- Check `BUILT_IN_FORGE_API_KEY` is correctly set
- Verify API key has storage permissions
- Check if API key has expired

### 3. File Too Large (413)

**Error Code**: `BAD_REQUEST`
**Message**: "ไฟล์ใหญ่เกินไป กรุณาอัปโหลดไฟล์ที่เล็กกว่า 5MB"

**Root Cause**: File exceeds 5MB limit

**Diagnostics**:
- Server logs show: `size: [bytes], maxSize: 5242880`
- Client-side validation should catch this first
- If still occurring, check browser file size calculation

### 4. Network Timeout

**Error Code**: `SERVICE_UNAVAILABLE`
**Message**: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"

**Root Cause**: Network latency or storage service slow response

**Diagnostics**:
- Server logs: `statusCode: null, statusText: null`
- Check network connectivity
- Verify storage service is responding
- Retry upload (30-second timeout should be sufficient for most files)

### 5. Invalid MIME Type

**Error Code**: `BAD_REQUEST`
**Message**: "ไฟล์นี้ยังไม่รองรับ กรุณาอัปโหลด JPG, PNG หรือ PDF"

**Root Cause**: File type not in allowed list

**Diagnostics**:
- Server logs: `mimeType: [type]`
- Allowed types: `image/jpeg`, `image/png`, `application/pdf`
- Note: `image/jpg` is automatically normalized to `image/jpeg`
- Unsupported: `image/webp`, `image/heic`, `image/heif`

### 6. Invalid Magic Bytes

**Error Code**: `BAD_REQUEST`
**Message**: "ไฟล์ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง"

**Root Cause**: File content doesn't match declared MIME type

**Diagnostics**:
- Server logs: `firstBytes: [hex]`
- Expected magic bytes:
  - JPEG: `FF D8 FF`
  - PNG: `89 50 4E 47`
  - PDF: `25 50 44 46` (%PDF)
- File may be corrupted or renamed incorrectly

### 7. Invalid Base64

**Error Code**: `BAD_REQUEST`
**Message**: "ไฟล์ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง"

**Root Cause**: Base64 encoding error

**Diagnostics**:
- Server logs: `error: [decoding error]`
- Check FileReader.readAsDataURL() completed successfully
- Verify data URL format: `data:[mime];base64,[data]`

## Logging & Diagnostics

### Server Logs

All uploads are logged with request ID for tracing:

```
[SlipUpload] upload-1779899758447 File ready for upload: {
  userId: 123,
  context: 'payment_page',
  fileName: 'slip.jpg',
  fileKey: 'payment-slips/123/1779899758447-ngoc56-slip.jpg',
  size: 1000,
  mimeType: 'image/jpeg'
}

[SlipUpload] upload-1779899758447 Upload successful: {
  fileKey: 'payment-slips/123/1779899758447-ngoc56-slip.jpg',
  url: 'https://storage.example.com/...',
  isPDF: false
}
```

### Startup Health Check

At server startup, storage health is verified:

```
[UploadHealth] ✓ Storage service is configured and ready
```

If credentials are missing:

```
[UploadHealth] ⚠ Storage service is NOT configured. Set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY
```

## Testing

### Unit Tests (18 tests)

```bash
npm test -- slipFileUploadService
```

**Coverage**:
- Valid JPEG/PNG/PDF uploads
- MIME type normalization
- Unsupported MIME types
- File size validation
- Magic bytes validation
- Base64 validation
- Storage error handling
- Order total validation
- Data URL format handling

### Manual Testing

1. **Valid JPEG Upload**:
   - Select valid JPEG file < 5MB
   - Expected: Upload succeeds, OCR processes

2. **File Too Large**:
   - Select file > 5MB
   - Expected: Error "ไฟล์ใหญ่เกินไป..."

3. **Invalid MIME Type**:
   - Rename .webp to .jpg and upload
   - Expected: Error "ไฟล์ไม่ถูกต้อง..."

4. **Network Timeout**:
   - Disable network during upload
   - Expected: Error "อัปโหลดไฟล์ไม่สำเร็จ..."

## Frontend Error Display

### PaymentPage.tsx

Error messages are now displayed in real-time:

```typescript
try {
  const uploadResult = await uploadSlipFileMutation.mutateAsync({...});
} catch (error: any) {
  let errorMessage = t("payment.uploadFailed");
  
  if (error?.message) {
    errorMessage = error.message;  // Use server message (Thai)
  } else if (error?.data?.code === "BAD_REQUEST") {
    errorMessage = error?.data?.message || "ไฟล์ไม่ถูกต้อง...";
  } else if (error?.data?.code === "SERVICE_UNAVAILABLE") {
    errorMessage = error?.data?.message || "ระบบจัดเก็บไฟล์มีปัญหา...";
  }
  
  toast.error(errorMessage);
}
```

## Troubleshooting Guide

### "File upload failed" (Generic Error)

1. Check browser console for detailed error message
2. Check server logs for request ID
3. Verify file is valid (not corrupted)
4. Try different file format (JPG vs PNG)
5. Check file size < 5MB
6. Try again (may be temporary network issue)

### Storage Service Not Configured

1. Contact admin to set `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY`
2. Restart server after configuration
3. Check startup logs: `[UploadHealth] ✓ Storage service is configured and ready`

### Repeated Timeouts

1. Check network connectivity
2. Verify storage service is responding
3. Try uploading smaller file
4. Check if storage service has rate limits
5. Contact admin if issue persists

### Magic Bytes Error

1. Verify file is not corrupted
2. Try re-exporting/re-saving the file
3. Check file extension matches actual format
4. Try different image format (JPG vs PNG)

## Performance

- **Upload timeout**: 30 seconds
- **Max file size**: 5MB
- **Supported formats**: JPEG, PNG, PDF
- **Validation overhead**: < 100ms per file

## Security

- **Filename sanitization**: Removes special characters, limits to 255 chars
- **Magic bytes validation**: Ensures file content matches declared type
- **MIME type validation**: Whitelist of allowed types
- **File size limit**: Prevents abuse
- **Base64 validation**: Ensures proper encoding
- **Log sanitization**: Secrets not logged, content size logged instead
