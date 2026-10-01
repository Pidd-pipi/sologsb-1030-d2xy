export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  version: number;
  updatedAt: string;
}

/** 租约：同一时刻只有持有租约的标签页可以写入。 */
export interface LeaseState {
  holderId: string;
  holderName: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

/** 两页并发修改同一检查项时记录的冲突，人工处理前不得提交复核或冻结。 */
export interface ItemConflict {
  id: string;
  itemId: string;
  itemLabel: string;
  detectedAt: string;
  /** 共同基线：获取租约/上次确认时的检查项。 */
  base: ChecklistItem | null;
  /** 本页尝试保存的版本；null 表示本页删除了该项。 */
  local: ChecklistItem | null;
  /** 对方已保存的版本。 */
  remote: ChecklistItem;
  resolved: boolean;
  resolution: 'local' | 'remote' | null;
}

export type ReachabilityStatus = 'ok' | 'stale' | 'issues';

/** 顺序变化后前置条件可达性的核算状态。 */
export interface ReachabilityState {
  status: ReachabilityStatus;
  /** 最近一次核算所对应的顺序版本（orderEpoch）。 */
  orderEpoch: number;
  issueIds: string[];
  computedAt: string | null;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
  /** 当前写入租约；null 表示租约空闲。 */
  lease: LeaseState | null;
  /** 并发保存时两页改同一项产生的冲突。 */
  conflicts: ItemConflict[];
  /** 顺序版本：检查项或阶段每调整一次顺序就 +1。 */
  orderEpoch: number;
  /** 前置条件可达性核算状态。 */
  reachability: ReachabilityState;
}

export interface WorkspaceState {
  schemaVersion: 1;
  selectedProjectId: string;
  projects: ChecklistProject[];
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}
