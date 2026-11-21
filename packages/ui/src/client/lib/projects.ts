/** Inputs are absolute project paths normalized by the desktop main process. */
export function groupByProject<T extends { cwd?: string }>(sessions: readonly T[]) {
  const groups = new Map<string, { directory: string; sessions: T[] }>();
  for (const session of sessions) {
    const directory = session.cwd ?? "";
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(directory);
    const key = windows ? directory.replace(/\\/g, "/").toLowerCase() : directory;
    const group = groups.get(key);
    if (group) group.sessions.push(session);
    else groups.set(key, { directory, sessions: [session] });
  }
  return [...groups.values()];
}
