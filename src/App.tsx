import { useState, useCallback, useRef } from "react";
import {
  Box,
  Container,
  Typography,
  Paper,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  LinearProgress,
  Alert,
  Stack,
  Fade,
  Chip,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DownloadIcon from "@mui/icons-material/Download";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import DeleteIcon from "@mui/icons-material/Delete";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";

type Status = "idle" | "uploading" | "converting" | "done" | "error";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [outputFormat, setOutputFormat] = useState("pdf");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const [conversionTime, setConversionTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setFile(null);
    setStatus("idle");
    setProgress(0);
    setError("");
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setDownloadName("");
    setConversionTime(0);
  }, [downloadUrl]);

  const handleFile = useCallback(
    (f: File) => {
      if (!f.name.toLowerCase().endsWith(".dwfx")) {
        setError("Please select a .dwfx file");
        return;
      }
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
      setFile(f);
      setStatus("idle");
      setError("");
    },
    [downloadUrl],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const handleConvert = useCallback(async () => {
    if (!file) return;

    setStatus("uploading");
    setProgress(10);
    setError("");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("format", outputFormat);

    try {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setProgress(Math.round((e.loaded / e.total) * 40) + 10);
        }
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        xhr.open("POST", "/api/convert");
        xhr.responseType = "blob";

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const time = xhr.getResponseHeader("X-Conversion-Time-Ms");
            if (time) setConversionTime(parseInt(time, 10));
            resolve(xhr.response as Blob);
          } else {
            xhr.response.text().then((text: string) => {
              try {
                reject(new Error(JSON.parse(text).error));
              } catch {
                reject(new Error("Conversion failed"));
              }
            });
          }
        };

        xhr.onerror = () => reject(new Error("Network error"));

        xhr.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setStatus("converting");
            setProgress(50 + Math.round((e.loaded / e.total) * 50));
          }
        });

        setStatus("converting");
        setProgress(50);
        xhr.send(formData);
      });

      const url = URL.createObjectURL(blob);
      const name = file.name.replace(/\.dwfx$/i, `.${outputFormat}`);
      setDownloadUrl(url);
      setDownloadName(name);
      setStatus("done");
      setProgress(100);
    } catch (err: any) {
      setError(err.message || "Conversion failed");
      setStatus("error");
    }
  }, [file, outputFormat]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(ellipse at 50% 0%, #1a1d3a 0%, #0B0D17 70%)",
        py: 4,
      }}
    >
      <Container maxWidth="sm">
        <Stack spacing={4} alignItems="center">
          <Stack spacing={0} alignItems="center">
            <Box
              component="img"
              src="/logo.png"
              alt="ConvertFlow"
              sx={{ width: 160, height: 160, objectFit: "contain" }}
            />
          </Stack>

          <Paper
            elevation={0}
            sx={{
              width: "100%",
              p: 4,
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Stack spacing={3}>
              {/* Drop zone */}
              <Box
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                sx={{
                  border: "2px dashed",
                  borderColor: isDragging
                    ? "primary.main"
                    : file
                      ? "success.main"
                      : "divider",
                  borderRadius: 2,
                  p: 4,
                  textAlign: "center",
                  cursor: "pointer",
                  transition: "all 0.2s",
                  bgcolor: isDragging ? "rgba(108,99,255,0.08)" : "transparent",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "rgba(108,99,255,0.04)",
                  },
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".dwfx"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    e.target.value = "";
                  }}
                />
                {file ? (
                  <Stack spacing={1} alignItems="center">
                    <InsertDriveFileIcon
                      sx={{ fontSize: 40, color: "success.main" }}
                    />
                    <Typography fontWeight={500}>{file.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatSize(file.size)}
                    </Typography>
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteIcon />}
                      onClick={(e) => {
                        e.stopPropagation();
                        reset();
                      }}
                    >
                      Remove
                    </Button>
                  </Stack>
                ) : (
                  <Stack spacing={1} alignItems="center">
                    <CloudUploadIcon
                      sx={{ fontSize: 40, color: "text.secondary" }}
                    />
                    <Typography color="text.secondary">
                      Drag & drop a <strong>.dwfx</strong> file here
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      or click to browse
                    </Typography>
                  </Stack>
                )}
              </Box>

              {/* Output format */}
              <FormControl fullWidth size="small">
                <InputLabel>Output Format</InputLabel>
                <Select
                  value={outputFormat}
                  label="Output Format"
                  onChange={(e) => setOutputFormat(e.target.value)}
                >
                  <MenuItem value="pdf">PDF</MenuItem>
                </Select>
              </FormControl>

              {/* Progress bar */}
              {(status === "uploading" || status === "converting") && (
                <Fade in>
                  <Stack spacing={1}>
                    <LinearProgress
                      variant="determinate"
                      value={progress}
                      sx={{ height: 6, borderRadius: 3 }}
                    />
                    <Typography variant="caption" color="text.secondary" textAlign="center">
                      {status === "uploading"
                        ? "Uploading file..."
                        : "Converting..."}
                    </Typography>
                  </Stack>
                </Fade>
              )}

              {/* Error */}
              {error && (
                <Alert severity="error" onClose={() => setError("")}>
                  {error}
                </Alert>
              )}

              {/* Convert button */}
              <Button
                variant="contained"
                size="large"
                fullWidth
                disabled={!file || status === "uploading" || status === "converting"}
                onClick={handleConvert}
                startIcon={<RocketLaunchIcon />}
                sx={{ py: 1.5 }}
              >
                {status === "uploading" || status === "converting"
                  ? "Converting..."
                  : "Convert"}
              </Button>

              {/* Download result */}
              {status === "done" && downloadUrl && (
                <Fade in>
                  <Stack spacing={2} alignItems="center">
                    <Alert
                      severity="success"
                      sx={{ width: "100%" }}
                      action={
                        <Chip
                          label={`${conversionTime}ms`}
                          size="small"
                          color="success"
                          variant="outlined"
                        />
                      }
                    >
                      Conversion complete!
                    </Alert>
                    <Button
                      variant="outlined"
                      size="large"
                      fullWidth
                      href={downloadUrl}
                      download={downloadName}
                      startIcon={<DownloadIcon />}
                      sx={{ py: 1.5 }}
                    >
                      Download {downloadName}
                    </Button>
                  </Stack>
                </Fade>
              )}
            </Stack>
          </Paper>

          <Typography variant="caption" color="text.secondary">
            Files are processed on the server and deleted immediately after conversion
          </Typography>
        </Stack>
      </Container>
    </Box>
  );
}
