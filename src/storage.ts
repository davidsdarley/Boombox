import { Directory, File, Paths } from 'expo-file-system';
import type { Manifest, Song } from './types';

export const audioDir = new Directory(Paths.document, 'audio');
const manifestFile = new File(Paths.document, 'manifest.json');
const settingsFile = new File(Paths.document, 'settings.json');

export const EMPTY: Manifest = { songs: [], playlists: {} };

export function ensureAudioDir() {
  if (!audioDir.exists) audioDir.create();
}

export function songFile(song: Song) {
  return new File(audioDir, song.file);
}

function writeJson(file: File, data: unknown) {
  if (!file.exists) file.create();
  file.write(JSON.stringify(data));
}

async function readJson<T>(file: File, fallback: T): Promise<T> {
  if (!file.exists) return fallback;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return fallback;
  }
}

export const loadManifest = () => readJson<Manifest>(manifestFile, EMPTY);
export const saveManifest = (m: Manifest) => writeJson(manifestFile, m);

export async function loadServerUrl() {
  const s = await readJson<{ serverUrl?: string }>(settingsFile, {});
  return s.serverUrl ?? 'http://192.168.1.100:5000';
}
export const saveServerUrl = (serverUrl: string) => writeJson(settingsFile, { serverUrl });

// Saved listening positions for long tracks (song id -> seconds)
const positionsFile = new File(Paths.document, 'positions.json');
export const loadPositions = () => readJson<Record<string, number>>(positionsFile, {});
export const savePositions = (p: Record<string, number>) => writeJson(positionsFile, p);

// Songs you removed from the phone (id -> title). Sync skips these so it doesn't re-download them.
const removedFile = new File(Paths.document, 'removed.json');
export const loadRemoved = () => readJson<Record<string, string>>(removedFile, {});
export const saveRemoved = (r: Record<string, string>) => writeJson(removedFile, r);

/** Delete a song's audio from the phone only. It stays on the computer. */
export function deleteFromPhone(song: Song) {
  const f = songFile(song);
  if (f.exists) f.delete();
}

export function bytesOnPhone(songs: Song[]) {
  return songs.reduce((sum, s) => sum + (songFile(s).exists ? s.size : 0), 0);
}