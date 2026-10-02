// What a translation service has to do. Everything about subtitles and glossaries is in
// translate.ts; a translator only sends a request to a language model and returns the JSON it
// answers with. Adding another service means writing one more file like gemini.ts.

export type Translator = {
  name: string; // shown to the user and saved with the results, e.g. "gemini-3.8-flash"
  // `schema` is a JSON Schema the answer must match. The provider returns the parsed answer.
  // With `webSearch`, the model may search the web before answering, which is how it finds the
  // names an official translation uses.
  generateJson(instructions: string, request: string, schema: object, options?: { webSearch?: boolean }): Promise<unknown>;
};
