import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TextTranscriptEntry } from "#src/lifecycle/child-session";

export class CursorTranscript {
  private readonly entries: TextTranscriptEntry[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  snapshot(): readonly TextTranscriptEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  append(entry: TextTranscriptEntry): void {
    this.entries.push({ ...entry });
    this.scheduleFlush();
  }

  appendText(id: string, text: string): void {
    const entry = this.entries.findLast((candidate) => candidate.id === id);
    if (!entry) return;
    entry.text += text;
    this.scheduleFlush();
  }

  updateTool(id: string, patch: Partial<TextTranscriptEntry>): void {
    const entry = this.entries.findLast((candidate) => candidate.toolCallId === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.scheduleFlush();
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const temp = `${this.path}.${process.pid}.tmp`;
    const body = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(temp, body ? `${body}\n` : "", "utf8");
    renameSync(temp, this.path);
  }

  dispose(): void {
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 250);
    this.flushTimer.unref?.();
  }
}

export function readCursorTranscript(path: string): TextTranscriptEntry[] {
  const body = readFileSync(path, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TextTranscriptEntry);
}
