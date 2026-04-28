// Standalone topic-pattern matching utilities.
// Imported by both peer-registry.ts and topic-registry.ts to avoid a
// circular dependency that would arise if topic-registry imported from
// peer-registry while server.ts imports both.

/**
 * Match a concrete dot-delimited topic against a subscription pattern.
 *
 * Rules (segments separated by `.`):
 *   - `*`  matches exactly one segment
 *   - `**` matches one or more segments (greedy; at least one segment)
 *   - any other segment must match literally
 *
 * Examples:
 *   matchTopic('task.started.p1', 'task.*.p1')    === true
 *   matchTopic('task.started.p1', 'task.**')      === true
 *   matchTopic('task.started',    'task.**')      === true
 *   matchTopic('task',            'task.**')      === false
 *   matchTopic('worker.online',   'worker.*')     === true
 *   matchTopic('worker.online.p1','worker.*')     === false
 */
export function matchTopic(topic: string, pattern: string): boolean {
  const t = topic.split('.');
  const p = pattern.split('.');
  return matchSegments(t, 0, p, 0);
}

function matchSegments(t: string[], ti: number, p: string[], pi: number): boolean {
  while (pi < p.length) {
    const seg = p[pi];
    if (seg === '**') {
      if (pi === p.length - 1) {
        return ti < t.length;
      }
      for (let k = ti + 1; k <= t.length; k++) {
        if (matchSegments(t, k, p, pi + 1)) return true;
      }
      return false;
    }
    if (ti >= t.length) return false;
    if (seg !== '*' && seg !== t[ti]) return false;
    ti++;
    pi++;
  }
  return ti === t.length;
}
