"""
Music sync server.

The computer uses yt-dlp to download the content, then the phone can sync 
over Wi-Fi to download them. The files can then be played offline.

Run for syncing:        
    python server.py
Download new songs added to the SEED_LIBRARY:  
    python server.py --seed  
"""

import json
import os
import sys
import threading

import yt_dlp  # type: ignore
from flask import Flask, abort, jsonify, request, send_from_directory  # type: ignore

AUDIO_DIR = "audio"
DB_FILE = "library.json"
os.makedirs(AUDIO_DIR, exist_ok=True)

SEED_LIBRARY = {
    "Soldier and Thief": "https://www.youtube.com/watch?v=_Gn9EsU_-eg",
    "Rise to Victory": "https://www.youtube.com/watch?v=GORfswQLHEE",

    "ST": "https://www.youtube.com/watch?v=8P29lj4nueo&t=3020s",
    "ST2": "https://www.youtube.com/watch?v=-dw3Jp-YpSw",
    "ST2.1": "https://www.youtube.com/watch?v=-dw3Jp-YpSw",
    "ST3": "https://www.youtube.com/watch?v=1PpqKEoPSzo",
    "ST4.1": "https://www.youtube.com/watch?v=y-WDM4V9g8M",
    "ST4.2": "https://www.youtube.com/watch?v=I7yx8OMlNo4",
    "ST4.3.2": "https://www.youtube.com/watch?v=aCy6BBo1KXM",
    "ST5.1": "https://www.youtube.com/watch?v=3h11NaV5n5s",
    "ST5.2": "https://www.youtube.com/watch?v=MbsOgjftxPs",
    "HPaIG pt 1": "https://www.youtube.com/watch?v=GBpCm3ABwm8&t=31450s",
    "HPaIG pt 2": "https://www.youtube.com/watch?v=zuRdMCj_n2A&t=4s",
    
    "Nargles": "https://www.youtube.com/watch?v=SdEIoQlYiNA&list=RDSdEIoQlYiNA&start_radio=1",
    "Fair Play": "https://www.youtube.com/watch?v=WkO6SJdhAEQ&list=RDSdEIoQlYiNA&index=2",
    "Reading": "https://www.youtube.com/watch?v=sashbqiC9a0&list=RDSdEIoQlYiNA&index=3",

}
SEED_PLAYLISTS = {
    "test": ["Soldier and Thief", "Rise to Victory"],
    "audiobooks": ["ST", "ST2", "ST3", "ST4.1", "ST4.2", "ST4.3.2", "ST5.1", "ST5.2", "HPaIG pt 1", "HPaIG pt 2"],
    "Story songs": ["Nargles", "Fair Play", "Reading"]
}

app = Flask(__name__)
lock = threading.Lock()

YDL_OPTS = {
    # m4a first: iPhones can't play webm/opus. Falls back to any audio if no m4a exists.
    "format": "bestaudio[ext=m4a]/bestaudio",
    "outtmpl": os.path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
    "noplaylist": True,
    "quiet": False,                       # show yt-dlp's progress bar in the server terminal
    "concurrent_fragment_downloads": 4,   # faster downloads for long videos
}


# ---------- storage ----------
def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE) as f:
            return json.load(f)
    return {"songs": {}, "playlists": {}}

def save_db():
    with open(DB_FILE, "w") as f:
        json.dump(db, f, indent=2)

db = load_db()


def download_song(url, title=None):
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = os.path.basename(ydl.prepare_filename(info))
    song = {
        "id": info["id"],
        "title": title or info.get("title"),
        "duration": info.get("duration"),
        "file": filename,
        "size": os.path.getsize(os.path.join(AUDIO_DIR, filename)),
    }
    with lock:
        db["songs"][song["id"]] = song
        save_db()
    return song


# ---------- routes ----------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True}), 200

@app.route("/manifest", methods=["GET"])
def manifest():
    """Everything the phone needs to decide what to download."""
    return jsonify({"songs": list(db["songs"].values()), "playlists": db["playlists"]}), 200

@app.route("/audio/<path:filename>", methods=["GET"])
def audio(filename):
    return send_from_directory(AUDIO_DIR, filename, as_attachment=False)

@app.route("/songs", methods=["POST"])
def add_song():
    """Body: {"url": "...", "title": "optional", "playlist": "optional"}"""
    body = request.get_json() or {}
    if "url" not in body:
        return jsonify({"error": "url required"}), 400
    try:
        song = download_song(body["url"], body.get("title"))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    pl = body.get("playlist")
    if pl:
        with lock:
            db["playlists"].setdefault(pl, [])
            if song["id"] not in db["playlists"][pl]:
                db["playlists"][pl].append(song["id"])
            save_db()
    return jsonify(song), 201

@app.route("/songs/<song_id>", methods=["DELETE"])
def delete_song(song_id):
    with lock:
        song = db["songs"].pop(song_id, None)
        if not song:
            abort(404)
        for ids in db["playlists"].values():
            if song_id in ids:
                ids.remove(song_id)
        path = os.path.join(AUDIO_DIR, song["file"])
        if os.path.exists(path):
            os.remove(path)
        save_db()
    return jsonify({"deleted": song_id}), 200

@app.route("/playlists/<name>", methods=["PUT"])
def set_playlist(name):
    """Create or replace a playlist. Body: {"songIds": ["id1", "id2"]}"""
    ids = (request.get_json() or {}).get("songIds", [])
    unknown = [i for i in ids if i not in db["songs"]]
    if unknown:
        return jsonify({"error": "unknown song ids", "ids": unknown}), 400
    with lock:
        db["playlists"][name] = ids
        save_db()
    return jsonify({name: ids}), 200

@app.route("/playlists/<name>", methods=["DELETE"])
def delete_playlist(name):
    with lock:
        if db["playlists"].pop(name, None) is None:
            abort(404)
        save_db()
    return jsonify({"deleted": name}), 200


# ---------- one-time seed from the old dicts ----------
def seed():
    title_to_id = {s["title"]: s["id"] for s in db["songs"].values()}
    for title, url in SEED_LIBRARY.items():
        if title in title_to_id:
            continue
        print(f"Downloading {title}...")
        try:
            title_to_id[title] = download_song(url, title)["id"]
        except Exception as e:
            print(f"  failed: {e}")
    for name, titles in SEED_PLAYLISTS.items():
        db["playlists"][name] = [title_to_id[t] for t in titles if t in title_to_id]
    save_db()
    print("Seed done.")


if __name__ == "__main__":
    if "--seed" in sys.argv:
        seed()
    # 0.0.0.0 = reachable from other devices on the same network, not just this computer
    app.run(host="0.0.0.0", port=5001)