import type { ChecklistItem, ChecklistProject, ItemConflict, ReachabilityState, WorkspaceState } from './types';
import { validateProject } from './validation';

/** 比较检查项内容（忽略版本号与保存时间），用于判断是否被修改。 */
export function itemContent(item: ChecklistItem) {
  const { updatedAt: _updatedAt, version: _version, ...content } = item;
  return content;
}

export function itemChangedSince(item: ChecklistItem, base: ChecklistItem): boolean {
  return JSON.stringify(itemContent(item)) !== JSON.stringify(itemContent(base));
}

export function recomputeReachability(project: ChecklistProject, now: () => string): ReachabilityState {
  const issueIds = validateProject(project)
    .filter((issue) => issue.type === 'unreachable-precondition')
    .map((issue) => issue.id);
  return {
    status: issueIds.length ? 'issues' : 'ok',
    orderEpoch: project.orderEpoch,
    issueIds,
    computedAt: now()
  };
}

export interface MergeHelpers {
  now: () => string;
  uid: (prefix: string) => string;
  freshLease: () => NonNullable<ChecklistProject['lease']>;
}

export interface MergeResult {
  state: WorkspaceState;
  newConflicts: ItemConflict[];
}

/**
 * 保存前的版本核对与合并：
 * 以对方已落盘的内容为基线，仅合入本页改动；同一检查项两页都改过则互不覆盖、登记冲突；
 * 顺序变化后重新核算前置条件可达性。
 */
export function mergeWorkspace(
  fresh: WorkspaceState,
  working: WorkspaceState,
  base: WorkspaceState,
  helpers: MergeHelpers
): MergeResult {
  const { now, uid, freshLease } = helpers;
  const freshProject = fresh.projects.find((entry) => entry.id === fresh.selectedProjectId);
  const workingProject = working.projects.find((entry) => entry.id === working.selectedProjectId);
  const baseProject = base.projects.find((entry) => entry.id === base.selectedProjectId);
  if (!freshProject || !workingProject || !baseProject) {
    return { state: fresh, newConflicts: [] };
  }

  const newConflicts: ItemConflict[] = [];
  const baseItems = new Map(baseProject.items.map((item) => [item.id, item]));
  const workingItems = new Map(workingProject.items.map((item) => [item.id, item]));

  const mergedItems: ChecklistItem[] = [];
  for (const remote of freshProject.items) {
    const base = baseItems.get(remote.id);
    const local = workingItems.get(remote.id);
    const remoteChanged = base ? itemChangedSince(remote, base) && remote.version > base.version : true;
    const weChanged = base ? !!local && itemChangedSince(local, base) : false;
    const weDeleted = !!base && !local;
    const existingConflict = freshProject.conflicts.find((entry) => entry.itemId === remote.id);

    if (weDeleted && remoteChanged && base) {
      if (existingConflict?.resolved) {
        if (existingConflict.resolution === 'remote') mergedItems.push(structuredClone(remote));
      } else {
        newConflicts.push({
          id: uid('conflict'),
          itemId: remote.id,
          itemLabel: remote.challenge || '未命名检查项',
          detectedAt: now(),
          base: structuredClone(base),
          local: null,
          remote: structuredClone(remote),
          resolved: false,
          resolution: null
        });
        mergedItems.push(structuredClone(remote));
      }
    } else if (weDeleted) {
      // 我方删除、对方未改：按删除处理。
    } else if (weChanged && remoteChanged && base && local) {
      if (existingConflict?.resolved) {
        if (existingConflict.resolution === 'local') mergedItems.push(structuredClone(local));
      } else {
        newConflicts.push({
          id: uid('conflict'),
          itemId: remote.id,
          itemLabel: remote.challenge || '未命名检查项',
          detectedAt: now(),
          base: structuredClone(base),
          local: structuredClone(local),
          remote: structuredClone(remote),
          resolved: false,
          resolution: null
        });
        mergedItems.push(structuredClone(remote));
      }
    } else if (weChanged && local) {
      mergedItems.push(structuredClone(local));
    } else {
      mergedItems.push(structuredClone(remote));
    }
  }
  for (const local of workingProject.items) {
    if (!freshProject.items.some((item) => item.id === local.id)) {
      mergedItems.push(structuredClone(local));
    }
  }

  const mergedStages = freshProject.stages.map((remoteStage) => {
    const baseStage = baseProject.stages.find((stage) => stage.id === remoteStage.id);
    const localStage = workingProject.stages.find((stage) => stage.id === remoteStage.id);
    const weChangedStage = !!baseStage && !!localStage && JSON.stringify(localStage) !== JSON.stringify(baseStage);
    const remoteChangedStage = !!baseStage && JSON.stringify(remoteStage) !== JSON.stringify(baseStage);
    return weChangedStage && !remoteChangedStage && localStage ? structuredClone(localStage) : structuredClone(remoteStage);
  });
  for (const localStage of workingProject.stages) {
    if (!freshProject.stages.some((stage) => stage.id === localStage.id)) mergedStages.push(structuredClone(localStage));
  }
  const weReordered = workingProject.orderEpoch > baseProject.orderEpoch;
  const remoteReordered = freshProject.orderEpoch > baseProject.orderEpoch;
  if (weReordered && !remoteReordered) {
    const order = new Map(workingProject.stages.map((stage, index) => [stage.id, index]));
    mergedStages.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }
  mergedStages.forEach((stage, index) => {
    stage.order = index;
  });

  const mergedProject: ChecklistProject = {
    ...structuredClone(freshProject),
    stages: mergedStages,
    items: mergedItems,
    conflicts: [...freshProject.conflicts, ...newConflicts],
    orderEpoch: Math.max(workingProject.orderEpoch, freshProject.orderEpoch),
    lease: { ...freshProject.lease!, ...freshLease() }
  };

  const projectFieldsChanged =
    JSON.stringify({ name: workingProject.name, aircraft: workingProject.aircraft }) !==
    JSON.stringify({ name: baseProject.name, aircraft: baseProject.aircraft });
  const projectFieldsRemoteChanged =
    JSON.stringify({ name: freshProject.name, aircraft: freshProject.aircraft }) !==
    JSON.stringify({ name: baseProject.name, aircraft: baseProject.aircraft });
  if (projectFieldsChanged && !projectFieldsRemoteChanged) {
    mergedProject.name = workingProject.name;
    mergedProject.aircraft = workingProject.aircraft;
  }
  mergedProject.status = workingProject.status;
  mergedProject.revision = workingProject.revision;
  mergedProject.reviewNote = workingProject.reviewNote;
  mergedProject.revisions = structuredClone(workingProject.revisions);

  if (weReordered || remoteReordered || mergedProject.reachability.status !== 'ok') {
    mergedProject.reachability = recomputeReachability(mergedProject, now);
  }

  return {
    state: {
      ...fresh,
      projects: fresh.projects.map((entry) => (entry.id === mergedProject.id ? mergedProject : entry))
    },
    newConflicts
  };
}
