// subtitle.lol on the web page. The work itself is in src/core/pipeline.ts, shared with the command
// line; this file connects it to the page: the file you choose, the services and keys, and the
// steps as they happen.

import { ApiError, errorMessage } from "../core/http.ts";
import { formatDuration, prepare, type Prepared, secondsToTranscribe, type Step, subtitle, twoLetterLanguage } from "../core/pipeline.ts";
import { type ApiKeyInfo, SPEECH_SERVICES, TRANSLATION_LANGUAGES, TRANSLATION_SERVICES } from "../core/services.ts";
import { languageName } from "../core/translation/translate.ts";
import { chosenFileFolder } from "./browser-folder.ts";

const page = {
  choose: element<HTMLButtonElement>("choose"),
  fileInput: element<HTMLInputElement>("file-input"),
  fileInfo: element("file-info"),
  fileName: element("file-name"),
  fileDetails: element("file-details"),
  trackRow: element("track-row"),
  audioTrack: element<HTMLSelectElement>("audio-track"),
  speechService: element<HTMLSelectElement>("speech-service"),
  translate: element<HTMLInputElement>("translate"),
  translateTo: element<HTMLSelectElement>("translate-to"),
  translator: element<HTMLSelectElement>("translator"),
  keys: element("keys"),
  go: element<HTMLButtonElement>("go"),
  estimate: element("estimate"),
  progress: element<HTMLOListElement>("progress"),
  results: element("results"),
};

let file: File | null = null;
let prepared: Prepared | null = null;
let running = false;

// --- Tabs: using it here, or the commands for a terminal ---

const tabs = [element("tab-browser"), element("tab-cli"), element("tab-agent")];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const other of tabs) {
      other.setAttribute("aria-selected", String(other === tab));
      element(other.getAttribute("aria-controls")!).hidden = other !== tab;
    }
  });
}

// --- The services: menus built from src/core/services.ts ---

page.speechService.replaceChildren(...SPEECH_SERVICES.map((service) => option(service.id, service.label)));
page.translator.replaceChildren(...TRANSLATION_SERVICES.map((service) => option(service.id, service.label)));
page.translateTo.replaceChildren(...TRANSLATION_LANGUAGES.map((code) => option(code, languageName(code))));
page.translateTo.value = "en";

page.translate.addEventListener("change", () => {
  page.translateTo.disabled = !page.translate.checked;
  page.translator.disabled = !page.translate.checked;
  update();
});
for (const select of [page.speechService, page.translateTo, page.translator]) select.addEventListener("change", update);

const speechService = () => SPEECH_SERVICES.find((s) => s.id === page.speechService.value)!;
const translationService = () => TRANSLATION_SERVICES.find((s) => s.id === page.translator.value)!;

// --- Keys: one field per service in use, kept in sessionStorage, which the browser clears when
// the tab is closed. ---

const keyInputs = new Map<string, HTMLInputElement>();

function showKeyFields() {
  const needed: ApiKeyInfo[] = [speechService().key];
  if (page.translate.checked && !needed.includes(translationService().key)) needed.push(translationService().key);
  page.keys.replaceChildren(...needed.map(keyField));
}

function keyField(info: ApiKeyInfo): HTMLElement {
  let input = keyInputs.get(info.variable);
  if (!input) {
    const field = document.createElement("input");
    field.type = "password";
    field.autocomplete = "off";
    field.id = `key-${info.variable}`;
    field.value = sessionValue(info.variable);
    field.addEventListener("input", () => {
      setSessionValue(info.variable, field.value.trim());
      estimator = null;
      update();
    });
    keyInputs.set(info.variable, field);
    input = field;
  }
  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.textContent = `${info.name} API key`;
  const link = document.createElement("a");
  link.href = info.keysPage;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Get a key";
  const name = document.createElement("div");
  name.append(label, link);
  const row = document.createElement("div");
  row.className = "key";
  row.append(name, input);
  return row;
}

function keyFor(info: ApiKeyInfo): string {
  return keyInputs.get(info.variable)?.value.trim() ?? "";
}

// --- Choosing a video ---

page.choose.addEventListener("click", () => page.fileInput.click());
page.fileInput.addEventListener("change", async () => {
  const chosen = page.fileInput.files?.[0];
  if (!chosen) return;
  file = chosen;
  page.results.replaceChildren();
  page.progress.hidden = true;
  await readFile(null);
  const tracks = prepared!.info.audioTracks;
  page.trackRow.hidden = tracks.length < 2;
  page.audioTrack.replaceChildren(
    ...tracks.map((track, i) => {
      const code = twoLetterLanguage(track.language);
      return option(code ?? "", code ? languageName(code) : `track ${i + 1}`);
    }),
  );
  update();
});

page.audioTrack.addEventListener("change", async () => {
  await readFile(page.audioTrack.value || null);
  update();
});

async function readFile(audioLanguage: string | null) {
  if (!file) return;
  page.choose.textContent = "Choose another video";
  const folder = chosenFileFolder(file, offerDownload);
  prepared = await prepare({ folder, name: file.name }, { audioLanguage, language: null });

  const { info } = prepared;
  const audio = info.audioTracks.map((track) => {
    const code = twoLetterLanguage(track.language);
    return `${code ? languageName(code) : "untagged"} audio (${track.codec.toUpperCase()})`;
  });
  const details = [
    info.durationSeconds === null ? null : formatDuration(info.durationSeconds),
    `${Math.round(file.size / 1e6)} MB`,
    audio.length > 0 ? audio.join(", ") : "audio tracks not readable; the whole file will be sent",
    prepared.saved ? "already transcribed in this browser" : null,
  ];
  page.fileName.textContent = file.name;
  page.fileDetails.textContent = details.filter(Boolean).join(" · ");
  page.fileInfo.hidden = false;
}

// --- Keeping the Go button and the estimate up to date ---

// The estimator reads your plan once per key, so it is kept until the key changes.
let estimator: Promise<(seconds: number) => string> | null = null;

async function update() {
  showKeyFields();
  const speechKey = keyFor(speechService().key);
  const ready =
    prepared !== null && speechKey !== "" && (!page.translate.checked || keyFor(translationService().key) !== "");
  page.go.disabled = running || !ready;

  if (prepared === null || speechKey === "") {
    page.estimate.textContent = "";
  } else if (prepared.saved) {
    page.estimate.textContent = "Transcribing is free: this video was transcribed in this browser before.";
  } else {
    estimator ??= speechService().create(speechKey).costEstimator();
    const describe = await estimator;
    const seconds = secondsToTranscribe(prepared);
    page.estimate.textContent = seconds > 0 ? `Costs ${describe(seconds)}.` : "";
  }
}

// --- Doing the work ---

const STEPS: { step: Step | "read"; title: string; whenTranslating?: boolean }[] = [
  { step: "read", title: "Read the video" },
  { step: "audio", title: "Copy out the audio" },
  { step: "transcribe", title: "Transcribe the speech" },
  { step: "subtitles", title: "Write the subtitles" },
  { step: "glossary", title: "Find names and terms", whenTranslating: true },
  { step: "translate", title: "Translate", whenTranslating: true },
];

page.go.addEventListener("click", async () => {
  if (!prepared) return;
  running = true;
  page.go.disabled = true;
  page.results.replaceChildren();

  const translating = page.translate.checked;
  const steps = STEPS.filter((s) => translating || !s.whenTranslating);
  const rows = new Map(steps.map((s) => [s.step, progressRow(s.title)]));
  page.progress.replaceChildren(...rows.values());
  page.progress.hidden = false;

  // Each report marks its step as under way, and the steps before it as done (or skipped, for a
  // step that never started, like copying out audio already transcribed).
  let current = 0;
  const report = (step: Step | "read", message: string) => {
    const index = steps.findIndex((s) => s.step === step);
    for (let i = current; i < index; i++) {
      const row = rows.get(steps[i].step)!;
      row.className = row.className === "working" ? "done" : "skipped";
    }
    current = Math.max(current, index);
    const row = rows.get(step)!;
    row.className = "working";
    row.querySelector(".detail")!.textContent = message;
  };

  const track = prepared.info.audioTracks[prepared.track];
  const trackLanguage = twoLetterLanguage(track?.language);
  report("read", [formatDuration(prepared.info.durationSeconds ?? 0), trackLanguage && `${languageName(trackLanguage)} audio`].filter(Boolean).join(", "));

  const settings = {
    speech: speechService().create(keyFor(speechService().key)),
    translation: translating
      ? {
          translator: translationService().create(keyFor(translationService().key), (message) => report("translate", message)),
          to: page.translateTo.value,
        }
      : null,
  };

  try {
    await subtitle(prepared, settings, report);
    for (const row of rows.values()) if (row.className !== "skipped") row.className = "done";
  } catch (error) {
    const row = rows.get(steps[current].step)!;
    row.className = "failed";
    // Whatever failed, a transcript that was paid for is already saved, so pressing Go again only
    // redoes what is left. Say so, since otherwise it looks like starting over.
    const saved = rows.get("subtitles")!.className === "done" ? " The transcript is saved, so pressing Go again only redoes the rest." : "";
    const fix = error instanceof ApiError && error.isKeyProblem ? ` Fix the ${error.service} key above and press Go again.` : "";
    row.querySelector(".detail")!.textContent = errorMessage(error) + fix + saved;
  }

  running = false;
  await readFile(page.audioTrack.value || null); // so the next run knows the transcript is saved
  update();
});

function progressRow(title: string): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "pending";
  const icon = document.createElement("span");
  icon.className = "icon";
  const name = document.createElement("span");
  name.className = "title";
  name.textContent = title;
  const detail = document.createElement("span");
  detail.className = "detail";
  row.append(icon, name, detail);
  return row;
}

// Each finished .srt becomes a download.
function offerDownload(name: string, text: string) {
  const link = document.createElement("a");
  link.className = "big";
  link.href = URL.createObjectURL(new Blob([text], { type: "application/x-subrip" }));
  link.download = name;
  link.textContent = `Download ${name}`;
  page.results.append(link);
}

// --- Small helpers ---

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function option(value: string, text: string): HTMLOptionElement {
  const choice = document.createElement("option");
  choice.value = value;
  choice.textContent = text;
  return choice;
}

function sessionValue(key: string): string {
  try {
    return sessionStorage.getItem(`subtitler.${key}`) ?? "";
  } catch {
    return "";
  }
}

function setSessionValue(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(`subtitler.${key}`, value);
    else sessionStorage.removeItem(`subtitler.${key}`);
  } catch {
    // Storage is off in this browser; the page still works, it just asks again after a reload.
  }
}

update();
