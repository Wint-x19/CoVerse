import type {UiSession} from "./types.js";

export const historyVersion = 3;
export function needsHistoryRefresh(session:UiSession):boolean {
  return Boolean(session.reference || session.handoff) && (session.historyVersion ?? 0) < historyVersion;
}
