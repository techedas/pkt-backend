import multer from 'multer';
import { AppError } from '../utils/errors';

/** In-memory upload for CSV/XLSX bulk imports (max 5 MB). */
export const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx')) return cb(null, true);
    cb(AppError.badRequest('Only .csv and .xlsx files are supported.', 'INVALID_FILE_TYPE'));
  },
}).single('file');
