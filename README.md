# subtitle.lol

**Subtitles made from a video's own audio, in its language or yours.**

For when Plex can't find subtitles, or the English subtitles don't match the English dub. Each
episode takes 1–2 minutes, and 95–100% of lines come out right.

## How it works

1. **Copy out the audio.** subtitle.lol reads MKV and MP4 files itself and copies the chosen audio track
   out, so a 280 MB episode becomes a 26 MB upload. No ffmpeg needed.
2. **Speech to text** with [ElevenLabs Scribe](https://elevenlabs.io/speech-to-text), because it
   returns the time of every word, which is what subtitles are built from. An hour of audio takes
   under a minute and about 1,200 credits (22 cents on the Creator plan).
3. **Lines.** The words become subtitles of one or two lines, broken at pauses and full stops.
   Japanese, Chinese and Thai, which have no spaces, break between the phrases found by Google's
   [BudouX](https://github.com/google/budoux). Each subtitle appears 0.2 seconds before the voice: on
   a Frieren episode, Scribe's timings ran 0.14 seconds late and the official subtitles 0.25 seconds
   early.
4. **A glossary of names**, if you translate. Gemini reads the whole episode, lists every name, place
   and special term, searches the web for the official spelling, and notes names the speech
   recognition misheard (聖都 heard as 生徒). The glossary is saved with the videos, so a series keeps
   the same names.
5. **Translation.** Gemini translates the lines in batches, each with the glossary, and must return a
   translation for every line.

The file is saved as `Episode 1.en.srt` next to `Episode 1.mkv`, which Plex, VLC and IINA load on
their own. Transcripts are saved too, so nothing is paid for twice.

## Use it

**In your browser:** open [subtitle.lol](https://subtitle.lol), or
download `subtitle.lol.html` from there and open it from your computer. Choose a video, paste your
keys, press Go.

**On the command line**, for whole folders (Node 23.6 or later):

```sh
git clone https://github.com/lionpal/subtitler.git && cd subtitler && npm link
cd "/path/to/your/videos"
subtitler                     # pick videos from a list
subtitler --translate en      # and translate them
subtitler --help
```

## Your keys

In the browser, keys stay in the tab and are forgotten when you close it. The page's content
security policy lets it connect to `api.elevenlabs.io` and `generativelanguage.googleapis.com` and
nowhere else, and the browser enforces it. On the command line, keys are saved in `.env` next to the
program, readable only by you. Either way, each key is sent only to its own service, from
`src/core/speech/elevenlabs.ts` and `src/core/translation/gemini.ts`.

## Or ask a coding agent

You can also skip this tool and have a coding agent make the files with you. Paste this in:

> i need subtitles for some videos. walk me through making .srt files from the audio, asking me
> whenever you need something: which videos, which audio track if there's more than one, and what
> language i want the subtitles in. by default use elevenlabs speech to text (it gives per-word
> timings) and gemini to translate, but check which providers i want and ask for my keys. send only
> the audio track, not the whole video. build the subtitles from the word timings, one or two lines
> each, breaking at pauses and full stops, shown 0.2 s before the voice, and for
> japanese or chinese break between phrases, not inside words. if i want them in a different
> language from the audio (say english subtitles for a japanese track), transcribe in the original
> language first, then go through the whole episode for names, places and special terms, look up the
> official spellings (the official release or the show's wiki), fix any the transcription misheard,
> show me that list, and translate using it so names stay the same across episodes. save each file
> as Episode 1.en.srt next to its video so plex picks it up, and keep the transcripts so i don't pay
> twice.

## The code

Everything that does the work is in `src/core/`, shared line for line by the command line (`src/cli/`)
and the web page (`src/web/`). A new speech-to-text or translation service is one file in
`src/core/speech/` or `src/core/translation/`, listed in `src/core/services.ts`.

```sh
npm install && npm test && npm run build:web    # the page is built into site/
```

## License

MIT. The BudouX files in `src/core/vendor/budoux/` are Copyright 2021 Google LLC, under the Apache
License 2.0 included there.

subtitle.lol is not affiliated with Plex, ElevenLabs, Google or any other company named here.
