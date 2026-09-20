// src/utils/imageStorage.js
// Stores an uploaded event cover image and returns the URL the app serves
// it back at. Honest about what's actually wired up here (same "real when
// configured, plain fallback otherwise" pattern as the payment providers):
// no durable, multi-instance object store (Cloud Storage / S3) is configured
// in this environment, so images are written to local disk and served via
// express.static. That's genuinely fine for a single instance, but it does
// NOT survive a redeploy and is NOT shared across multiple Cloud Run/Railway
// instances — wiring up real object storage is the natural next step for a
// production deployment, tracked as a known gap rather than faked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'event-images');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 5 * 1024 * 1024;

function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime);
}

// Always false here — see the file header. Exists so callers can key off it
// the same way every other provider in this app dispatches real-vs-fallback.
function isConfigured() {
  return false;
}

// Saves a buffer to disk and returns the public URL path (served by
// express.static) plus the underlying filesystem path, so a caller can clean
// up an old image after replacing it.
function saveEventImage(eventId, buffer, mimeType) {
  if (!isAllowedMime(mimeType)) {
    throw Object.assign(new Error('Unsupported image type — use JPEG, PNG, or WebP'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('Image is too large — max 5MB'), { status: 400 });
  }
  const ext = ALLOWED_MIME[mimeType];
  const filename = `${eventId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return { url: `/uploads/event-images/${filename}`, filePath };
}

// Best-effort delete of a previously-saved local image — never throws, since
// losing track of an old file is cosmetic (a little wasted disk), never a
// correctness problem worth failing the caller's request over.
function deleteEventImage(url) {
  if (!url || !url.startsWith('/uploads/event-images/')) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(url));
  fs.unlink(filePath, () => {});
}

module.exports = { isConfigured, isAllowedMime, saveEventImage, deleteEventImage, MAX_BYTES, ALLOWED_MIME };
