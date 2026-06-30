// ─── web.ts ───────────────────────────────────────────────────

import express, { Express } from 'express';
import path from 'path';
import fs from 'fs-extra';

import { uploadMiddleware, processChapterZip, listChapters, deleteChapter } from './upload';
import { escapeHtml, sanitizeChapterId } from './utils';
import { Client } from 'discord.js';
import { publishChapterById } from './reader';
import {
  logChapterUploaded,
  logChapterPublished,
  logChapterDeleted,
  logError,
} from './logger';

export function createWebApp(discordClient: Client): Express {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // ─── الصفحة الرئيسية ─────────────────────────────────────
  app.get('/', async (_req, res) => {
    const chapters = await listChapters();

    const rows = chapters.map((ch) => `
      <tr>
        <td>${escapeHtml(ch.title)}</td>
        <td><code>${escapeHtml(ch.id)}</code></td>
        <td>${ch.images.length}</td>
        <td>
          <form method="post" action="/publish/${encodeURIComponent(ch.id)}" style="display:inline">
            <button type="submit">نشر</button>
          </form>
          <form method="post" action="/delete/${encodeURIComponent(ch.id)}" style="display:inline;margin-left:8px">
            <button type="submit" style="background:#e03c3c">حذف</button>
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>Moonbook</title>
          <meta charset="utf-8"/>
          <style>
            body { font-family: system-ui, sans-serif; margin: 24px; background:#0f1115; color:#e8e8ea; }
            .card { max-width: 980px; background:#171a21; border:1px solid #2a2f3a; padding:20px; border-radius:16px; }
            input, button { font-size:16px; }
            input[type=text] { width:100%; padding:12px; margin:8px 0; border-radius:10px; border:1px solid #333; background:#10131a; color:white; }
            button { padding:10px 14px; border:0; border-radius:10px; cursor:pointer; background:#4a7dff; color:white; }
            table { width:100%; border-collapse:collapse; margin-top:18px; }
            th, td { border-bottom:1px solid #2a2f3a; padding:10px; text-align:left; }
            .muted { color:#a9afbd; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🌙 Moonbook</h1>
            <p class="muted">ارفع فصل ZIP، استخرجه، قسّم الصور الطويلة، وانشر في Discord.</p>

            <form method="post" action="/upload" enctype="multipart/form-data">
              <label>عنوان الفصل</label>
              <input type="text" name="title" placeholder="Solo Leveling - Chapter 1" />
              <label>ملف ZIP</label>
              <input type="file" name="chapterZip" accept=".zip" />
              <div style="margin-top:14px;">
                <button type="submit">رفع الفصل</button>
              </div>
            </form>

            <h2 style="margin-top:22px;">الفصول</h2>
            <table>
              <thead>
                <tr><th>العنوان</th><th>ID</th><th>الصفحات</th><th>إجراءات</th></tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="4" class="muted">لا يوجد فصول بعد</td></tr>'}
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `);
  });

  // ─── رفع فصل ─────────────────────────────────────────────
  app.post('/upload', uploadMiddleware.single('chapterZip'), async (req, res) => {
    try {
      const title = String(req.body.title || '').trim();
      const file = req.file;

      if (!file) return res.status(400).send('لم يتم رفع ملف ZIP');

      const tempZip = file.path;
      const finalZip = path.join(process.cwd(), 'uploads', `${Date.now()}-${file.originalname}`);
      await fs.ensureDir(path.dirname(finalZip));
      await fs.move(tempZip, finalZip, { overwrite: true });

      const manifest = await processChapterZip(finalZip, file.originalname, title);
      await fs.remove(finalZip);

      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      await logChapterUploaded({
        title: manifest.title,
        pages: manifest.images.length,
        fileName: file.originalname,
        sizeMb,
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /upload', message: error.message, stack: error.stack });
      res.status(500).send(`فشل الرفع: ${escapeHtml(error.message)}`);
    }
  });

  // ─── نشر فصل ─────────────────────────────────────────────
  app.post('/publish/:chapterId', async (req, res) => {
    // ✅ Path Traversal Fix
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).send('معرّف الفصل غير صالح');

    try {
      await publishChapterById(discordClient, chapterId, 'Web Panel');

      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);
      await logChapterPublished({
        title: chapter?.title ?? chapterId,
        pages: chapter?.images.length ?? 0,
        publishedBy: 'Web Panel',
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /publish', message: error.message, stack: error.stack });
      res.status(500).send(`فشل النشر: ${escapeHtml(error.message)}`);
    }
  });

  // ─── حذف فصل ─────────────────────────────────────────────
  app.post('/delete/:chapterId', async (req, res) => {
    // ✅ Path Traversal Fix
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).send('معرّف الفصل غير صالح');

    try {
      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);

      await deleteChapter(chapterId);
      await logChapterDeleted({
        title: chapter?.title ?? chapterId,
        deletedBy: 'Web Panel',
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /delete', message: error.message, stack: error.stack });
      res.status(500).send(`فشل الحذف: ${escapeHtml(error.message)}`);
    }
  });

  // ─── Manifest API ─────────────────────────────────────────
  app.get('/chapter/:chapterId/manifest', async (req, res) => {
    // ✅ Path Traversal Fix
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).json({ error: 'معرّف غير صالح' });

    const manifestPath = path.join(process.cwd(), 'chapters', chapterId, 'manifest.json');
    if (!(await fs.pathExists(manifestPath))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(await fs.readJson(manifestPath));
  });

  return app;
}
