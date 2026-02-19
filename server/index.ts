import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { convertDwfxToPdf } from "./converter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback,
  ) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".dwfx") {
      cb(new Error("Only .dwfx files are supported"));
      return;
    }
    cb(null, true);
  },
});

app.post(
  "/api/convert",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const inputPath = req.file.path;
    const originalName = path.parse(req.file.originalname).name;
    const outputPath = inputPath + ".pdf";

    try {
      const start = Date.now();
      await convertDwfxToPdf(inputPath, outputPath);
      const elapsed = Date.now() - start;

      console.log(`Converted ${req.file.originalname} in ${elapsed}ms`);

      const stat = fs.statSync(outputPath);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${originalName}.pdf"`,
      );
      res.setHeader("Content-Length", stat.size);
      res.setHeader("X-Conversion-Time-Ms", elapsed.toString());

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("end", () => cleanup(inputPath, outputPath));
      stream.on("error", () => cleanup(inputPath, outputPath));
    } catch (err: unknown) {
      cleanup(inputPath, outputPath);
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Conversion error:", message);
      res.status(500).json({ error: "Conversion failed: " + message });
    }
  },
);

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

const clientDist = path.join(__dirname, "..", "dist", "client");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
