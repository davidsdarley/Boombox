import { useEffect, useRef, useState } from 'react';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { loadPositions, savePositions, songFile } from './storage';
import type { Song } from './types';

// Only remember where you left off for tracks at least this long (lectures, not songs)
const RESUME_MIN_SECONDS = 10 * 60;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

function shuffled<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isLong = (song: Song | null) => (song?.duration ?? 0) >= RESUME_MIN_SECONDS;

export async function configureAudio() {
  await setAudioModeAsync({
    playsInSilentMode: true,      // iPhone mute switch doesn't silence it
    shouldPlayInBackground: true, // keep playing when screen locks / app is backgrounded
    interruptionMode: 'doNotMix',
  });
}

/** Queue logic that used to live on the Flask server. */
export function usePlayer() {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [queue, setQueue] = useState<Song[]>([]);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const pendingSeek = useRef<number | null>(null);
  const current = queue[index] ?? null;

  useEffect(() => {
    loadPositions().then(setPositions);
  }, []);

  // Save (or clear, with null) the listening position for a long track
  function remember(song: Song | null, sec: number | null) {
    if (!song || !isLong(song)) return;
    setPositions((prev) => {
      const next = { ...prev };
      // Treat "within 15s of the end" as finished
      if (sec === null || sec < 5 || sec > (song.duration ?? 0) - 15) delete next[song.id];
      else next[song.id] = Math.floor(sec);
      savePositions(next);
      return next;
    });
  }

  // Drop a song's saved listening spot (used when it's deleted from the phone)
  function forget(id: string) {
    setPositions((prev) => {
      const next = { ...prev };
      delete next[id];
      savePositions(next);
      return next;
    });
  }

  function load(q: Song[], i: number) {
    const song = q[i];
    if (!song) return;
    remember(current, status.currentTime); // save where we were before switching
    setQueue(q);
    setIndex(i);
    pendingSeek.current = isLong(song) ? positions[song.id] ?? null : null;
    player.replace({ uri: songFile(song).uri });
    player.play();
    player.setPlaybackRate(speed);
    player.setActiveForLockScreen(true, { title: song.title });
  }

  // Once the new file is loaded, jump to the saved spot and re-apply speed
  useEffect(() => {
    if (!status.isLoaded) return;
    player.setPlaybackRate(speed);
    if (pendingSeek.current !== null) {
      player.seekTo(pendingSeek.current);
      pendingSeek.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.isLoaded, status.duration]);

  // Save position every 5 seconds while playing, and whenever you pause
  const tick = Math.floor(status.currentTime / 5);
  useEffect(() => {
    if (status.playing) remember(current, status.currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  useEffect(() => {
    if (!status.playing) remember(current, status.currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.playing]);

  const playList = (songs: Song[], start = 0, shuffle = false) => {
    if (!songs.length) return;
    if (shuffle) load(shuffled(songs), 0);
    else load(songs, start);
  };

  // Loops back to the start at the end, like the old server did
  const next = () => load(queue, (index + 1) % queue.length);

  // Restart the song if we're more than 3s in, otherwise go to the previous one
  const previous = () => {
    if (status.currentTime > 3 || index === 0) player.seekTo(0);
    else load(queue, index - 1);
  };

  const togglePlay = () => (status.playing ? player.pause() : player.play());

  // Shuffle only the songs that haven't played yet
  const shuffleUpcoming = () => {
    setQueue([...queue.slice(0, index + 1), ...shuffled(queue.slice(index + 1))]);
  };

  // Jump to an exact spot (seconds), clamped to the song length
  const seekTo = (sec: number) => {
    const max = status.duration || 0;
    player.seekTo(Math.max(0, Math.min(sec, max)));
  };

  // Skip forward/back by a number of seconds (negative = rewind)
  const seekBy = (delta: number) => seekTo(status.currentTime + delta);

  // 1× → 1.25× → 1.5× → 1.75× → 2× → back to 1×
  const cycleSpeed = () => {
    const nextSpeed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(nextSpeed);
    player.setPlaybackRate(nextSpeed);
  };

  // Auto-advance when a song ends (and forget its saved position)
  useEffect(() => {
    if (status.didJustFinish && queue.length) {
      remember(current, null);
      next();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  return {
    current,
    queue,
    index,
    playing: status.playing,
    position: status.currentTime,
    duration: status.duration,
    speed,
    positions,
    forget,
    playList,
    next,
    previous,
    togglePlay,
    shuffleUpcoming,
    seekTo,
    seekBy,
    cycleSpeed,
  };
}