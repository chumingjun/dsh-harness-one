import path from 'node:path';

export function readableName(title) {
  const name = String(title).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  return [...name].slice(0, 72).join('') || '未命名资料';
}

export function resourceDirectory(record, records) {
  const roles = record.uses.map((use) => use.role);
  const category = record.group === 'project' ? 'files'
    : ['knowledge', 'output-template', 'collection-template', 'reference-example'].find((role) => roles.includes(role));
  const name = readableName(record.title);
  const duplicates = records.filter((item) => readableName(item.title).toLowerCase() === name.toLowerCase());
  const suffix = duplicates.length > 1 ? `-来源行${Math.min(...record.uses.map((use) => use.row))}` : '';
  return path.join(category, name + suffix);
}
