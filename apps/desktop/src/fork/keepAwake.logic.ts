/** Pure bookkeeping for the keep-awake blocker: which windows currently ask for it. */
export function updateRequesters(
  requesters: ReadonlySet<number>,
  windowId: number,
  active: boolean,
): ReadonlySet<number> {
  if (requesters.has(windowId) === active) return requesters;
  const next = new Set(requesters);
  if (active) next.add(windowId);
  else next.delete(windowId);
  return next;
}
