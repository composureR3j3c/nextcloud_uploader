require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const {
  uploadToUser,
  uploadToMyDrive,
} = require('./nextcloud.controller');

const app = express();

const PORT = process.env.PORT || 3000;

const MAX_FILE_SIZE_MB =
  Number(process.env.MAX_FILE_SIZE_MB || 10);

const MAX_FILE_SIZE =
  MAX_FILE_SIZE_MB * 1024 * 1024;

const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);

const RATE_LIMIT_MAX =
  Number(process.env.RATE_LIMIT_MAX || 100);

const UPLOAD_RATE_LIMIT_WINDOW_MS =
  Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);

const UPLOAD_RATE_LIMIT_MAX =
  Number(process.env.UPLOAD_RATE_LIMIT_MAX || 20);

// ----------------------------------------
// Middleware
// ----------------------------------------

app.use(helmet());

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({
  extended: true,
}));

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
});

const uploadLimiter = rateLimit({
  windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
  max: UPLOAD_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many upload requests, please try again later',
  },
});

app.use(apiLimiter);

// ----------------------------------------
// API authentication
// ----------------------------------------

function authenticateApiKey(req, res, next) {
  const expectedKey = process.env.API_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      success: false,
      message: 'API_KEY is not configured',
    });
  }

  const providedKey =
    req.headers['x-api-key'];

  if (!providedKey) {
    return res.status(401).json({
      success: false,
      message: 'Missing API key',
    });
  }

  const providedBuffer =
    Buffer.from(providedKey);

  const expectedBuffer =
    Buffer.from(expectedKey);

  if (
    providedBuffer.length !==
    expectedBuffer.length
  ) {
    return res.status(401).json({
      success: false,
      message: 'Invalid API key',
    });
  }

  if (
    !crypto.timingSafeEqual(
      providedBuffer,
      expectedBuffer
    )
  ) {
    return res.status(401).json({
      success: false,
      message: 'Invalid API key',
    });
  }

  next();
}

// ----------------------------------------
// Nextcloud Basic Auth pass-through
// ----------------------------------------

function requireNextcloudBasicAuth(req, res, next) {
  const header =
    req.headers.authorization || '';

  const [scheme, encoded] =
    header.split(' ');

  if (scheme !== 'Basic' || !encoded) {
    return res.status(401).json({
      success: false,
      message:
        'Basic auth (Nextcloud username/password) is required',
    });
  }

  let decoded;

  try {
    decoded =
      Buffer.from(encoded, 'base64').toString('utf8');
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: 'Malformed Authorization header',
    });
  }

  const separatorIndex =
    decoded.indexOf(':');

  if (separatorIndex === -1) {
    return res.status(400).json({
      success: false,
      message: 'Malformed Authorization header',
    });
  }

  const username =
    decoded.slice(0, separatorIndex);

  const password =
    decoded.slice(separatorIndex + 1);

  if (!username || !password) {
    return res.status(401).json({
      success: false,
      message:
        'Basic auth username and password are required',
    });
  }

  req.nextcloudAuth = {
    username,
    password,
  };

  next();
}

// ----------------------------------------
// Multer
// ----------------------------------------

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',

  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'text/plain',
  'text/csv',
]);

const ALLOWED_EXTENSIONS = new Set([
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif',

  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.txt', '.csv',
]);

class InvalidFileTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFileTypeError';
    this.code = 'INVALID_FILE_TYPE';
  }
}

// Extensions with no reliable magic-byte signature (plain text) —
// skipped during content sniffing.
const NO_SIGNATURE_EXTENSIONS = new Set(['.txt', '.csv']);

// Magic-byte signatures for the file types we accept. Content is checked
// against this list, independent of the client-supplied mimetype/extension,
// since those are trivially spoofable.
const MAGIC_SIGNATURES = [
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a / GIF89a
  { bytes: [0x42, 0x4d] }, // BMP
  { bytes: [0x49, 0x49, 0x2a, 0x00] }, // TIFF (little-endian)
  { bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // TIFF (big-endian)
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // PDF
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // legacy Office (doc/xls/ppt)
  { bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP-based (docx/xlsx/pptx/odt/ods/odp)
  { bytes: [0x50, 0x4b, 0x05, 0x06] }, // ZIP-based (empty archive)
  {
    // RIFF....WEBP
    test: (buffer) =>
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    // ISOBMFF ftyp box used by HEIC/HEIF: bytes 4-7 are "ftyp"
    test: (buffer) =>
      buffer.length >= 12 &&
      buffer.toString('ascii', 4, 8) === 'ftyp',
  },
];

function matchesKnownSignature(buffer) {
  return MAGIC_SIGNATURES.some(({ bytes, test }) => {
    if (test) {
      return test(buffer);
    }

    if (buffer.length < bytes.length) {
      return false;
    }

    return bytes.every((byte, index) => buffer[index] === byte);
  });
}

function verifyFileContent(req, res, next) {
  const file = req.file;

  if (!file) {
    return next();
  }

  const extension =
    path.extname(file.originalname || '').toLowerCase();

  if (NO_SIGNATURE_EXTENSIONS.has(extension)) {
    return next();
  }

  fs.open(file.path, 'r', (openError, fd) => {
    if (openError) {
      return next(openError);
    }

    const buffer = Buffer.alloc(16);

    fs.read(fd, buffer, 0, buffer.length, 0, (readError, bytesRead) => {
      fs.close(fd, () => {});

      if (readError) {
        return next(readError);
      }

      if (!matchesKnownSignature(buffer.subarray(0, bytesRead))) {
        return fs.unlink(file.path, () => {
          next(
            new InvalidFileTypeError(
              'File content does not match an allowed document or picture type'
            )
          );
        });
      }

      next();
    });
  });
}

const upload = multer({
  dest: path.join(__dirname, '../uploads'),

  limits: {
    fileSize: MAX_FILE_SIZE,
  },

  fileFilter: (req, file, callback) => {
    const extension =
      path.extname(file.originalname || '').toLowerCase();

    const mimeOk =
      ALLOWED_MIME_TYPES.has(file.mimetype);

    const extensionOk =
      ALLOWED_EXTENSIONS.has(extension);

    if (!mimeOk || !extensionOk) {
      return callback(
        new InvalidFileTypeError(
          'Only document and picture files are allowed'
        )
      );
    }

    callback(null, true);
  },
});

// ----------------------------------------
// Health check
// ----------------------------------------

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'nextcloud-upload-api',
    nextcloud: process.env.NEXTCLOUD_URL,
  });
});

// ----------------------------------------
// Upload endpoint
// ----------------------------------------

app.post(
  '/api/nextcloud/upload',
  uploadLimiter,
  authenticateApiKey,
  upload.single('file'),
  verifyFileContent,
  uploadToUser
);

app.post(
  '/api/nextcloud/upload-to-drive',
  uploadLimiter,
  authenticateApiKey,
  requireNextcloudBasicAuth,
  upload.single('file'),
  verifyFileContent,
  uploadToMyDrive
);

// ----------------------------------------
// Multer errors
// ----------------------------------------

app.use((error, req, res, next) => {
  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  if (error instanceof multer.MulterError) {

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message:
          `File too large. Maximum size is ${MAX_FILE_SIZE_MB} MB`,
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  console.error(error);

  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

// ----------------------------------------
// Start
// ----------------------------------------

app.listen(PORT, () => {
  console.log(
    `Nextcloud API running on port ${PORT}`
  );
});