import { AppState } from 'react-native';
import { File } from 'expo-file-system';
// The legacy API is the one that reports download progress
import { createDownloadResumable } from 'expo-file-system/legacy';
import { audioDir, ensureAudioDir, loadRemoved, saveManifest, songFile } from './storage';
import type { Manifest } from './types';

export type SyncFailure = { title: string; reason: string };
export type SyncResult = { manifest: Manifest; downloaded: number; removed: number; failed: SyncFailure[] };

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** Turns a download failure into a plain-English reason shown on the phone. */
async function explainFailure(err: any, base: string, wentToBackground: boolean): Promise<string> {
  const msg: string = err?.message ?? String(err);
  if (msg.startsWith('HTTP 404')) return 'File not found on the computer (it may have been deleted). Re-add it on the server.';
  if (msg.startsWith('HTTP 5')) return `Server error (${msg}). Check the server terminal for details.`;
  if (msg.startsWith('HTTP')) return `Server answered ${msg.replace('HTTP ', 'code ')}.`;
  if (msg.startsWith('Incomplete')) return msg;
  if (wentToBackground) return 'The app was closed or the screen locked during the download. Keep the app open while syncing.';
  // Is the computer still there?
  try {
    await fetchWithTimeout(`${base}/health`, 3000);
  } catch {
    return 'Lost connection to the computer (Wi-Fi dropped, or the computer went to sleep).';
  }
  return `Connection interrupted: ${msg}`;
}

export type SyncProgress = {
  index: number;     // which song (0-based) of the ones being downloaded
  total: number;     // how many songs need downloading
  title: string;
  fraction: number;  // 0..1 progress on the current song
};

/**
 * Accepts sloppy input like "192.168.4.20", "https//192.168.4.20", or "http://192.168.4.20:5000/"
 * and always returns "http://192.168.4.20:5000". The Flask server only speaks plain http.
 */
export function normalizeServerUrl(input: string) {
  let host = input.trim().replace(/^https?:?\/*/i, '').replace(/\/+$/, '');
  if (!/:\d+$/.test(host)) host += ':5000';
  return `http://${host}`;
}

async function fetchWithTimeout(url: string, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pull the server's manifest, download any songs the phone is missing,
 * and delete local files the server no longer has (phone mirrors the computer).
 */
export async function syncLibrary(
  serverUrl: string,
  onProgress: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const base = normalizeServerUrl(serverUrl);

  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/manifest`, 5000);
  } catch {
    throw new Error(`Can't reach ${base}. Check the computer is running server.py and you're on the same Wi-Fi.`);
  }
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const remote: Manifest = await res.json();

  ensureAudioDir();

  // Songs you removed from the phone stay removed until you tap "Download again"
  const removedIds = await loadRemoved();

  // Missing, or a half-finished download (size mismatch)
  const missing = remote.songs.filter((s) => {
    if (s.id in removedIds) return false;
    const f = songFile(s);
    return !f.exists || f.size !== s.size;
  });

  const failed: SyncFailure[] = [];

  // iOS pauses the app when it leaves the screen, which kills downloads. Watch for that.
  let wentToBackground = false;
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') wentToBackground = true;
  });

  for (let i = 0; i < missing.length; i++) {
    const song = missing[i];
    const target = songFile(song);
    onProgress({ index: i, total: missing.length, title: song.title, fraction: 0 });

    let lastPercent = 0;
    try {
      if (target.exists) target.delete();
      const dl = createDownloadResumable(
        `${base}/audio/${encodeURIComponent(song.file)}`,
        target.uri,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : song.size;
          const fraction = total ? totalBytesWritten / total : 0;
          const percent = Math.floor(fraction * 100);
          // Only update the UI once per percent so it doesn't re-render thousands of times
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress({ index: i, total: missing.length, title: song.title, fraction });
          }
        },
      );
      const result = await dl.downloadAsync();
      // iOS asks for the file as a byte range, so the server answers 206 (Partial Content)
      // instead of 200. Both are fine; what matters is that the whole file arrived.
      if (!result) throw new Error('Download was cancelled');
      if (result.status !== 200 && result.status !== 206) throw new Error(`HTTP ${result.status}`);
      const got = songFile(song).size ?? 0;
      if (got !== song.size) {
        throw new Error(`Incomplete download: got ${mb(got)} of ${mb(song.size)} MB before it stopped.`);
      }
    } catch (err) {
      failed.push({ title: song.title, reason: await explainFailure(err, base, wentToBackground) });
      if (target.exists) target.delete();
    }
    wentToBackground = false; // judge each song separately
  }
  sub.remove();

  // Remove files the server no longer lists
  const keep = new Set(remote.songs.map((s) => s.file));
  let removed = 0;
  for (const entry of audioDir.list()) {
    if (entry instanceof File && !keep.has(entry.name)) {
      entry.delete();
      removed++;
    }
  }

  // Only save songs that actually made it onto the phone
  const manifest: Manifest = {
    songs: remote.songs.filter((s) => songFile(s).exists),
    playlists: remote.playlists,
  };
  saveManifest(manifest);

  return { manifest, downloaded: missing.length - failed.length, removed, failed };
}