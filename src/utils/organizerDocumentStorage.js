// src/utils/organizerDocumentStorage.js
// Stores an organizer's identity/business verification document (ID scan,
// business registration certificate, etc.) submitted for admin review.
//
// Deliberately kept OUT of the uploads/ directory that event images live in
// (see imageStorage.js) — that directory is mounted with express.static and
// served publicly to anyone with the URL. These documents can contain real
// PII (a government ID photo, a business registration number) and must
// never be reachable except through an authenticated route that checks the
// requester is either the owning organizer or a platform admin (see the
// /organizer/documents/:id/file and /admin/organizers/:id/documents/:docId/file
// routes). Same "real when configured, honest fallback otherwise" caveat as
// imageStorage.js: this is local disk, not a durable multi-instance object
// store — fine for a single instance, doesn't survive a redeploy, tracked as
// a known gap rather than faked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'private-uploads', 'organizer-documents');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const ALLOWED_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_BYTES = 10 * 1024 * 1024;

const DOCUMENT_TYPES = new Set(['identity', 'business_registration', 'other']);

function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime);
}

function isAllowedDocumentType(type) {
  return DOCUMENT_TYPES.has(type);
}

// Saves a buffer to a private, non-web-served directory and returns the
// internal storage path — never a URL, since nothing should be able to
// construct a link to this file without going through an authenticated
// download route.
function saveDocument(organizerId, buffer, mimeType) {
  if (!isAllowedMime(mimeType)) {
    throw Object.assign(new Error('Unsupported file type — use JPEG, PNG, WebP, or PDF'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('File is too large — max 10MB'), { status: 400 });
  }
  const ext = ALLOWED_MIME[mimeType];
  const filename = `${organizerId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const filePath = path.join(STORAGE_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return { storagePath: filePath };
}

// Reads a previously-saved document back into memory for an authenticated
// download route to stream out. Refuses to read outside STORAGE_DIR even if
// a stored path were ever malformed — storage_path is only ever written by
// saveDocument above, but this is a cheap, cost-free guard against a future
// bug turning into a path-traversal read.
function readDocument(storagePath) {
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith(STORAGE_DIR + path.sep)) {
    throw Object.assign(new Error('Invalid document path'), { status: 400 });
  }
  return fs.readFileSync(resolved);
}

function deleteDocument(storagePath) {
  if (!storagePath) return;
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith(STORAGE_DIR + path.sep)) return;
  fs.unlink(resolved, () => {});
}

module.exports = {
  isAllowedMime,
  isAllowedDocumentType,
  saveDocument,
  readDocument,
  deleteDocument,
  MAX_BYTES,
  DOCUMENT_TYPES,
};
