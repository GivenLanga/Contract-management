export function getDaysLabel(dueDate) {
  if (!dueDate) return null;
  const now = new Date();
  const due = new Date(dueDate);
  const diff = Math.round((due - now) / 86400000);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return { label: `Overdue by ${Math.abs(diff)}d`, cls: 'overdue' };
  if (diff === 0) return { label: 'Due today', cls: 'today' };
  if (diff <= 3) return { label: `Due in ${diff}d`, cls: 'soon' };
  return { label: `Due in ${diff}d`, cls: 'ok' };
}
