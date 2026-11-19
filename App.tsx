import { useEffect, useMemo, useState } from 'react';
import {
  Alert, FlatList, Platform, Pressable, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  EMPTY, bytesOnPhone, deleteFromPhone, loadManifest, loadRemoved, loadServerUrl,
  saveManifest, saveRemoved, saveServerUrl,
} from './src/storage';
import { syncLibrary, type SyncFailure, type SyncProgress } from './src/sync';
import { configureAudio, usePlayer } from './src/usePlayer';
import type { Manifest, Song } from './src/types';

const C = {
  night: '#1B2238',
  surface: '#252E48',
  line: '#343F5E',
  parchment: '#E8E2D0',
  muted: '#8A93A8',
  brass: '#C9A227',
};

const ALL = 'All songs';

function fmt(sec: number) {
  if (!sec || !isFinite(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest>(EMPTY);
  const [serverUrl, setServerUrl] = useState('');
  const [showSync, setShowSync] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [failures, setFailures] = useState<SyncFailure[]>([]);
  const [removed, setRemoved] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [playlist, setPlaylist] = useState(ALL);
  const p = usePlayer();

  // Scrubber: while dragging, show the drag position instead of the live one
  const [barWidth, setBarWidth] = useState(1);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const posFromX = (x: number) => Math.max(0, Math.min(1, x / barWidth)) * (p.duration || 0);
  const shownPos = dragPos ?? p.position;
  const shownFraction = p.duration ? Math.min(1, shownPos / p.duration) : 0;

  useEffect(() => {
    configureAudio();
    loadManifest().then(setManifest);
    loadServerUrl().then(setServerUrl);
    loadRemoved().then(setRemoved);
  }, []);

  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`;

  // Long-press a song to remove it from the phone (it stays on the computer)
  function confirmDelete(song: Song) {
    if (p.current?.id === song.id) {
      Alert.alert('Currently playing', 'Play a different song first, then remove this one.');
      return;
    }
    Alert.alert(
      'Remove from phone?',
      `"${song.title}" (${mb(song.size)}) will be deleted from this phone to free up space. It stays on your computer, and you can download it again from the Sync panel.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            deleteFromPhone(song);
            p.forget(song.id);
            const nextRemoved = { ...removed, [song.id]: song.title };
            setRemoved(nextRemoved);
            saveRemoved(nextRemoved);
            const nextManifest = { ...manifest, songs: manifest.songs.filter((s) => s.id !== song.id) };
            setManifest(nextManifest);
            saveManifest(nextManifest);
          },
        },
      ],
    );
  }

  // Un-skip a removed song so the next sync downloads it again
  function restore(id: string) {
    const next = { ...removed };
    delete next[id];
    setRemoved(next);
    saveRemoved(next);
    setSyncMsg('It will download next time you tap Sync library.');
  }

  const byId = useMemo(() => new Map(manifest.songs.map((s) => [s.id, s])), [manifest]);

  const songs: Song[] = useMemo(() => {
    if (playlist === ALL) return manifest.songs;
    return (manifest.playlists[playlist] ?? []).map((id) => byId.get(id)).filter(Boolean) as Song[];
  }, [playlist, manifest, byId]);

  async function runSync() {
    setSyncing(true);
    saveServerUrl(serverUrl);
    setFailures([]);
    try {
      setSyncMsg('Checking library…');
      const r = await syncLibrary(serverUrl, (prog) => {
        setProgress(prog);
        setSyncMsg('');
      });
      setManifest(r.manifest);
      setFailures(r.failed);
      setSyncMsg(
        `Synced. ${r.downloaded} downloaded, ${r.removed} removed` +
          (r.failed.length ? `, ${r.failed.length} failed. Tap Sync library again to retry them.` : '.'),
      );
    } catch (e: any) {
      setSyncMsg(e.message ?? 'Sync failed.');
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }

  const playlistNames = [ALL, ...Object.keys(manifest.playlists)];

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <Text style={s.appName}>Boombox</Text>
        <Pressable onPress={() => setShowSync(!showSync)} hitSlop={10}>
          <Text style={s.link}>{showSync ? 'Done' : 'Sync'}</Text>
        </Pressable>
      </View>

      {showSync && (
        <View style={s.syncPanel}>
          <Text style={s.hint}>Computer address (same Wi-Fi as this phone)</Text>
          <TextInput
            style={s.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.100:5000"
            placeholderTextColor={C.muted}
          />
          <Text style={s.hint}>
            Using {mb(bytesOnPhone(manifest.songs))} on this phone. Long-press a song to remove it.
          </Text>
          <Pressable style={[s.button, syncing && { opacity: 0.5 }]} onPress={runSync} disabled={syncing}>
            <Text style={s.buttonText}>{syncing ? 'Syncing…' : 'Sync library'}</Text>
          </Pressable>
          {progress && (
            <View style={{ gap: 6 }}>
              <Text style={s.hint} numberOfLines={1}>
                Song {progress.index + 1} of {progress.total}: {progress.title}
              </Text>
              <View style={s.track}>
                <View style={[s.trackFill, { width: `${progress.fraction * 100}%` }]} />
              </View>
              <Text style={s.hint}>{Math.floor(progress.fraction * 100)}%</Text>
            </View>
          )}
          {!!syncMsg && <Text style={s.hint}>{syncMsg}</Text>}
          {Object.keys(removed).length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={s.sectionLabel}>Removed from phone</Text>
              {Object.entries(removed).map(([id, title]) => (
                <View key={id} style={s.removedRow}>
                  <Text style={s.removedTitle} numberOfLines={1}>{title}</Text>
                  <Pressable onPress={() => restore(id)} hitSlop={8}>
                    <Text style={s.link}>Download again</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          {failures.map((f) => (
            <View key={f.title} style={s.failure}>
              <Text style={s.failureTitle} numberOfLines={1}>{f.title}</Text>
              <Text style={s.hint}>{f.reason}</Text>
            </View>
          ))}
        </View>
      )}

      <FlatList
        horizontal
        data={playlistNames}
        keyExtractor={(n) => n}
        showsHorizontalScrollIndicator={false}
        style={s.tabs}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 18 }}
        renderItem={({ item }) => (
          <Pressable onPress={() => setPlaylist(item)}>
            <Text style={[s.tab, item === playlist && s.tabActive]}>{item}</Text>
          </Pressable>
        )}
      />

      <FlatList
        data={songs}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: 200 }}
        ListHeaderComponent={
          songs.length ? (
            <Pressable style={s.shuffleAll} onPress={() => p.playList(songs, 0, true)}>
              <Text style={s.link}>Shuffle {playlist === ALL ? 'everything' : playlist}</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          <Text style={s.empty}>
            {manifest.songs.length
              ? 'This playlist has no downloaded songs.'
              : 'No songs on this phone yet. Tap Sync while you’re on the same Wi-Fi as your computer.'}
          </Text>
        }
        renderItem={({ item, index }) => {
          const isCurrent = p.current?.id === item.id;
          const saved = p.positions[item.id];
          return (
            <Pressable
              style={s.row}
              onPress={() => p.playList(songs, index)}
              onLongPress={() => confirmDelete(item)}
              delayLongPress={400}
            >
              <Text style={[s.songTitle, isCurrent && { color: C.brass }]} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[s.duration, saved && !isCurrent ? { color: C.brass } : null]}>
                {saved && !isCurrent ? `${fmt(saved)} of ` : ''}{fmt(item.duration ?? 0)}
              </Text>
            </Pressable>
          );
        }}
      />

      {p.current && (
        <View style={s.nowPlaying}>
          <Text style={s.npTitle} numberOfLines={2}>{p.current.title}</Text>
          {/* Tap or drag anywhere on the bar to jump; the song only seeks when you let go */}
          <View
            style={s.scrubArea}
            onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={(e) => setDragPos(posFromX(e.nativeEvent.locationX))}
            onResponderMove={(e) => setDragPos(posFromX(e.nativeEvent.locationX))}
            onResponderRelease={(e) => {
              p.seekTo(posFromX(e.nativeEvent.locationX));
              setDragPos(null);
            }}
          >
            <View style={s.track} pointerEvents="none">
              <View style={[s.trackFill, { width: `${shownFraction * 100}%` }]} />
              <View style={[s.thumb, { left: `${shownFraction * 100}%` }, dragPos !== null && s.thumbActive]} />
            </View>
          </View>
          <View style={s.timeRow}>
            <Text style={s.duration}>{fmt(shownPos)}</Text>
            <Text style={s.duration}>{p.index + 1} of {p.queue.length}</Text>
            <Text style={s.duration}>{fmt(p.duration)}</Text>
          </View>
          <View style={s.controls}>
            <Pressable onPress={() => p.seekBy(-15)} hitSlop={10}><Text style={s.ctrlSmall}>−15s</Text></Pressable>
            <Pressable onPress={p.previous} hitSlop={10}><Text style={s.ctrl}>⏮</Text></Pressable>
            <Pressable onPress={p.togglePlay} style={s.playBtn}>
              <Text style={s.playIcon}>{p.playing ? '❚❚' : '▶'}</Text>
            </Pressable>
            <Pressable onPress={p.next} hitSlop={10}><Text style={s.ctrl}>⏭</Text></Pressable>
            <Pressable onPress={() => p.seekBy(15)} hitSlop={10}><Text style={[s.ctrlSmall, { textAlign: 'right' }]}>+15s</Text></Pressable>
          </View>
          <View style={s.extrasRow}>
            <Pressable onPress={p.shuffleUpcoming} hitSlop={10}>
              <Text style={s.hint}>Shuffle rest of queue</Text>
            </Pressable>
            <Pressable onPress={p.cycleSpeed} hitSlop={10} style={s.speedBtn}>
              <Text style={[s.speedText, p.speed !== 1 && { color: C.brass }]}>{p.speed}×</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.night, paddingTop: Platform.OS === 'ios' ? 60 : 36 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 16, marginBottom: 12 },
  appName: { color: C.parchment, fontSize: 30, fontWeight: '700', letterSpacing: -0.5 },
  link: { color: C.brass, fontSize: 16, fontWeight: '600' },
  syncPanel: { marginHorizontal: 16, marginBottom: 12, padding: 14, backgroundColor: C.surface, borderRadius: 10, gap: 10 },
  hint: { color: C.muted, fontSize: 13 },
  sectionLabel: { color: C.parchment, fontSize: 13, fontWeight: '700', marginTop: 4 },
  removedRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  removedTitle: { flex: 1, color: C.muted, fontSize: 14 },
  failure: { borderLeftWidth: 2, borderLeftColor: '#C0564B', paddingLeft: 10, gap: 2 },
  failureTitle: { color: C.parchment, fontSize: 14, fontWeight: '600' },
  input: { color: C.parchment, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 10, fontSize: 15 },
  button: { backgroundColor: C.brass, borderRadius: 6, padding: 12, alignItems: 'center' },
  buttonText: { color: C.night, fontWeight: '700', fontSize: 15 },
  tabs: { flexGrow: 0, marginBottom: 8 },
  tab: { color: C.muted, fontSize: 16, paddingVertical: 6 },
  tabActive: { color: C.parchment, fontWeight: '700', borderBottomWidth: 2, borderBottomColor: C.brass },
  shuffleAll: { paddingHorizontal: 16, paddingVertical: 12 },
  empty: { color: C.muted, padding: 24, textAlign: 'center', lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  songTitle: { flex: 1, color: C.parchment, fontSize: 16, marginRight: 12 },
  duration: { color: C.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  nowPlaying: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.surface, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  npTitle: { color: C.parchment, fontSize: 22, fontWeight: '700', marginBottom: 14 },
  scrubArea: { paddingVertical: 12 }, // taller touch target than the visible bar
  track: { height: 3, backgroundColor: C.line, borderRadius: 2, justifyContent: 'center' },
  thumb: { position: 'absolute', width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: C.brass },
  thumbActive: { width: 20, height: 20, borderRadius: 10, marginLeft: -10 },
  trackFill: { height: 3, backgroundColor: C.brass, borderRadius: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  ctrl: { color: C.parchment, fontSize: 28 },
  extrasRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  speedBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, minWidth: 56, alignItems: 'center' },
  speedText: { color: C.parchment, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  ctrlSmall: { color: C.muted, fontSize: 13, width: 72 },
  playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.brass, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: C.night, fontSize: 22, fontWeight: '700' },
});