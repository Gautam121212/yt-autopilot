# Background music

Drop audio files here (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`) and the render mixes one under the
narration, ducked automatically so it dips whenever the voice is speaking. An empty folder means no
music and nothing breaks.

**Free, licence-clean sources** — download a few tracks once and keep them here:

| Source | Licence | Attribution |
|---|---|---|
| YouTube Audio Library (studio.youtube.com → Audio library) | free for YouTube use | some tracks require it |
| Pixabay Music (pixabay.com/music) | Pixabay licence, commercial use OK | not required |
| Incompetech | CC BY | required — put it in the description |
| Free Music Archive | varies per track | check each track |

Pick calm, low-movement instrumentals: documentary beds, ambient, light percussion. Anything with a
melody that pulls attention will fight the narration.

One track is chosen per video from its id, so consecutive videos differ and a re-render is
reproducible. `MUSIC_GAIN` (default 0.10) sets the level; `MUSIC=off` disables it entirely.
