export type Song = {
    id: string;
    title: string;
    duration: number | null;
    file: string;
    size: number;
  };
  
  export type Manifest = {
    songs: Song[];
    playlists: Record<string, string[]>; // playlist name -> song ids
  };