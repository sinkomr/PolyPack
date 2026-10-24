// The build writes polypack-volunteer.json next to the file (apps/volunteer/build.ts): its version,
// size and SHA-256, shown under the download link. Without it the link stands alone.
interface FileInfo {
  version: string;
  bytes: number;
  sha256: string;
}

async function showFileInfo(): Promise<void> {
  let info: FileInfo;
  try {
    const r = await fetch("/downloads/polypack-volunteer.json");
    if (!r.ok) return;
    info = (await r.json()) as FileInfo;
  } catch {
    return;
  }
  if (typeof info.version !== "string" || typeof info.bytes !== "number" || typeof info.sha256 !== "string") return;
  const p = document.getElementById("file-info")!;
  p.textContent = `Version ${info.version}, ${Math.round(info.bytes / 1024)} kB. SHA-256: ${info.sha256}`;
  p.hidden = false;
}

void showFileInfo();
