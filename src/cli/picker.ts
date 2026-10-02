// A small checkbox list for the terminal: arrows move, space toggles, enter confirms.

import { emitKeypressEvents } from "node:readline";

export type Choice = {
  label: string;
  note: string; // shown after the label, e.g. "58m · has subtitles"
  color: "green" | "yellow" | "plain";
  selected: boolean;
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_TO_END = "\x1b[0J";
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const COLORS = { green: "\x1b[32m", yellow: "\x1b[33m", plain: "" };
const RESET_COLOR = "\x1b[39m";

// Resolves with the chosen indexes, or null if the user quits.
// `footer` is redrawn on every change, e.g. to show the total length selected.
export function pickMany(
  title: string,
  choices: Choice[],
  footer: (selected: number[]) => string,
): Promise<number[] | null> {
  return pick(title, choices, footer, false);
}

// The same list with no checkboxes: enter chooses the line under the cursor.
export async function pickOne(title: string, labels: string[]): Promise<number | null> {
  const choices: Choice[] = labels.map((label) => ({ label, note: "", color: "plain", selected: false }));
  const picked = await pick(title, choices, () => "", true);
  return picked === null ? null : picked[0];
}

function pick(
  title: string,
  choices: Choice[],
  footer: (selected: number[]) => string,
  single: boolean,
): Promise<number[] | null> {
  const input = process.stdin;
  const output = process.stdout;
  let cursor = 0;
  let linesDrawn = 0;

  const selectedIndexes = () => choices.flatMap((choice, i) => (choice.selected ? [i] : []));

  function draw() {
    // Show only as many rows as fit, scrolling with the cursor.
    const visibleRows = Math.max(3, (output.rows || 24) - 6);
    const first = Math.min(Math.max(0, cursor - visibleRows + 1), Math.max(0, choices.length - visibleRows));
    const shown = choices.slice(first, first + visibleRows);

    const lines = [
      bold(title),
      dim(single ? "↑/↓ move · enter choose · q quit" : "↑/↓ move · space select · a all · enter start · q quit"),
      "",
      ...shown.map((choice, offset) => {
        const i = first + offset;
        const pointer = i === cursor ? "›" : " ";
        const box = single ? "" : choice.selected ? "[x] " : "[ ] ";
        const color = COLORS[choice.color];
        return `${pointer} ${box}${color}${choice.label}  ${choice.note}${RESET_COLOR}`;
      }),
      "",
      ...footer(selectedIndexes()).split("\n"),
    ];

    // Move back to where the previous drawing started, then redraw over it.
    if (linesDrawn > 0) output.write(`\x1b[${linesDrawn}F`);
    output.write(CLEAR_TO_END + lines.map((line) => truncate(line, output.columns || 80)).join("\n") + "\n");
    linesDrawn = lines.length;
  }

  return new Promise((resolve) => {
    function finish(result: number[] | null) {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write(SHOW_CURSOR);
      resolve(result);
    }

    function onKey(_text: string, key: { name?: string; ctrl?: boolean }) {
      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "q":
        case "escape":
          return finish(null);
        case "return":
          return finish(single ? [cursor] : selectedIndexes());
        case "up":
        case "k":
          cursor = (cursor - 1 + choices.length) % choices.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % choices.length;
          break;
        case "space":
          if (single) break;
          choices[cursor].selected = !choices[cursor].selected;
          break;
        case "a": {
          if (single) break;
          const selectAll = choices.some((choice) => !choice.selected);
          for (const choice of choices) choice.selected = selectAll;
          break;
        }
      }
      draw();
    }

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    output.write(HIDE_CURSOR);
    draw();
  });
}

// Cuts a line to the terminal width so a long filename cannot wrap and break the redraw.
// Color codes take no space on screen, so they are not counted.
function truncate(line: string, width: number): string {
  let visible = 0;
  let result = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      result += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible === width - 1) return result + "…\x1b[0m";
    result += line[i];
    visible++;
  }
  return result;
}
