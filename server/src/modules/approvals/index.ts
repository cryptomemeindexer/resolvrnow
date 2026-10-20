import type { AppModule } from '../../engine/module.js';

/** Approval engine (sysapproval_approver, group approvals, approval rules). */
export const approvalsModule: AppModule = {
  id: 'approvals',
  name: 'Approvals',
  description: 'Approval engine (sysapproval_approver, group approvals, approval rules).',
  dependsOn: ['task'],
};
