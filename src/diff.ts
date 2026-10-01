import type { ChecklistItem, ChecklistProject, ChecklistRevision, DiffEntry, VersionOption } from './types';

const itemLabel = (item: ChecklistItem) => `${item.challenge || '未命名'} → ${item.response || '未填写'}`;

/** version/updatedAt 是并发控制元数据，不属于业务内容差异。 */
const stripItemMeta = (item: ChecklistItem) => {
  const { updatedAt: _updatedAt, version: _version, ...rest } = item;
  return rest;
};

export function buildVersionOptions(project: ChecklistProject): VersionOption[] {
  return [
    { id: 'current', label: `当前 r${project.revision} · ${statusLabel(project.status)}` },
    ...project.revisions.map((revision) => ({ id: revision.id, label: `r${revision.revision} · ${statusLabel(revision.status)} · ${new Date(revision.createdAt).toLocaleDateString('zh-CN')}` }))
  ];
}

export function diffVersions(project: ChecklistProject, leftId: string, rightId: string): DiffEntry[] {
  const left = versionProject(project, leftId);
  const right = versionProject(project, rightId);
  if (!left || !right) return [];
  const entries: DiffEntry[] = [];
  const oldItems = new Map(left.items.map((item) => [item.id, item]));
  const newItems = new Map(right.items.map((item) => [item.id, item]));
  const allIds = new Set([...oldItems.keys(), ...newItems.keys()]);

  for (const id of allIds) {
    const before = oldItems.get(id);
    const after = newItems.get(id);
    const stageName = (item?: ChecklistItem) => project.stages.find((stage) => stage.id === item?.stageId)?.name ?? '未分配阶段';
    if (!before && after) {
      entries.push({ type: 'added', key: id, stage: stageName(after), before: '—', after: itemLabel(after) });
    } else if (before && !after) {
      entries.push({ type: 'removed', key: id, stage: stageName(before), before: itemLabel(before), after: '—' });
    } else if (before && after && JSON.stringify(stripItemMeta(before)) !== JSON.stringify(stripItemMeta(after))) {
      entries.push({
        type: 'changed',
        key: id,
        stage: stageName(after),
        before: `${itemLabel(before)}${before.critical ? ' [关键]' : ''}`,
        after: `${itemLabel(after)}${after.critical ? ' [关键]' : ''}`
      });
    }
  }

  const oldStageIds = new Set(left.stages.map((stage) => stage.id));
  const newStageIds = new Set(right.stages.map((stage) => stage.id));
  right.stages.filter((stage) => !oldStageIds.has(stage.id)).forEach((stage) => {
    entries.push({ type: 'stage', key: stage.id, stage: stage.name, before: '—', after: `新增阶段：${stage.description || stage.name}` });
  });
  left.stages.filter((stage) => !newStageIds.has(stage.id)).forEach((stage) => {
    entries.push({ type: 'stage', key: stage.id, stage: stage.name, before: `移除阶段：${stage.description || stage.name}`, after: '—' });
  });

  const stageOrderChanged = left.stages.map((stage) => stage.id).join('|') !== right.stages.map((stage) => stage.id).join('|');
  if (stageOrderChanged) {
    entries.unshift({
      type: 'stage',
      key: 'stage-order',
      stage: '阶段排序',
      before: left.stages.sort((a, b) => a.order - b.order).map((stage) => stage.name).join(' → '),
      after: right.stages.sort((a, b) => a.order - b.order).map((stage) => stage.name).join(' → ')
    });
  }
  return entries;
}

function versionProject(project: ChecklistProject, id: string): Pick<ChecklistProject, 'stages' | 'items'> | undefined {
  if (id === 'current') return { stages: project.stages, items: project.items };
  const revision: ChecklistRevision | undefined = project.revisions.find((entry) => entry.id === id);
  return revision ? { stages: revision.stages, items: revision.items } : undefined;
}

function statusLabel(status: ChecklistProject['status']): string {
  return { draft: '编辑中', review: '复核中', frozen: '已冻结' }[status];
}
