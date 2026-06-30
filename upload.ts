import path from 'path';
import fs from 'fs-extra';
import multer from 'multer';
import unzipper from 'unzipper';
import sharp from 'sharp';

import {
  CHAPTERS_DIR,
  TMP_DIR,
  UPLOADS_DIR,
  ChapterManifest,
  ensureBaseDirs,
  naturalCompare,
  slugify,
  isImageFile,
  isZipFile
} from './utils';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_SLICE_HEIGHT = Number(process.env.MAX_SLICE_HEIGHT || 1800);

export const uploadMiddleware = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024
  }
});

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(fullPath));
    } else {
      out.push(fullPath);
    }
  }

  return out;
}

async function extractZip(zipPath: string, destDir: string) {
  await fs.ensureDir(destDir);
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();
}

async function splitTallImage(imagePath: string, outDir: string): Promise<string[]> {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (!width || !height) return [imagePath];
  if (height <= MAX_SLICE_HEIGHT) return [imagePath];

  const stem = path.parse(imagePath).name;
  const ext = path.parse(imagePath).ext || '.png';
  const slices: string[] = [];

  let sliceIndex = 1;
  for (let top = 0; top < height; top += MAX_SLICE_HEIGHT) {
    const sliceHeight = Math.min(MAX_SLICE_HEIGHT, height - top);
    const outPath = path.join(outDir, `${stem}_${String(sliceIndex).padStart(2, '0')}${ext}`);

    await sharp(imagePath)
      .extract({
        left: 0,
        top,
        width,
        height: sliceHeight
      })
      .toFile(outPath);

    slices.push(outPath);
    sliceIndex += 1;
  }

  return slices;
}

export async function processChapterZip(zipPath: string, originalName: string, titleInput: string) {
  await ensureBaseDirs();

  if (!isZipFile(originalName)) {
    throw new Error('Only ZIP files are allowed');
  }

  const chapterTitle = titleInput.trim() || path.parse(originalName).name;
  const chapterId = slugify(chapterTitle);
  const chapterDir = path.join(CHAPTERS_DIR, chapterId);
  const extractedDir = path.join(chapterDir, 'extracted');
  const pagesDir = path.join(chapterDir, 'pages');
  const manifestPath = path.join(chapterDir, 'manifest.json');

  await fs.remove(chapterDir);
  await fs.ensureDir(extractedDir);
  await fs.ensureDir(pagesDir);

  await extractZip(zipPath, extractedDir);

  const files = (await walkFiles(extractedDir))
    .filter(isImageFile)
    .sort(naturalCompare);

  const finalImages: string[] = [];

  for (const imagePath of files) {
    const pieces = await splitTallImage(imagePath, pagesDir);

    for (const piece of pieces) {
      const finalName = path.basename(piece);
      const finalPath = path.join(pagesDir, finalName);

      if (piece !== finalPath) {
        await fs.copy(piece, finalPath, { overwrite: true });
      }

      finalImages.push(path.relative(chapterDir, finalPath));
    }
  }

  finalImages.sort(naturalCompare);

  const manifest: ChapterManifest = {
    id: chapterId,
    title: chapterTitle,
    sourceZipName: originalName,
    createdAt: new Date().toISOString(),
    images: finalImages
  };

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(extractedDir);

  return manifest;
}

export async function listChapters(): Promise<ChapterManifest[]> {
  await ensureBaseDirs();

  const dirs = await fs.readdir(CHAPTERS_DIR);
  const chapters: ChapterManifest[] = [];

  for (const dir of dirs) {
    const manifestPath = path.join(CHAPTERS_DIR, dir, 'manifest.json');
    if (await fs.pathExists(manifestPath)) {
      chapters.push(await fs.readJson(manifestPath));
    }
  }

  chapters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return chapters;
}

export async function getChapterManifest(chapterId: string): Promise<ChapterManifest | null> {
  const manifestPath = path.join(CHAPTERS_DIR, chapterId, 'manifest.json');
  if (!(await fs.pathExists(manifestPath))) return null;
  return fs.readJson(manifestPath);
}

export async function deleteChapter(chapterId: string) {
  await fs.remove(path.join(CHAPTERS_DIR, chapterId));
}

export function getChapterPagePath(chapterId: string, relativeImagePath: string) {
  return path.join(CHAPTERS_DIR, chapterId, relativeImagePath);
}

export function getChapterRoot(chapterId: string) {
  return path.join(CHAPTERS_DIR, chapterId);
}

export function getUploadsDir() {
  return UPLOADS_DIR;
}