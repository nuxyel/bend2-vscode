import {
  BrowserWorkerEntry,
  BrowserWorkerFile,
  findBrowserDefinition,
  indexBrowserFiles,
  searchBrowserSymbols,
} from "./browserWorkerCore.js";

type WorkerRequest =
  | { id: number; method: "index"; files: BrowserWorkerFile[] }
  | { id: number; method: "definition"; currentUri: string; name: string }
  | { id: number; method: "symbols"; query: string };

let entries: BrowserWorkerEntry[] = [];

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.method === "index") {
      entries = indexBrowserFiles(request.files);
      respond(request.id, true, null);
    } else if (request.method === "definition") {
      respond(request.id, true, findBrowserDefinition(entries, request.currentUri, request.name) ?? null);
    } else {
      respond(request.id, true, searchBrowserSymbols(entries, request.query));
    }
  } catch (error) {
    respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
};

function respond(id: number, ok: boolean, value: unknown): void {
  self.postMessage({ id, ok, value });
}
